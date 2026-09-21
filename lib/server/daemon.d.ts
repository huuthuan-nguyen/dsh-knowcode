import { Tracer, type TraceSink } from './trace.js';
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
    /** Files skipped because parsing or ingesting them threw. */
    skippedFiles?: number;
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
export declare class KnowCodeDaemon {
    private options;
    private server;
    private falkorManager;
    private falkorInstance;
    private repo;
    private watcher;
    private isIndexing;
    /**
     * The run in flight, so a second caller shares it instead of failing.
     *
     * `/index` used to answer 500 `Indexing already in progress.` when invoked while
     * the daemon was still reconciling at startup, which surfaced to the agent as
     * `[KnowCode Error: …]` from the `sync` tool.
     */
    private indexingPromise;
    /** Last time the daemon did anything, for the idle timeout. */
    private lastActivityAt;
    /** Files skipped during the current pass because parsing or ingesting threw. */
    private failedFiles;
    private idleTimer;
    /** Summary of the last startup reconcile, for callers that share an in-flight run. */
    private lastReconcile;
    private lastIndexedAt;
    private tracer;
    /** Data directory of the running instance, for releasing the workspace guard. */
    private dataDir;
    /** Largest file to read and index, in bytes. */
    private readonly maxFileSize;
    private shutdownHandler;
    constructor(options: DaemonOptions);
    /** Expose the tracer so CLI callers can emit their own spans. */
    getTracer(): Tracer;
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
    waitForWatcherReady(timeoutMs?: number): Promise<boolean>;
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
    private listenOnAvailablePort;
    start(startOpts?: {
        withWatcher?: boolean;
    }): Promise<{
        port: number;
        pid: number;
    }>;
    private startInner;
    stop(): Promise<void>;
    /** Record that the daemon did something, resetting the idle timeout. */
    private touch;
    /**
     * Start the idle timer when a budget is configured.
     *
     * A daemon is spawned per workspace on first use and otherwise lives until the
     * harness exits, so a long session that touches many workspaces accumulates one
     * daemon, watcher and embedded database each. With a budget, an unused workspace
     * lets its daemon go.
     */
    private startIdleTimer;
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
    reconcileStartup(opts?: {
        forceIndex?: boolean;
    }): Promise<ReconcileSummary>;
    /**
     * Perform full indexing pass on the workspace
     */
    performFullIndex(targetPath?: string): Promise<IndexSummary>;
    /**
     * Serialize an indexing pass and keep the observable state consistent.
     *
     * `isIndexing` was previously set only here and in `performFullIndex`, so
     * `staleCheck`/`reindexPaths` ran unreported: `/status` could not say a reconcile
     * was in progress, and a `sync` arriving mid-reconcile started a second one.
     */
    private runIndexing;
    private performFullIndexUnlocked;
    /**
     * Ingest schema definitions declared inside a source file.
     *
     * Only textual model declarations are read — a Mongoose schema, or any future ORM
     * mapping. Nothing here opens or contacts a database.
     */
    private ingestCodeSchema;
    private ingestSchemaContent;
    /**
     * Discover indexable files. Shared by full indexing and the stale check so the
     * two always agree on exactly which files are in scope.
     */
    private discoverFiles;
    /**
     * Compare the graph against the filesystem without re-parsing everything.
     *
     * Uses `mtimeMs` as a cheap first pass and only falls back to hashing a file
     * whose mtime moved, so a no-op run never reads file contents.
     */
    staleCheck(targetPath?: string): Promise<{
        added: string[];
        changed: string[];
        deleted: string[];
        checked: number;
        timeMs: number;
    }>;
    /**
     * Incrementally reconcile the graph with a known set of changed paths.
     * Used by `serve` startup so an unchanged workspace costs no re-parsing.
     */
    reindexPaths(changed: string[], deleted?: string[], targetPath?: string): Promise<{
        updated: number;
        removed: number;
    }>;
    private handleRequest;
    /**
     * Dispatch an RPC action, emitting `rpc:` / `search:` trace lines when
     * tracing is enabled. Tracing adds a single boolean check when off.
     */
    private dispatchRpc;
    private dispatchRpcInner;
    private log;
}
