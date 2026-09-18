export interface ServeLockRecord {
    pid: number;
    port?: number;
    workdir: string;
    startedAt: string;
}
export interface AcquireResult {
    acquired: boolean;
    /** The daemon already serving this workspace, when `acquired` is false. */
    existing?: ServeLockRecord | null;
    /**
     * The guard names a process that no longer exists, yet the file could not be
     * removed — a read-only data directory, or a file owned by another user. Reported
     * separately so the caller does not claim a live daemon is serving.
     */
    staleUnremovable?: boolean;
}
/** Path of the guard file for a data directory. */
export declare function serveLockPath(dataDir: string): string;
/** Read the guard, or null when absent or unreadable. */
export declare function readServeLock(dataDir: string): ServeLockRecord | null;
/**
 * Claim sole ownership of a workspace's daemon.
 *
 * Without this, two `knowcode serve` runs for one workspace both start: the second
 * falls back to another port and then **overwrites `daemon.json`**, leaving two
 * HTTP servers, two file watchers and two embedded FalkorDB processes — the last
 * two backed by the same `.rdb` file. Clients would also flip between them.
 *
 * The guard is an exclusive (`wx`) create, so a check-then-act race between two
 * simultaneous starts cannot both win. A guard naming a dead pid is stale and is
 * reclaimed, so a crashed daemon never blocks the workspace forever.
 *
 * @param dataDir - the workspace's data directory.
 * @param workdir - absolute workspace path, recorded for diagnostics.
 * @param port - preferred port, recorded for diagnostics.
 * @returns whether the caller may start, plus the incumbent when it may not.
 */
export declare function acquireServeLock(dataDir: string, workdir: string, port?: number): AcquireResult;
/**
 * Release the guard, but only while it still names this process — a lock already
 * reclaimed by another daemon must not be deleted out from under it.
 *
 * @returns whether the guard was removed.
 */
export declare function releaseServeLock(dataDir: string): boolean;
/** Error thrown when another daemon already serves the workspace. */
export declare class DaemonAlreadyRunningError extends Error {
    readonly existing: ServeLockRecord | null;
    readonly workdir: string;
    readonly staleUnremovable: boolean;
    readonly lockPath?: string | undefined;
    constructor(existing: ServeLockRecord | null, workdir: string, staleUnremovable?: boolean, lockPath?: string | undefined);
}
