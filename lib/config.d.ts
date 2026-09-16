import z from '@deepseek-ai/schemastery';
export interface KnowCodeConfig {
    /** Optional custom FalkorDB URL (e.g. redis://127.0.0.1:6379). Defaults to embedded FalkorDB. */
    falkordbUrl?: string;
    /** Port for the KnowCode daemon server. Defaults to 48123. */
    daemonPort?: number;
    /** Directory for local database and index storage. Defaults to '.knowcode'. */
    dataDir?: string;
    /** Maximum file size in bytes to index (default: 1,048,576 / 1MB). */
    maxFileSize?: number;
    /** Default traversal depth for blast radius / impact analysis (default: 3). */
    blastRadiusMaxDepth?: number;
    /** Auto-start daemon when DSH launches if not running (default: true). */
    autoStartDaemon?: boolean;
}
export declare const KnowCodeConfig: z<KnowCodeConfig>;
export interface ResolvedKnowCodeConfig {
    falkordbUrl: string;
    daemonPort: number;
    dataDir: string;
    maxFileSize: number;
    blastRadiusMaxDepth: number;
    autoStartDaemon: boolean;
}
export declare function resolveConfig(raw: KnowCodeConfig): ResolvedKnowCodeConfig;
