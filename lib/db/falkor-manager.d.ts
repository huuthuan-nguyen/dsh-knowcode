import { ChildProcess } from 'node:child_process';
import { FalkorDB } from 'falkordb';
export interface FalkorInstance {
    port: number;
    process?: ChildProcess;
    client: FalkorDB;
    dbPath: string;
    isEmbedded: boolean;
}
export declare class FalkorDBManager {
    private instance;
    /**
     * Find an available TCP port starting from startPort
     */
    static findOpenPort(startPort?: number): Promise<number>;
    /**
     * Locate embedded binaries for the current platform
     */
    static resolveBinaries(): {
        redisServerPath: string;
        modulePath: string;
    } | null;
    /**
     * Start or connect to FalkorDB
     */
    start(options: {
        customUrl?: string;
        dataDir: string;
        preferredPort?: number;
    }): Promise<FalkorInstance>;
    /**
     * Stop the running instance
     */
    stop(): Promise<void>;
    getInstance(): FalkorInstance | null;
}
