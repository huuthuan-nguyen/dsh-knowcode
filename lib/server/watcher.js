import { watch } from 'chokidar';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import { CodeParser } from '../parser/code-parser.js';
import { DocParser } from '../parser/doc-parser.js';
import { LinkEngine } from '../parser/link-engine.js';
import { Tracer, fmtMs, nsToMs } from './trace.js';
/** Directory/filename fragments excluded from watching. */
const WATCH_IGNORE_FRAGMENTS = [
    '/node_modules',
    '/.git',
    '/.knowcode',
    '/dist',
    '/lib',
    '/build',
    '/.next',
    '/bin',
];
export class CodeWatcher {
    options;
    watcher = null;
    hashes = new Map();
    pendingChanges = new Set();
    pendingDeletions = new Set();
    debounceTimer = null;
    linkEngine;
    tracer;
    constructor(options) {
        this.options = options;
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
            return WATCH_IGNORE_FRAGMENTS.some((frag) => norm.includes(frag)) || norm.endsWith('.log');
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
            let content = '';
            try {
                content = readFileSync(absPath, 'utf8');
            }
            catch {
                continue;
            }
            const hash = createHash('sha256').update(content).digest('hex');
            if (this.hashes.get(relPath) === hash) {
                skipped++;
                continue; // Unchanged content
            }
            this.hashes.set(relPath, hash);
            const fileNs = process.hrtime.bigint();
            // Check if code file
            const codeParsed = CodeParser.parseFile(relPath, content);
            if (codeParsed) {
                codeParsed.mtimeMs = readMtimeMs(absPath);
                await this.options.repo.ingestCodeFile(codeParsed);
                await this.options.repo.ingestImports(codeParsed.imports);
                await this.options.repo.ingestCalls(codeParsed.calls);
                await this.options.repo.ingestHeritage(codeParsed.heritage);
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
/** Read a file's mtime in epoch milliseconds, or 0 when unavailable. */
function readMtimeMs(absPath) {
    try {
        return statSync(absPath).mtimeMs;
    }
    catch {
        return 0;
    }
}
