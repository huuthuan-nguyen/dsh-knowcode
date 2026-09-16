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
     * Check if daemon is active and responding
     */
    isDaemonAlive(): Promise<boolean>;
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
