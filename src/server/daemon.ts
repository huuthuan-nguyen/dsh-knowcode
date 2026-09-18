import http from 'node:http';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import fg from 'fast-glob';
import { FalkorDBManager, FalkorInstance } from '../db/falkor-manager.js';
import { initGraphSchema } from '../db/schema.js';
import { KnowCodeRepository } from '../db/client.js';
import { CodeParser } from '../parser/code-parser.js';
import { DocParser } from '../parser/doc-parser.js';
import { StorageParser } from '../parser/storage-parser.js';
import { LinkEngine } from '../parser/link-engine.js';
import { CodeWatcher } from './watcher.js';
import { Tracer, type TraceSink, fmtMs, nsToMs } from './trace.js';
import { readMtimeMs } from './fs-mtime.js';
import {
  acquireServeLock,
  releaseServeLock,
  DaemonAlreadyRunningError,
} from './serve-lock.js';
import {
  INDEXABLE_GLOB,
  IGNORE_GLOBS,
  SCHEMA_GLOB,
  DEFAULT_MAX_FILE_SIZE,
  decideIndexing,
} from './indexable.js';
import type { KnowCodeStats } from '../types.js';

/**
 * File glob and directory ignores considered indexable.
 *
 * Sourced from `./indexable.js` so discovery, the stale check and the file watcher
 * cannot drift apart.
 */
const STORAGE_FILE_PATTERN = INDEXABLE_GLOB;
const INDEX_IGNORE_GLOBS = IGNORE_GLOBS;

/**
 * Delete leftover Redis background-save temp files.
 *
 * Redis writes `temp-<pid>.rdb` during a save and renames it on success, so an
 * interrupted save leaves a file beside the real one that nothing ever removes —
 * the workspace should hold exactly one `.rdb`.
 */
function removeStrayRdbTemps(dataDir: string): void {
  try {
    for (const entry of readdirSync(dataDir)) {
      if (/^temp-.*\.rdb$/.test(entry)) {
        try {
          unlinkSync(join(dataDir, entry));
        } catch {
          /* in use or already gone */
        }
      }
    }
  } catch {
    /* data directory unreadable: nothing to clean */
  }
}

/** Outcome of the startup reconcile. */
export interface ReconcileSummary {
  mode: 'forced' | 'stale' | 'up-to-date' | 'fallback';
  checked?: number;
  added?: number;
  changed?: number;
  deleted?: number;
  filesIndexed: number;
  symbolsIndexed: number;
  timeMs: number;
}

/** Result of an indexing pass. */
export interface IndexSummary {
  filesIndexed: number;
  symbolsIndexed: number;
  docsIndexed: number;
  /** Contract entities and storage containers ingested from repository schema files. */
  schemaDefinitions?: number;
  timeMs: number;
}

export interface DaemonOptions {
  workdir: string;
  port?: number;
  dataDir?: string;
  falkordbUrl?: string;
  /**
   * Largest file to read and index, in bytes.
   *
   * Enforced before any read; the option was previously documented and resolved
   * but never consulted, so a multi-megabyte file was always read in full.
   */
  maxFileSize?: number;
  /**
   * Stop the daemon after this many milliseconds without activity. `0` disables it.
   * A daemon is spawned per workspace on first use, so a long session that touches
   * many workspaces would otherwise keep one running for each of them.
   */
  idleTimeoutMs?: number;
  onLog?: (msg: string) => void;
  /** Enable Microsoft `tgrep`-style `[trace]` output. */
  trace?: boolean;
  /** Destination for trace lines. Defaults to stderr when `trace` is true. */
  onTrace?: TraceSink;
}

export class KnowCodeDaemon {
  private server: http.Server | null = null;
  private falkorManager: FalkorDBManager;
  private falkorInstance: FalkorInstance | null = null;
  private repo: KnowCodeRepository | null = null;
  private watcher: CodeWatcher | null = null;
  private isIndexing: boolean = false;
  /**
   * The run in flight, so a second caller shares it instead of failing.
   *
   * `/index` used to answer 500 `Indexing already in progress.` when invoked while
   * the daemon was still reconciling at startup, which surfaced to the agent as
   * `[KnowCode Error: …]` from the `sync` tool.
   */
  private indexingPromise: Promise<unknown> | null = null;
  /** Last time the daemon did anything, for the idle timeout. */
  private lastActivityAt: number = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  /** Summary of the last startup reconcile, for callers that share an in-flight run. */
  private lastReconcile: ReconcileSummary | null = null;
  private lastIndexedAt: string | null = null;
  private tracer: Tracer;
  /** Data directory of the running instance, for releasing the workspace guard. */
  private dataDir: string | null = null;
  /** Largest file to read and index, in bytes. */
  private readonly maxFileSize: number;

  constructor(private options: DaemonOptions) {
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.falkorManager = new FalkorDBManager();
    this.tracer = new Tracer({
      enabled: options.trace ?? false,
      sink: options.onTrace,
    });
  }

  /** Expose the tracer so CLI callers can emit their own spans. */
  public getTracer(): Tracer {
    return this.tracer;
  }

  /**
   * Wait until the file watcher is delivering events.
   *
   * A file created after the startup stale check but before chokidar finishes its
   * initial scan could otherwise be missed by both. `serve` waits here before
   * reconciling, so that window does not exist.
   *
   * @param timeoutMs - give up after this long.
   * @returns whether the watcher became ready (false when disabled or timed out).
   */
  public async waitForWatcherReady(timeoutMs = 10_000): Promise<boolean> {
    if (!this.watcher) return false;
    return await this.watcher.waitUntilReady(timeoutMs);
  }

  /**
   * Bind the HTTP server, falling back to the next free port when the requested
   * one is already held.
   *
   * Every workspace requests port 48123 by default, so without this a second
   * `knowcode serve` died with `EADDRINUSE`. The port that actually got bound is
   * written to `<dataDir>/daemon.json`, which is how clients of each workspace
   * find their own daemon.
   *
   * @param requestedPort - the preferred loopback port.
   * @returns the port the server is actually listening on.
   */
  private async listenOnAvailablePort(requestedPort: number): Promise<number> {
    const listen = (port: number): Promise<void> =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        const server = http.createServer(async (req, res) => {
          try {
            await this.handleRequest(req, res);
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err?.message ?? String(err) }));
          }
        });
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListening);
          server.close(() => {});
          rejectPromise(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          this.server = server;
          resolvePromise();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });

    try {
      await listen(requestedPort);
      return requestedPort;
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE') throw err;

      const fallbackPort = await FalkorDBManager.findOpenPort(requestedPort + 1);
      await listen(fallbackPort);
      this.log(
        `Port ${requestedPort} is in use (another workspace's daemon?); listening on ${fallbackPort} instead.`
      );
      this.tracer.line(`port: ${requestedPort} busy, fell back to ${fallbackPort}`);
      return fallbackPort;
    }
  }

  public async start(startOpts?: { withWatcher?: boolean }): Promise<{ port: number; pid: number }> {
    try {
      return await this.startInner(startOpts);
    } catch (err) {
      // Never leak the embedded FalkorDB child process (or the HTTP socket) when
      // startup fails part-way — for example when the requested port is taken.
      await this.stop().catch(() => {});
      throw err;
    }
  }

  private async startInner(startOpts?: { withWatcher?: boolean }): Promise<{ port: number; pid: number }> {
    const startupNs = process.hrtime.bigint();
    const workdir = resolve(this.options.workdir);
    const dataDir = join(workdir, this.options.dataDir ?? '.knowcode');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const requestedPort = this.options.port ?? 48123;

    // One daemon per workspace. Two would each run a watcher and an embedded
    // FalkorDB over the same `.rdb`, and the second would overwrite `daemon.json`
    // so clients flip between them. Claimed before anything is started, with an
    // exclusive create so simultaneous starts cannot both win.
    const lock = acquireServeLock(dataDir, workdir, requestedPort);
    if (!lock.acquired) {
      throw new DaemonAlreadyRunningError(lock.existing ?? null, workdir);
    }
    this.dataDir = dataDir;

    this.log(`Starting FalkorDB embedded database in ${dataDir}...`);
    const openSpan = this.tracer.span(`db: embedded FalkorDB opened (dir=${dataDir})`);

    // Leave exactly one database file behind: a background save interrupted by a
    // kill leaves a `temp-*.rdb` beside the real one, and nothing ever removes it.
    removeStrayRdbTemps(dataDir);

    this.falkorInstance = await this.falkorManager.start({
      dataDir,
      customUrl: this.options.falkordbUrl,
      preferredPort: requestedPort + 10,
    });
    openSpan.end();

    const graph = this.falkorInstance.client.selectGraph('knowcode');
    await this.tracer.step('schema: indexes ensured', () => initGraphSchema(graph));
    this.repo = new KnowCodeRepository(graph);

    // Report the graph contents now loaded into the embedded engine.
    if (this.tracer.enabled) {
      const opened = await this.repo.getStats();
      this.tracer.line(
        `opened index: ${opened.totalFiles} files, ${opened.totalSymbols} symbols, ${opened.totalCalls} calls, ${opened.totalDocs} docs`
      );
    }

    // Start HTTP daemon server. The port is a best-effort request: another
    // workspace's daemon may already hold it, and the actual port is recorded in
    // daemon.json so clients always find this daemon.
    const daemonPort = await this.listenOnAvailablePort(requestedPort);

    // Write daemon info file
    const daemonInfoPath = join(dataDir, 'daemon.json');
    writeFileSync(
      daemonInfoPath,
      JSON.stringify(
        {
          pid: process.pid,
          port: daemonPort,
          workdir,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    this.log(`KnowCode daemon server listening on http://127.0.0.1:${daemonPort}`);

    if (this.tracer.enabled) {
      const stats = await this.repo.getStats();
      this.tracer.line(
        `serve ready in ${fmtMs(process.hrtime.bigint() - startupNs)}. ` +
          `HTTP on port ${daemonPort}. ` +
          `Graph: ${stats.totalSymbols} symbols / ${stats.totalCalls} calls / ${stats.totalDocs} docs / ${stats.totalSections} sections. ` +
          `Data dir: ${dataDir}.`
      );
    }

    // Start the background watcher after the server is accepting connections,
    // so `serve ready` lands before the watcher/refresh traces (tgrep ordering).
    if (startOpts?.withWatcher !== false) {
      const debounceMs = 300;
      this.tracer.line(`refresh mode: auto, debounce=${debounceMs}ms, awaitWriteFinish=200ms`);
      this.watcher = new CodeWatcher({
        workdir,
        repo: this.repo,
        debounceMs,
        onTrace: this.options.onTrace,
        trace: this.tracer.enabled,
        onUpdate: (evt, path) => {
          this.touch();
          this.log(`[Watcher] ${evt}: ${path}`);
        },
      });
      this.watcher.start();
      this.log('File watcher active on workspace.');
    }

    // Clean exit handlers
    const shutdown = () => this.stop().catch(() => {});
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    this.startIdleTimer();

    return { port: daemonPort, pid: process.pid };
  }

  public async stop(): Promise<void> {
    this.log('Stopping KnowCode daemon...');

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }

    if (this.server) {
      await new Promise<void>((res) => this.server!.close(() => res()));
      this.server = null;
    }

    if (this.falkorManager) {
      await this.falkorManager.stop();
      this.falkorInstance = null;
    }

    const dataDir = join(this.options.workdir, this.options.dataDir ?? '.knowcode');
    const daemonInfoPath = join(dataDir, 'daemon.json');
    if (existsSync(daemonInfoPath)) {
      try {
        unlinkSync(daemonInfoPath);
      } catch {}
    }

    // Release the single-instance guard so this workspace can be served again.
    // Only a guard still naming this process is removed, so a guard already
    // reclaimed by another daemon is left alone.
    releaseServeLock(this.dataDir ?? dataDir);
    this.dataDir = null;

    this.log('KnowCode daemon stopped cleanly.');
  }

  /** Record that the daemon did something, resetting the idle timeout. */
  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * Start the idle timer when a budget is configured.
   *
   * A daemon is spawned per workspace on first use and otherwise lives until the
   * harness exits, so a long session that touches many workspaces accumulates one
   * daemon, watcher and embedded database each. With a budget, an unused workspace
   * lets its daemon go.
   */
  private startIdleTimer(): void {
    const budget = this.options.idleTimeoutMs ?? 0;
    if (budget <= 0 || this.idleTimer) return;

    const interval = Math.min(30_000, Math.max(1_000, Math.floor(budget / 2)));
    this.idleTimer = setInterval(() => {
      // Never stop mid-index: the run is real work, not idleness.
      if (this.isIndexing) return;
      if (Date.now() - this.lastActivityAt < budget) return;

      this.log(`Idle for ${Math.round((Date.now() - this.lastActivityAt) / 1000)}s — stopping daemon.`);
      this.tracer.line(`idle timeout: no activity for ${Math.round(budget / 1000)}s`);
      void this.stop();
    }, interval);

    // The timer must not keep the process alive on its own.
    this.idleTimer.unref?.();
  }

  /**
   * Reconcile the graph with the filesystem at startup, as one reported unit.
   *
   * This is the sequence `serve` runs between binding its port and announcing
   * readiness. It owns the indexing flag for the whole span, so `/status` can report
   * `indexing` and a concurrent `sync` shares the run instead of starting a second
   * reconcile — and so a client that has just started the daemon knows when the
   * graph is safe to query.
   *
   * @param opts.forceIndex - skip the stale check and re-parse everything.
   */
  public async reconcileStartup(opts: { forceIndex?: boolean } = {}): Promise<ReconcileSummary> {
    if (this.indexingPromise) {
      await this.indexingPromise;
      if (this.lastReconcile) return this.lastReconcile;
    }

    let summary: ReconcileSummary = { mode: 'up-to-date', filesIndexed: 0, symbolsIndexed: 0, timeMs: 0 };

    const run = this.runIndexing(async () => {
      const startNs = process.hrtime.bigint();

      const watcherReady = await this.waitForWatcherReady();
      if (!watcherReady) this.tracer.line('watcher did not report ready; reconciling anyway');

      if (opts.forceIndex) {
        this.tracer.line('index mode: forced full re-index (--force-index)');
        this.log('Performing full index (forced)...');
        const res = await this.performFullIndexUnlocked();
        summary = {
          mode: 'forced',
          filesIndexed: res.filesIndexed,
          symbolsIndexed: res.symbolsIndexed,
          timeMs: res.timeMs,
        };
        return summary;
      }

      try {
        const stale = await this.staleCheck();
        const total = stale.added.length + stale.changed.length + stale.deleted.length;

        if (total === 0) {
          this.log(`Index is up-to-date (${stale.checked} files checked).`);
          summary = {
            mode: 'up-to-date',
            checked: stale.checked,
            added: 0,
            changed: 0,
            deleted: 0,
            filesIndexed: 0,
            symbolsIndexed: 0,
            timeMs: nsToMs(process.hrtime.bigint() - startNs),
          };
          return summary;
        }

        this.log(
          `Index stale: ${stale.added.length} added, ${stale.changed.length} changed, ` +
            `${stale.deleted.length} deleted. Re-indexing...`
        );
        const res = await this.reindexPaths([...stale.added, ...stale.changed], stale.deleted);
        summary = {
          mode: 'stale',
          checked: stale.checked,
          added: stale.added.length,
          changed: stale.changed.length,
          deleted: stale.deleted.length,
          filesIndexed: res.updated,
          symbolsIndexed: 0,
          timeMs: nsToMs(process.hrtime.bigint() - startNs),
        };
        return summary;
      } catch (err: any) {
        // Never leave the graph unindexed because of a stale-check failure.
        this.tracer.line(`stale check failed: ${err?.message ?? String(err)} — falling back to full index`);
        this.log('Stale check failed; performing full index...');
        const res = await this.performFullIndexUnlocked();
        summary = {
          mode: 'fallback',
          filesIndexed: res.filesIndexed,
          symbolsIndexed: res.symbolsIndexed,
          timeMs: res.timeMs,
        };
        return summary;
      }
    });

    this.indexingPromise = run;
    try {
      await run;
    } finally {
      this.indexingPromise = null;
      this.lastReconcile = summary;
    }
    return summary;
  }

  /**
   * Perform full indexing pass on the workspace
   */
  public async performFullIndex(targetPath?: string): Promise<IndexSummary> {
    // Share the run already in flight rather than refusing: a `sync` issued while the
    // daemon reconciles at startup should receive that run's result.
    if (this.indexingPromise) return (await this.indexingPromise) as IndexSummary;

    const run = this.runIndexing(() => this.performFullIndexUnlocked(targetPath));
    this.indexingPromise = run;
    try {
      return await run;
    } finally {
      this.indexingPromise = null;
    }
  }

  /**
   * Serialize an indexing pass and keep the observable state consistent.
   *
   * `isIndexing` was previously set only here and in `performFullIndex`, so
   * `staleCheck`/`reindexPaths` ran unreported: `/status` could not say a reconcile
   * was in progress, and a `sync` arriving mid-reconcile started a second one.
   */
  private async runIndexing<T>(task: () => Promise<T>): Promise<T> {
    this.isIndexing = true;
    try {
      return await task();
    } finally {
      this.isIndexing = false;
      this.lastIndexedAt = new Date().toISOString();
      this.touch();
    }
  }

  private async performFullIndexUnlocked(targetPath?: string): Promise<IndexSummary> {
    const startTime = Date.now();
    const indexNs = process.hrtime.bigint();

    try {
      const rootDir = resolve(targetPath ?? this.options.workdir);
      this.log(`Beginning indexing scan of ${rootDir}...`);

      const scanNs = process.hrtime.bigint();
      const entries = await this.discoverFiles(rootDir);
      const scanMs = nsToMs(process.hrtime.bigint() - scanNs);

      this.log(`Found ${entries.length} candidate files.`);

      let codeCount = 0;
      let docCount = 0;
      let totalSymbols = 0;
      let totalCalls = 0;
      let schemaCount = 0;
      let parseNs = 0n;

      const allImports: any[] = [];
      const allCalls: any[] = [];
      const allHeritage: any[] = [];

      const parseStartNs = process.hrtime.bigint();
      for (const relPath of entries) {
        const absPath = join(rootDir, relPath);
        const decision = decideIndexing(absPath, this.maxFileSize, relPath);
        if (!decision.ok) {
          if (decision.reason === 'too-large') {
            this.log(`Skipping ${relPath}: ${decision.size} bytes exceeds maxFileSize (${this.maxFileSize}).`);
          }
          continue;
        }
        let content = '';
        try {
          content = readFileSync(absPath, 'utf8');
        } catch {
          continue;
        }

        // Check if code file
        const parsedCode = CodeParser.parseFile(relPath, content);
        if (parsedCode) {
          parsedCode.mtimeMs = readMtimeMs(absPath);
          await this.repo!.ingestCodeFile(parsedCode);
          codeCount++;
          totalSymbols += parsedCode.symbols.length;
          totalCalls += parsedCode.calls.length;
          allImports.push(...parsedCode.imports);
          allCalls.push(...parsedCode.calls);
          allHeritage.push(...parsedCode.heritage);
          // ORM models declared in code — a Mongoose schema in a `.ts` model file is
          // the most common "schema in source" there is — are collected here because
          // a code file returns before the schema branch below.
          schemaCount += await this.ingestCodeSchema(relPath, content);
          continue;
        }

        // Check if doc file
        const parsedDoc = DocParser.parseDoc(relPath, content);
        if (parsedDoc) {
          await this.repo!.ingestDocFile(parsedDoc);
          docCount++;
          continue;
        }

        // Schema / DDL held in the repository. The live database is never read: only
        // text files that are already in scope reach this point.
        schemaCount += await this.ingestSchemaContent(relPath, content);
      }
      parseNs = process.hrtime.bigint() - parseStartNs;

      // Ingest cross-file relationships
      this.log(`Ingesting relationships: ${allImports.length} imports, ${allCalls.length} calls...`);
      const relNs = process.hrtime.bigint();
      await this.repo!.ingestImports(allImports);
      await this.repo!.ingestCalls(allCalls);
      await this.repo!.ingestHeritage(allHeritage);

      // Run link engine passes
      const linker = new LinkEngine(this.repo!);
      await linker.linkAll();
      const relMs = nsToMs(process.hrtime.bigint() - relNs);

      this.lastIndexedAt = new Date().toISOString();
      const elapsed = Date.now() - startTime;
      this.log(`Indexing complete in ${elapsed}ms: ${codeCount} code files, ${docCount} docs, ${totalSymbols} symbols.`);

      this.tracer.line(
        `index: scan=${fmtMs(scanMs)} parse+ingest=${fmtMs(parseNs)} relink=${fmtMs(relMs)} ` +
          `(code=${codeCount} docs=${docCount} symbols=${totalSymbols} calls=${totalCalls} total=${fmtMs(process.hrtime.bigint() - indexNs)})`
      );

      return {
        filesIndexed: codeCount + docCount,
        symbolsIndexed: totalSymbols,
        docsIndexed: docCount,
        schemaDefinitions: schemaCount,
        timeMs: elapsed,
      };
    } finally {
      // The flag and timestamps are owned by `runIndexing`.
    }
  }

  /**
   * Ingest schema definitions declared inside a source file.
   *
   * Only textual model declarations are read — a Mongoose schema, or any future ORM
   * mapping. Nothing here opens or contacts a database.
   */
  private async ingestCodeSchema(relPath: string, content: string): Promise<number> {
    const containers = StorageParser.parseMongoSchema(relPath, content);
    if (containers.length === 0) return 0;

    await this.repo!.deleteSchemaDefinitions(relPath);
    for (const container of containers) {
      await this.repo!.ingestStorageContainer(container);
    }
    this.log(`Schema ${relPath}: ${containers.length} ORM model(s).`);
    return containers.length;
  }

  private async ingestSchemaContent(relPath: string, content: string): Promise<number> {
    const { entities, containers } = StorageParser.parseSchemaFile(relPath, content);

    // Replace this file's definitions: a model removed from the schema must not
    // survive a re-index.
    await this.repo!.deleteSchemaDefinitions(relPath);

    for (const entity of entities) {
      await this.repo!.ingestContractEntity(entity);
    }
    for (const container of containers) {
      await this.repo!.ingestStorageContainer(container);
    }

    if (entities.length + containers.length > 0) {
      this.log(
        `Schema ${relPath}: ${entities.length} contract entity(ies), ${containers.length} storage container(s).`
      );
    }
    return entities.length + containers.length;
  }

  /**
   * Discover indexable files. Shared by full indexing and the stale check so the
   * two always agree on exactly which files are in scope.
   */
  private async discoverFiles(rootDir: string): Promise<string[]> {
    return await fg([STORAGE_FILE_PATTERN, SCHEMA_GLOB], {
      cwd: rootDir,
      ignore: [...INDEX_IGNORE_GLOBS],
      dot: false,
    });
  }

  /**
   * Compare the graph against the filesystem without re-parsing everything.
   *
   * Uses `mtimeMs` as a cheap first pass and only falls back to hashing a file
   * whose mtime moved, so a no-op run never reads file contents.
   */
  public async staleCheck(targetPath?: string): Promise<{
    added: string[];
    changed: string[];
    deleted: string[];
    checked: number;
    timeMs: number;
  }> {
    if (!this.repo) throw new Error('Repository not initialized');

    const startNs = process.hrtime.bigint();
    const rootDir = resolve(targetPath ?? this.options.workdir);

    this.tracer.line('stale check: comparing index against filesystem...');

    const walkNs = process.hrtime.bigint();
    const onDisk = await this.discoverFiles(rootDir);
    const ignoreNs = process.hrtime.bigint() - walkNs;
    this.tracer.line(
      `ignore matcher built from stale walk in ${fmtMs(ignoreNs)} (${onDisk.length} candidate files)`
    );

    const indexedRes = await this.repo.query(
      `MATCH (f:File) RETURN f.path AS path, f.hash AS hash, f.mtimeMs AS mtimeMs`
    );
    const indexed = new Map<string, { hash: string; mtimeMs: number }>();
    for (const row of (indexedRes.data ?? []) as any[]) {
      indexed.set(row.path, { hash: row.hash ?? '', mtimeMs: Number(row.mtimeMs ?? 0) });
    }

    const diskSet = new Set(onDisk);
    const added: string[] = [];
    const changed: string[] = [];

    for (const relPath of onDisk) {
      const record = indexed.get(relPath);
      if (!record) {
        added.push(relPath);
        continue;
      }

      const absPath = join(rootDir, relPath);
      const diskMtime = readMtimeMs(absPath);

      // Fast path: unchanged mtime means unchanged content.
      if (record.mtimeMs && diskMtime && record.mtimeMs === diskMtime) {
        continue;
      }

      const decision = decideIndexing(absPath, this.maxFileSize, relPath);
      if (!decision.ok) {
        if (decision.reason === 'too-large') {
          this.log(`Skipping ${relPath}: ${decision.size} bytes exceeds maxFileSize (${this.maxFileSize}).`);
        }
        continue;
      }
      // mtime moved (or was never recorded) — confirm by hashing before reindexing.
      let content = '';
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }
      const hash = createHash('sha256').update(content).digest('hex');
      if (hash !== record.hash) {
        changed.push(relPath);
      }
    }

    const deleted: string[] = [];
    for (const path of indexed.keys()) {
      if (!diskSet.has(path)) deleted.push(path);
    }

    const timeMs = nsToMs(process.hrtime.bigint() - startNs);

    if (added.length === 0 && changed.length === 0 && deleted.length === 0) {
      this.tracer.line(`stale check: index is up-to-date (${onDisk.length} files checked in ${fmtMs(timeMs)})`);
    } else {
      this.tracer.line(
        `stale check: ${added.length} added / ${changed.length} changed / ${deleted.length} deleted ` +
          `(${onDisk.length} files checked in ${fmtMs(timeMs)})`
      );
      for (const p of [...added, ...changed, ...deleted].slice(0, 50)) {
        this.tracer.line(`stale: ${p}`);
      }
    }

    return { added, changed, deleted, checked: onDisk.length, timeMs };
  }

  /**
   * Incrementally reconcile the graph with a known set of changed paths.
   * Used by `serve` startup so an unchanged workspace costs no re-parsing.
   */
  public async reindexPaths(
    changed: string[],
    deleted: string[] = [],
    targetPath?: string
  ): Promise<{ updated: number; removed: number }> {
    if (!this.repo) throw new Error('Repository not initialized');
    if (changed.length === 0 && deleted.length === 0) return { updated: 0, removed: 0 };

    const rootDir = resolve(targetPath ?? this.options.workdir);
    const startNs = process.hrtime.bigint();

    for (const relPath of deleted) {
      await this.repo.deleteFile(relPath);
      await this.repo.deleteDoc(relPath);
      await this.repo.deleteSchemaDefinitions(relPath);
    }

    let updated = 0;
    const allImports: any[] = [];
    const allCalls: any[] = [];
    const allHeritage: any[] = [];
    let sawCode = false;

    for (const relPath of changed) {
      const absPath = join(rootDir, relPath);
      const decision = decideIndexing(absPath, this.maxFileSize, relPath);
      if (!decision.ok) {
        if (decision.reason === 'too-large') {
          this.log(`Skipping ${relPath}: ${decision.size} bytes exceeds maxFileSize (${this.maxFileSize}).`);
        }
        continue;
      }
      let content = '';
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }

      const parsedCode = CodeParser.parseFile(relPath, content);
      if (parsedCode) {
        parsedCode.mtimeMs = readMtimeMs(absPath);
        await this.repo.ingestCodeFile(parsedCode);
        allImports.push(...parsedCode.imports);
        allCalls.push(...parsedCode.calls);
        allHeritage.push(...parsedCode.heritage);
        await this.ingestCodeSchema(relPath, content);
        sawCode = true;
        updated++;
        continue;
      }

      const parsedDoc = DocParser.parseDoc(relPath, content);
      if (parsedDoc) {
        await this.repo.ingestDocFile(parsedDoc);
        updated++;
        continue;
      }

      updated += (await this.ingestSchemaContent(relPath, content)) > 0 ? 1 : 0;
    }

    if (sawCode) {
      await this.repo.ingestImports(allImports);
      await this.repo.ingestCalls(allCalls);
      await this.repo.ingestHeritage(allHeritage);
      await new LinkEngine(this.repo).linkAll();
    }

    this.lastIndexedAt = new Date().toISOString();
    this.tracer.line(
      `reindex: ${updated} file(s) refreshed, ${deleted.length} removed in ${fmtMs(process.hrtime.bigint() - startNs)}`
    );

    return { updated, removed: deleted.length };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Any client contact counts as activity, so an idle timer only fires when nothing
    // is asking this daemon for anything.
    this.touch();

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method?.toUpperCase();

    // Helper for JSON reply
    const sendJson = (data: any, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(data));
    };

    // Helper to read body
    const readBody = async (): Promise<any> => {
      return new Promise((resolveBody, rejectBody) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            resolveBody(body ? JSON.parse(body) : {});
          } catch (e) {
            rejectBody(e);
          }
        });
        req.on('error', rejectBody);
      });
    };

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (url.pathname === '/status' && method === 'GET') {
      const dbStats = await this.repo?.getStats();
      const stats: KnowCodeStats = {
        daemonRunning: true,
        daemonPid: process.pid,
        port: (this.server?.address() as any)?.port,
        // Identity of the workspace this daemon serves. Clients compare it
        // against their own workdir so a daemon belonging to another project
        // can never answer for this one.
        workdir: resolve(this.options.workdir),
        dbPath: this.falkorInstance?.dbPath ?? '',
        totalFiles: (dbStats?.totalFiles ?? 0) + (dbStats?.totalDocs ?? 0),
        totalCodeFiles: dbStats?.totalFiles ?? 0,
        totalDocFiles: dbStats?.totalDocs ?? 0,
        totalSymbols: dbStats?.totalSymbols ?? 0,
        totalCalls: dbStats?.totalCalls ?? 0,
        totalSections: dbStats?.totalSections ?? 0,
        totalRules: dbStats?.totalRules ?? 0,
        lastIndexedAt: this.lastIndexedAt ?? undefined,
        indexing: this.isIndexing,
        languages: dbStats?.languages ?? {},
      };
      sendJson(stats);
      return;
    }

    if (url.pathname === '/index' && method === 'POST') {
      const body = await readBody();
      const result = await this.performFullIndex(body.path);
      sendJson(result);
      return;
    }

    if (url.pathname === '/query' && method === 'POST') {
      const body = await readBody();
      if (!body.cypher) {
        sendJson({ error: 'Missing cypher parameter' }, 400);
        return;
      }
      const queryRes = await this.repo?.query(body.cypher, body.params);
      sendJson(queryRes);
      return;
    }

    if (url.pathname === '/rpc' && method === 'POST') {
      const body = await readBody();
      const { action, params = {} } = body;
      const result = await this.dispatchRpc(action, params);
      sendJson(result);
      return;
    }

    if (url.pathname === '/shutdown' && method === 'POST') {
      sendJson({ status: 'shutting down' });
      setTimeout(() => this.stop(), 200);
      return;
    }

    sendJson({ error: 'Endpoint not found' }, 404);
  }

  /**
   * Dispatch an RPC action, emitting `rpc:` / `search:` trace lines when
   * tracing is enabled. Tracing adds a single boolean check when off.
   */
  private async dispatchRpc(action: string, params: any): Promise<any> {
    if (!this.tracer.enabled) {
      return await this.dispatchRpcInner(action, params);
    }

    const startNs = process.hrtime.bigint();
    const metrics: { rawCandidates?: number; candidates?: number } = {};

    try {
      const result = await this.dispatchRpcInner(action, params, metrics);
      const elapsedNs = process.hrtime.bigint() - startNs;
      const resultSize = Array.isArray(result)
        ? result.length
        : result && typeof result === 'object'
        ? Object.keys(result).length
        : 0;

      this.tracer.line(`rpc: action=${action} elapsed=${fmtMs(elapsedNs)} result=${resultSize}`);

      if (action === 'search_symbols') {
        const pattern = params.pattern ?? params.query ?? '';
        const matches = Array.isArray(result) ? result.length : 0;
        this.tracer.line(
          `search: pattern="${pattern}" case_insensitive=true ` +
            `raw_candidates=${metrics.rawCandidates ?? matches} candidates=${metrics.candidates ?? matches} ` +
            `matches=${matches} elapsed=${fmtMs(elapsedNs)}`
        );
      } else if (action === 'knowledge_search') {
        const matches = Array.isArray(result) ? result.length : 0;
        this.tracer.line(
          `knowledge search: query="${params.query ?? ''}" matches=${matches} elapsed=${fmtMs(elapsedNs)}`
        );
      }

      return result;
    } catch (err: any) {
      this.tracer.line(
        `rpc: action=${action} FAILED in ${fmtMs(process.hrtime.bigint() - startNs)}: ${err?.message ?? String(err)}`
      );
      throw err;
    }
  }

  private async dispatchRpcInner(
    action: string,
    params: any,
    metrics?: { rawCandidates?: number; candidates?: number }
  ): Promise<any> {
    if (!this.repo) throw new Error('Repository not initialized');

    switch (action) {
      case 'explore':
        return await this.repo.explore(params.limit ?? 25);
      case 'symbol_definition':
        return await this.repo.getSymbolDefinition(params.name, params.file);
      case 'call_path':
        return await this.repo.findCallPath(params.fromSymbol, params.toSymbol);
      case 'subtypes':
        return await this.repo.findSubtypesAndImplementations(params.symbol);
      case 'search_symbols':
        return await this.repo.searchSymbols(
          params.pattern ?? params.query,
          params.kind,
          params.limit ?? 25,
          metrics
        );
      case 'unused_symbols':
        return await this.repo.findUnusedSymbols(params.limit ?? 50, params.includeExported === true);
      case 'git_diff_impact':
        return await this.repo.analyzeGitDiffImpact(this.options.workdir, params.baseRef);
      case 'callers':
        return await this.repo.getCallers(params.symbol);
      case 'callees':
        return await this.repo.getCallees(params.symbol);
      case 'blast_radius':
        return await this.repo.getBlastRadius(params.symbol, params.depth ?? 3);
      case 'detect_cycles':
        return await this.repo.detectCycles();
      case 'affected_tests':
        return await this.repo.getAffectedTests(params.files ?? []);
      case 'porting_contract':
        return await this.repo.getPortingContract(params.symbol);
      case 'cross_paradigm_blueprint':
        return await this.repo.generateCrossParadigmBlueprint(params.symbol, params.targetLanguage ?? 'rust');
      case 'third_party_slice':
        return await this.repo.extractThirdPartyUsageSlice(params.libraryPrefix, params.targetLanguage ?? 'rust');
      case 'similar_functions':
        return await this.repo.findSimilarFunctions({
          threshold: params.threshold,
          targetSymbol: params.symbol,
          minLines: params.minLines,
        });
      case 'spec_code_flow':
        return await this.repo.findCodeFlowForFeature(params.query, params.flowDepth ?? 3);
      case 'symbol_spec_features':
        return await this.repo.findSpecFeaturesForSymbol(params.symbol, params.searchCallers ?? true);
      case 'contract_storage_mapping':
        return await this.repo.schemaMapContractToStorage(
          params.contractEntity,
          params.storageTarget,
          params.storageEngine
        );
      case 'storage_migration_impact':
        return await this.repo.schemaAnalyzeStorageMigrationImpact(
          params.storageContainer,
          params.attribute,
          params.action ?? 'drop'
        );
      case 'knowledge_search':
        return await this.repo.searchKnowledge(params.query, params.limit ?? 10);
      case 'knowledge_doc':
        return await this.repo.getKnowledgeDoc(params.pathOrTitle);
      default:
        throw new Error(`Unknown RPC action: ${action}`);
    }
  }

  private log(msg: string): void {
    if (this.options.onLog) {
      this.options.onLog(msg);
    } else {
      console.log(`[KnowCode] ${msg}`);
    }
  }
}
