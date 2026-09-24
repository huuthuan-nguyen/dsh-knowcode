import { watch } from 'chokidar';
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import { CodeParser } from '../parser/code-parser.js';
import { TreeSitterEngine } from '../parser/tree-sitter.js';
import { DocParser } from '../parser/doc-parser.js';
import { StorageParser } from '../parser/storage-parser.js';
import { LinkEngine } from '../parser/link-engine.js';
import { Tracer, fmtMs, nsToMs } from './trace.js';
import { readMtimeMs } from './fs-mtime.js';
import { DEFAULT_MAX_FILE_SIZE, IGNORED_DIR_FRAGMENTS, decideIndexing, isIgnoredPath, } from './indexable.js';
/** Directory/filename fragments excluded from watching. */
/** Directory fragments never watched. Shared with indexing so the two agree. */
const WATCH_IGNORE_FRAGMENTS = IGNORED_DIR_FRAGMENTS;
export class CodeWatcher {
    options;
    watcher = null;
    hashes = new Map();
    pendingChanges = new Set();
    pendingDeletions = new Set();
    debounceTimer = null;
    linkEngine;
    tracer;
    ready = false;
    /** Largest file to read and index, in bytes. */
    maxFileSize;
    constructor(options) {
        this.options = options;
        this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
        this.linkEngine = new LinkEngine(options.repo);
        this.tracer = new Tracer({
            enabled: options.trace ?? false,
            sink: options.onTrace,
        }).child('watch');
    }
    start() {
        if (this.watcher)
            return;
        const isIgnored = (path) => {
            const norm = path.replace(/\\/g, '/');
            return (WATCH_IGNORE_FRAGMENTS.some((frag) => norm.includes(frag)) ||
                isIgnoredPath(norm) ||
                norm.endsWith('.log'));
        };
        this.watcher = watch(this.options.workdir, {
            ignored: isIgnored,
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: 200,
                pollInterval: 100,
            },
        });
        this.watcher.on('add', (filePath) => this.queueChange(filePath));
        this.watcher.on('change', (filePath) => this.queueChange(filePath));
        this.watcher.on('unlink', (filePath) => this.queueDelete(filePath));
        this.tracer.line(`ignore matcher ready (${WATCH_IGNORE_FRAGMENTS.map((f) => f.slice(1)).join(', ')})`);
        this.tracer.line(`worker started (workspace=${this.options.workdir}, engine=chokidar, ` +
            `awaitWriteFinish=200ms, debounce=${this.options.debounceMs ?? 300}ms)`);
        // chokidar reports initial scan completion here. Until this fires, a file
        // created in the workspace can be swallowed as part of the initial scan
        // (`ignoreInitial: true`), so callers that need to be sure a change will be
        // observed — `serve` startup, tests — should wait for it.
        this.watcher.on('ready', () => {
            this.ready = true;
            this.tracer.line('ready (initial scan complete)');
            this.options.onReady?.();
        });
    }
    /** Whether chokidar finished its initial scan and is delivering events. */
    isReady() {
        return this.ready;
    }
    /**
     * Resolve once the watcher is delivering events.
     *
     * @param timeoutMs - give up after this long, returning false.
     * @returns whether the watcher became ready.
     */
    async waitUntilReady(timeoutMs = 10_000) {
        if (this.ready)
            return true;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
            if (this.ready)
                return true;
        }
        return this.ready;
    }
    async stop() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
            this.tracer.line('worker stopped');
        }
    }
    queueChange(filePath) {
        const relPath = relative(this.options.workdir, filePath).replace(/\\/g, '/');
        this.pendingChanges.add(relPath);
        this.scheduleBatch();
    }
    queueDelete(filePath) {
        const relPath = relative(this.options.workdir, filePath).replace(/\\/g, '/');
        this.pendingDeletions.add(relPath);
        this.scheduleBatch();
    }
    scheduleBatch() {
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.processBatch().catch((err) => {
                console.error('[KnowCode Watcher] Error during incremental reindex:', err);
            });
        }, this.options.debounceMs ?? 300);
    }
    async processBatch() {
        const changes = Array.from(this.pendingChanges);
        const deletions = Array.from(this.pendingDeletions);
        this.pendingChanges.clear();
        this.pendingDeletions.clear();
        const batchNs = process.hrtime.bigint();
        const tracing = this.tracer.enabled;
        if (tracing) {
            this.tracer.line(`batch ${changes.length} change(s), ${deletions.length} deletion(s)`);
        }
        // 1. Process deletions
        for (const relPath of deletions) {
            this.hashes.delete(relPath);
            await this.options.repo.deleteFile(relPath);
            await this.options.repo.deleteDoc(relPath);
            await this.options.repo.deleteSchemaDefinitions(relPath);
            this.options.onUpdate?.('delete', relPath);
            if (tracing)
                this.tracer.line(`unlink ${relPath}`);
        }
        // 2. Process changes & additions
        let hasCodeUpdates = false;
        let reindexed = 0;
        let skipped = 0;
        for (const relPath of changes) {
            const absPath = `${this.options.workdir}/${relPath}`;
            if (!existsSync(absPath))
                continue;
            // Decide from the path and its size BEFORE reading: a database file being
            // written by a running application was previously read in full on every
            // change only to be discarded, and an oversized file was never skipped.
            const decision = decideIndexing(absPath, this.maxFileSize, relPath);
            if (!decision.ok) {
                skipped++;
                if (tracing && decision.reason === 'too-large') {
                    this.tracer.line(`skip ${relPath} (${decision.size} bytes > maxFileSize ${this.maxFileSize})`);
                }
                continue;
            }
            let content = '';
            try {
                content = readFileSync(absPath, 'utf8');
            }
            catch {
                continue;
            }
            // A parse failure on one changed file must not abort the batch, or the watcher
            // stops reporting and the graph silently drifts from the workspace.
            try {
                const hash = createHash('sha256').update(content).digest('hex');
                if (this.hashes.get(relPath) === hash) {
                    skipped++;
                    continue; // Unchanged content
                }
                this.hashes.set(relPath, hash);
                const fileNs = process.hrtime.bigint();
                // Check if code file
                const lang = CodeParser.detectLanguage(relPath);
                if (lang)
                    await TreeSitterEngine.ensureLanguage(lang);
                const codeParsed = CodeParser.parseFile(relPath, content);
                if (codeParsed) {
                    codeParsed.mtimeMs = readMtimeMs(absPath);
                    await this.options.repo.ingestCodeFile(codeParsed);
                    await this.options.repo.ingestImports(codeParsed.imports);
                    await this.options.repo.ingestCalls(codeParsed.calls);
                    await this.options.repo.ingestHeritage(codeParsed.heritage);
                    // ORM models declared in the file (Mongoose) are schema, not code. Only a file
                    // that imports an ORM can declare one — the parser scans raw content, so a
                    // fixture string containing a schema would otherwise be ingested as a model.
                    const usesOrm = codeParsed.imports.some((imp) => /mongoose|mongodb|sequelize|typeorm|prisma/i.test(imp.importedPath));
                    const codeSchema = usesOrm ? StorageParser.parseMongoSchema(relPath, content) : [];
                    if (codeSchema.length > 0) {
                        await this.options.repo.deleteSchemaDefinitions(relPath);
                        for (const container of codeSchema)
                            await this.options.repo.ingestStorageContainer(container);
                    }
                    hasCodeUpdates = true;
                    reindexed++;
                    this.options.onUpdate?.('update_code', relPath);
                    if (tracing) {
                        this.tracer.line(`update ${relPath} in ${fmtMs(process.hrtime.bigint() - fileNs)} (symbols=${codeParsed.symbols.length})`);
                    }
                    continue;
                }
                // Check if doc file
                const docParsed = DocParser.parseDoc(relPath, content);
                if (docParsed) {
                    await this.options.repo.ingestDocFile(docParsed);
                    reindexed++;
                    this.options.onUpdate?.('update_doc', relPath);
                    if (tracing) {
                        this.tracer.line(`update ${relPath} in ${fmtMs(process.hrtime.bigint() - fileNs)} (doc)`);
                    }
                    continue;
                }
                // Schema / DDL edits. Only repository text reaches here — a database file is
                // rejected by `decideIndexing` before content is read.
                const schema = StorageParser.parseSchemaFile(relPath, content);
                if (schema.entities.length > 0 || schema.containers.length > 0) {
                    await this.options.repo.deleteSchemaDefinitions(relPath);
                    for (const entity of schema.entities)
                        await this.options.repo.ingestContractEntity(entity);
                    for (const container of schema.containers)
                        await this.options.repo.ingestStorageContainer(container);
                    reindexed++;
                    this.options.onUpdate?.('update_schema', relPath);
                    if (tracing) {
                        this.tracer.line(`update ${relPath} in ${fmtMs(process.hrtime.bigint() - fileNs)} ` +
                            `(schema: ${schema.entities.length} entity(ies), ${schema.containers.length} container(s))`);
                    }
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[KnowCode Watcher] Skipping ${relPath}: ${message}`);
                if (tracing)
                    this.tracer.line(`parse failed for ${relPath}: ${message}`);
            }
        }
        // Re-link relationships if code files changed
        let relinkMs = 0;
        if (hasCodeUpdates) {
            const relNs = process.hrtime.bigint();
            await this.linkEngine.linkAll();
            relinkMs = nsToMs(process.hrtime.bigint() - relNs);
        }
        if (tracing && (reindexed > 0 || deletions.length > 0)) {
            this.tracer.line(`incremental reindex complete: ${reindexed} file(s) in ${fmtMs(process.hrtime.bigint() - batchNs)} ` +
                `(relink=${fmtMs(relinkMs)}, skipped=${skipped}, removed=${deletions.length})`);
        }
    }
}
