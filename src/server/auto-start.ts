import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowCodeRpcClient } from './client-rpc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AutoStartResult {
  /** A daemon for this workspace is running when this resolves true. */
  started: boolean;
  /** Why it could not be started, for a user-facing diagnostic. */
  reason?: string;
  /** Whether this call actually spawned a process (false if one was already up). */
  spawned?: boolean;
  /** Workspace the daemon serves, for the start-up note. */
  workdir?: string;
  /** Files and symbols in the graph once indexing settled. */
  filesIndexed?: number;
  symbolsIndexed?: number;
  /** How long the wait for indexing took, in milliseconds. */
  indexMs?: number;
  /** True when indexing was still running when the budget expired. */
  indexingTimedOut?: boolean;
}

export interface AutoStartOptions {
  /** Total time to wait for the daemon to answer `/status`. */
  readyTimeoutMs?: number;
  /** Interval between readiness probes. */
  pollIntervalMs?: number;
  /** Largest file the spawned daemon may read and index, in bytes. */
  maxFileSize?: number;
  /** Stop the spawned daemon after this many idle milliseconds (0 disables). */
  idleTimeoutMs?: number;
  /** How long to wait for the initial index to settle before returning anyway. */
  indexTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** How long to wait for the initial index before answering with partial counts. */
const DEFAULT_INDEX_TIMEOUT_MS = 60_000;

/**
 * Concurrent tool calls in one turn must not each spawn a daemon for the same
 * workspace, so attempts are shared per workdir.
 */
const inFlight = new Map<string, Promise<AutoStartResult>>();

/**
 * Daemons **this process** spawned, keyed by resolved workdir.
 *
 * Only these may be stopped on shutdown: a daemon the user started by hand with
 * `knowcode serve .`, or one belonging to another harness, must survive us.
 */
const ownedDaemons = new Map<string, number>();

/** Pids this process owns, for diagnostics and tests. */
export function ownedDaemonPids(): number[] {
  return [...ownedDaemons.values()];
}

/** The `pid` recorded by a workspace's daemon, or null when unreadable. */
function readDaemonPid(workdir: string, dataDir = '.knowcode'): number | null {
  try {
    const record = JSON.parse(readFileSync(join(workdir, dataDir, 'daemon.json'), 'utf8'));
    return typeof record?.pid === 'number' ? record.pid : null;
  } catch {
    return null;
  }
}

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
export function stopOwnedDaemons(): number[] {
  const stopped: number[] = [];
  for (const [workdir, pid] of ownedDaemons) {
    if (readDaemonPid(workdir) !== pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch {
      /* already gone */
    }
  }
  ownedDaemons.clear();
  return stopped;
}

/** Test hook: assert ownership bookkeeping without spawning anything. */
export function __resetOwnedDaemonsForTest(): void {
  ownedDaemons.clear();
}

/** Locate this package's own CLI entry point. */
function resolveCliPath(): string | null {
  const candidates = [
    // lib/server/auto-start.js -> <root>/bin/knowcode.js
    resolve(__dirname, '..', '..', 'bin', 'knowcode.js'),
    // src/server/auto-start.ts (running from source) -> <root>/bin/knowcode.js
    resolve(__dirname, '..', '..', '..', 'bin', 'knowcode.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A spawned CLI's output is kept so a failed auto-start is diagnosable. */
function openServeLog(dataDir: string): number | null {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    return openSync(join(dataDir, 'serve.log'), 'a');
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
export async function ensureDaemonStarted(
  workdir: string,
  port: number,
  options: AutoStartOptions = {}
): Promise<AutoStartResult> {
  const resolvedWorkdir = resolve(workdir);
  const client = new KnowCodeRpcClient({ workdir: resolvedWorkdir, port });

  if (await client.isDaemonAlive()) {
    return { started: true, spawned: false };
  }

  const existing = inFlight.get(resolvedWorkdir);
  if (existing) return await existing;

  const attempt = runAutoStart(resolvedWorkdir, port, client, options);
  inFlight.set(resolvedWorkdir, attempt);
  try {
    return await attempt;
  } finally {
    inFlight.delete(resolvedWorkdir);
  }
}

async function runAutoStart(
  workdir: string,
  port: number,
  client: KnowCodeRpcClient,
  options: AutoStartOptions
): Promise<AutoStartResult> {
  const cliPath = resolveCliPath();
  if (cliPath === null) {
    return {
      started: false,
      reason: 'could not locate the knowcode CLI entry point (bin/knowcode.js)',
    };
  }

  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const dataDir = join(workdir, '.knowcode');
  const logFd = openServeLog(dataDir);

  try {
    const args = [cliPath, 'serve', workdir, '--port', String(port)];
    if (typeof options.maxFileSize === 'number' && options.maxFileSize > 0) {
      args.push('--max-file-size', String(options.maxFileSize));
    }
    if (typeof options.idleTimeoutMs === 'number' && options.idleTimeoutMs > 0) {
      args.push('--idle-timeout', String(Math.round(options.idleTimeoutMs / 60_000)));
    }

    const child = spawn(process.execPath, args, {
      cwd: workdir,
      detached: true,
      // The daemon outlives this process; detach its stdio so the host can exit.
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      windowsHide: true,
      env: { ...process.env },
    });

    // A spawn failure surfaces asynchronously; record it and let the poll below
    // report the timeout so behaviour is identical either way.
    let spawnError: Error | null = null;
    let childExited = false;
    child.once('error', (err) => {
      spawnError = err;
    });
    child.once('exit', () => {
      childExited = true;
    });
    child.unref();

    // Claim ownership as soon as a pid exists, even if readiness later times out:
    // the process is detached and would otherwise never be stopped. A failed
    // spawn leaves `pid` undefined.
    if (typeof child.pid === 'number') {
      ownedDaemons.set(workdir, child.pid);
    }

    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await client.isDaemonAlive()) {
        // The daemon answers as soon as its port is bound, which is before it has
        // reconciled the graph. Waiting here is what stops the first tool call from
        // querying a half-built index.
        const waitNs = Date.now();
        const status = await client.waitUntilIndexed(options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS);

        return {
          started: true,
          spawned: true,
          workdir,
          filesIndexed: status ? status.totalCodeFiles + status.totalDocFiles : undefined,
          symbolsIndexed: status?.totalSymbols,
          indexMs: Date.now() - waitNs,
          indexingTimedOut: status?.indexing === true,
        };
      }
      if (spawnError) break;
      // The CLI can exit immediately — most often because another daemon already
      // holds the workspace guard. Waiting out the full budget would stall the tool
      // call for nothing.
      if (childExited) {
        return {
          started: false,
          reason: 'the daemon exited immediately (another daemon may already serve this workspace)',
        };
      }
      await delay(pollIntervalMs);
    }

    if (spawnError) {
      const message = (spawnError as Error).message;
      return { started: false, reason: `failed to spawn the daemon: ${message}` };
    }
    return {
      started: false,
      reason: `the daemon did not become ready within ${readyTimeoutMs}ms`,
    };
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        /* the child already owns its own descriptor */
      }
    }
  }
}
