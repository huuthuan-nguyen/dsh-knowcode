export interface DaemonOptions {
    workdir: string;
    port?: number;
    dataDir?: string;
    falkordbUrl?: string;
    onLog?: (msg: string) => void;
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
    constructor(options: DaemonOptions);
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
    private handleRequest;
    private dispatchRpc;
    private log;
}
