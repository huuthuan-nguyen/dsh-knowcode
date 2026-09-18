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
/** Pids this process owns, for diagnostics and tests. */
export declare function ownedDaemonPids(): number[];
/**
 * Stop every daemon this process spawned.
 *
 * Daemons are spawned detached so they outlive a single tool call, which means
 * nothing else would ever stop them: quitting the harness used to leave one
 * orphan per project, each holding an embedded FalkorDB process, an HTTP server,
 * a file watcher and a database file. The plugin calls this from its disposal
 * effect, which DeepSeek Harness runs while shutting down on SIGINT/SIGTERM
 * (`runProfile` disposes the host fiber from its signal handler).
 *
 * A tracked pid is signalled only while its workspace's `daemon.json` still names
 * that pid, so a daemon that exited on its own — and whose pid the OS may since
 * have recycled — is never mistaken for ours.
 *
 * `SIGKILL` on the harness skips disposal entirely; there is no way to clean up
 * in that case.
 *
 * @returns the pids that were signalled.
 */
export declare function stopOwnedDaemons(): number[];
/** Test hook: assert ownership bookkeeping without spawning anything. */
export declare function __resetOwnedDaemonsForTest(): void;
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
