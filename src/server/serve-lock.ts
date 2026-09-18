import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Name of the single-instance guard inside a workspace's data directory. */
const LOCK_FILE = 'serve.lock';

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
export function serveLockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

/** Read the guard, or null when absent or unreadable. */
export function readServeLock(dataDir: string): ServeLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(serveLockPath(dataDir), 'utf8'));
    if (typeof parsed?.pid !== 'number') return null;
    return parsed as ServeLockRecord;
  } catch {
    return null;
  }
}

/** Whether a pid currently exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
export function acquireServeLock(dataDir: string, workdir: string, port?: number): AcquireResult {
  const path = serveLockPath(dataDir);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        const record: ServeLockRecord = {
          pid: process.pid,
          port,
          workdir,
          startedAt: new Date().toISOString(),
        };
        writeSync(fd, JSON.stringify(record, null, 2));
      } finally {
        closeSync(fd);
      }
      return { acquired: true };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    // Someone holds the guard. If their process is gone — or the file is
    // malformed — the guard is stale and may be reclaimed once.
    const existing = readServeLock(dataDir);
    if (existing && isProcessAlive(existing.pid)) {
      return { acquired: false, existing };
    }

    try {
      unlinkSync(path);
    } catch {
      // Swallowing this produced a misleading answer: the caller reported a live
      // daemon on a pid that had been gone for hours, because the file could not be
      // deleted. Say what actually happened instead.
      return { acquired: false, existing, staleUnremovable: true };
    }
  }

  return { acquired: false, existing: readServeLock(dataDir) };
}

/**
 * Release the guard, but only while it still names this process — a lock already
 * reclaimed by another daemon must not be deleted out from under it.
 *
 * @returns whether the guard was removed.
 */
export function releaseServeLock(dataDir: string): boolean {
  const path = serveLockPath(dataDir);
  if (!existsSync(path)) return false;

  const existing = readServeLock(dataDir);
  if (existing && existing.pid !== process.pid) return false;

  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Error thrown when another daemon already serves the workspace. */
export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly existing: ServeLockRecord | null,
    readonly workdir: string,
    readonly staleUnremovable: boolean = false,
    readonly lockPath?: string
  ) {
    super(
      staleUnremovable
        ? `A stale KnowCode guard exists for ${workdir} (pid ${existing?.pid ?? '?'} is gone) ` +
          `but could not be removed — delete ${lockPath ?? 'serve.lock'} in its data directory and retry`
        : `A KnowCode daemon is already serving ${workdir}` +
          (existing ? ` (pid ${existing.pid}${existing.port ? `, port ${existing.port}` : ''})` : '')
    );
    this.name = 'DaemonAlreadyRunningError';
  }
}
