import type { KnowCodeStats } from '../types.js';
export interface RpcClientOptions {
    workdir: string;
    port?: number;
    dataDir?: string;
}
export declare class KnowCodeRpcClient {
    private options;
    private basePort;
    constructor(options: RpcClientOptions);
    /**
     * Determine the active port from .knowcode/daemon.json or default
     */
    getActivePort(): number;
    /**
     * Check whether a daemon serving *this* workspace is active.
     *
     * Every workspace defaults to the same port, and a workspace that has never run
     * `knowcode serve` has no `daemon.json` to read a port from. Without an identity
     * check such a call would happily reach another project's daemon and return that
     * project's graph. The `/status` payload carries the daemon's workspace, so a
     * mismatch is rejected here.
     */
    isDaemonAlive(): Promise<boolean>;
    /** Fetch `/status`, or null when nothing usable answered. */
    private tryGetStatus;
    /**
     * Whether a status payload came from a daemon for this workspace.
     *
     * Daemons predating the `workdir` field report `undefined`; those are accepted
     * only when the port came from this workspace's own `daemon.json`, so a
     * default-port guess is still rejected.
     */
    private belongsToThisWorkspace;
    /** Whether this workspace records its own daemon port. */
    private hasOwnDaemonFile;
    /**
     * Get stats from daemon
     */
    getStatus(): Promise<KnowCodeStats>;
    /**
     * Call a tool action via daemon RPC
     */
    call(action: string, params?: Record<string, any>): Promise<any>;
    /**
     * Run raw Cypher query
     */
    query(cypher: string, params?: Record<string, any>): Promise<any>;
    /**
     * Trigger index
     */
    triggerIndex(targetPath?: string): Promise<any>;
    /**
     * Request daemon shutdown
     */
    shutdown(): Promise<void>;
}
