export interface AutoStartResult {
    /** A daemon for this workspace is running when this resolves true. */
    started: boolean;
    /** Why it could not be started, for a user-facing diagnostic. */
    reason?: string;
    /** Whether this call actually spawned a process (false if one was already up). */
    spawned?: boolean;
}
export interface AutoStartOptions {
    /** Total time to wait for the daemon to answer `/status`. */
    readyTimeoutMs?: number;
    /** Interval between readiness probes. */
    pollIntervalMs?: number;
}
/**
 * Ensure a KnowCode daemon is running for `workdir`, starting one if needed.
 *
 * Backs the plugin's `autoStartDaemon` option. Without it every tool answered
 * only with a "run `knowcode serve .`" notice unless the user had already started
 * a daemon by hand, which made the plugin look broken on a fresh checkout.
 *
 * The daemon is spawned detached from this package's own CLI so it survives the
 * host process, and its output is appended to `<dataDir>/serve.log`.
 *
 * @param workdir - absolute workspace the daemon should serve.
 * @param port - preferred daemon port.
 * @param options - readiness budget overrides.
 * @returns whether a usable daemon is now running.
 */
export declare function ensureDaemonStarted(workdir: string, port: number, options?: AutoStartOptions): Promise<AutoStartResult>;
