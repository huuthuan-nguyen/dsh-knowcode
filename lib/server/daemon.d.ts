import { Tracer, type TraceSink } from './trace.js';
export interface DaemonOptions {
    workdir: string;
    port?: number;
    dataDir?: string;
    falkordbUrl?: string;
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
    private lastIndexedAt;
    private tracer;
    constructor(options: DaemonOptions);
    /** Expose the tracer so CLI callers can emit their own spans. */
    getTracer(): Tracer;
    start(startOpts?: {
        withWatcher?: boolean;
    }): Promise<{
        port: number;
        pid: number;
    }>;
    stop(): Promise<void>;
    /**
     * Perform full indexing pass on the workspace
     */
    performFullIndex(targetPath?: string): Promise<{
        filesIndexed: number;
        symbolsIndexed: number;
        docsIndexed: number;
        timeMs: number;
    }>;
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
