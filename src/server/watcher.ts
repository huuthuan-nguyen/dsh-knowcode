import { watch, type FSWatcher } from 'chokidar';
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import { CodeParser } from '../parser/code-parser.js';
import { DocParser } from '../parser/doc-parser.js';
import type { KnowCodeRepository } from '../db/client.js';
import { LinkEngine } from '../parser/link-engine.js';

export interface WatcherOptions {
  workdir: string;
  repo: KnowCodeRepository;
  onUpdate?: (event: string, path: string) => void;
  debounceMs?: number;
}

export class CodeWatcher {
  private watcher: FSWatcher | null = null;
  private hashes = new Map<string, string>();
  private pendingChanges = new Set<string>();
  private pendingDeletions = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private linkEngine: LinkEngine;

  constructor(private options: WatcherOptions) {
    this.linkEngine = new LinkEngine(options.repo);
  }

  public start(): void {
    if (this.watcher) return;

    const isIgnored = (path: string) => {
      const norm = path.replace(/\\/g, '/');
      return (
        norm.includes('/node_modules') ||
        norm.includes('/.git') ||
        norm.includes('/.knowcode') ||
        norm.includes('/dist') ||
        norm.includes('/lib') ||
        norm.includes('/build') ||
        norm.includes('/.next') ||
        norm.includes('/bin') ||
        norm.endsWith('.log')
      );
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

    this.watcher.on('add', (filePath: string) => this.queueChange(filePath));
    this.watcher.on('change', (filePath: string) => this.queueChange(filePath));
    this.watcher.on('unlink', (filePath: string) => this.queueDelete(filePath));
  }

  public async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private queueChange(filePath: string): void {
    const relPath = relative(this.options.workdir, filePath).replace(/\\/g, '/');
    this.pendingChanges.add(relPath);
    this.scheduleBatch();
  }

  private queueDelete(filePath: string): void {
    const relPath = relative(this.options.workdir, filePath).replace(/\\/g, '/');
    this.pendingDeletions.add(relPath);
    this.scheduleBatch();
  }

  private scheduleBatch(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.processBatch().catch((err) => {
        console.error('[KnowCode Watcher] Error during incremental reindex:', err);
      });
    }, this.options.debounceMs ?? 300);
  }

  private async processBatch(): Promise<void> {
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
      if (!existsSync(absPath)) continue;

      let content = '';
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
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
