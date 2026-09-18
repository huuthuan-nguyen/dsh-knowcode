/**
 * KnowCode plugin configuration.
 *
 * Cordis validates a plugin's `Config` through Standard Schema v1
 * (`ctx` reads `Config['~standard'].validate(raw)`), so the schema is declared
 * by hand instead of pulling in `@deepseek-ai/schemastery`.
 *
 * This keeps the plugin free of runtime harness imports. A plugin should not
 * load harness internals at runtime: it can add yet another evaluated copy of a
 * package the host already owns. (Defense-in-depth only — the harness's
 * "reading 'prepare'" defect comes from its own private `Symbol()` scheduler key
 * and reproduces with zero plugins installed.)
 */
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
    /**
     * Stop daemons this process spawned when the harness exits (default: true).
     *
     * Daemons are detached so they outlive a tool call; without this, quitting the
     * harness leaves one running per project.
     */
    stopDaemonOnExit?: boolean;
    /**
     * Stop a daemon after this many minutes without activity (default: 0, disabled).
     *
     * Daemons are spawned per workspace on first use, so a long session that touches
     * many workspaces keeps one running for each. With a budget, an unused workspace
     * lets its daemon go; restarting it is cheap because the database persists and the
     * stale check skips unchanged files.
     */
    idleTimeoutMinutes?: number;
}
export interface ResolvedKnowCodeConfig {
    falkordbUrl: string;
    daemonPort: number;
    dataDir: string;
    maxFileSize: number;
    blastRadiusMaxDepth: number;
    autoStartDaemon: boolean;
    stopDaemonOnExit: boolean;
    /** Idle budget in milliseconds; `0` disables the idle timeout. */
    idleTimeoutMs: number;
}
export declare function resolveConfig(raw: KnowCodeConfig | undefined | null): ResolvedKnowCodeConfig;
/**
 * Standard Schema v1 validator consumed by Cordis at plugin load time.
 *
 * @see https://github.com/standard-schema/standard-schema
 */
export declare const KnowCodeConfig: {
    '~standard': {
        version: 1;
        vendor: string;
        validate(value: unknown): {
            value: ResolvedKnowCodeConfig;
        };
    };
};
