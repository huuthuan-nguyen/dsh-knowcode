import { watch } from 'chokidar';
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import { CodeParser } from '../parser/code-parser.js';
import { DocParser } from '../parser/doc-parser.js';
import { LinkEngine } from '../parser/link-engine.js';
export class CodeWatcher {
    options;
    watcher = null;
    hashes = new Map();
    pendingChanges = new Set();
    pendingDeletions = new Set();
    debounceTimer = null;
    linkEngine;
    constructor(options) {
        this.options = options;
        this.linkEngine = new LinkEngine(options.repo);
    }
    start() {
        if (this.watcher)
            return;
        const isIgnored = (path) => {
            const norm = path.replace(/\\/g, '/');
            return (norm.includes('/node_modules') ||
                norm.includes('/.git') ||
                norm.includes('/.knowcode') ||
                norm.includes('/dist') ||
                norm.includes('/lib') ||
                norm.includes('/build') ||
                norm.includes('/.next') ||
                norm.includes('/bin') ||
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
    }
    async stop() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
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
        // 1. Process deletions
        for (const relPath of deletions) {
            this.hashes.delete(relPath);
            await this.options.repo.deleteFile(relPath);
            await this.options.repo.deleteDoc(relPath);
            this.options.onUpdate?.('delete', relPath);
        }
        // 2. Process changes & additions
        let hasCodeUpdates = false;
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
                continue; // Unchanged content
            }
            this.hashes.set(relPath, hash);
            // Check if code file
            const codeParsed = CodeParser.parseFile(relPath, content);
            if (codeParsed) {
                await this.options.repo.ingestCodeFile(codeParsed);
                await this.options.repo.ingestImports(codeParsed.imports);
                await this.options.repo.ingestCalls(codeParsed.calls);
                await this.options.repo.ingestHeritage(codeParsed.heritage);
                hasCodeUpdates = true;
                this.options.onUpdate?.('update_code', relPath);
                continue;
            }
            // Check if doc file
            const docParsed = DocParser.parseDoc(relPath, content);
            if (docParsed) {
                await this.options.repo.ingestDocFile(docParsed);
                this.options.onUpdate?.('update_doc', relPath);
                continue;
            }
        }
        // Re-link relationships if code files changed
        if (hasCodeUpdates) {
            await this.linkEngine.linkAll();
        }
    }
}
