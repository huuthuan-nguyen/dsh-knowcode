import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowCodeRpcClient } from './client-rpc.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/**
 * Concurrent tool calls in one turn must not each spawn a daemon for the same
 * workspace, so attempts are shared per workdir.
 */
const inFlight = new Map();
/** Locate this package's own CLI entry point. */
function resolveCliPath() {
    const candidates = [
        // lib/server/auto-start.js -> <root>/bin/knowcode.js
        resolve(__dirname, '..', '..', 'bin', 'knowcode.js'),
        // src/server/auto-start.ts (running from source) -> <root>/bin/knowcode.js
        resolve(__dirname, '..', '..', '..', 'bin', 'knowcode.js'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
/** A spawned CLI's output is kept so a failed auto-start is diagnosable. */
function openServeLog(dataDir) {
    try {
        if (!existsSync(dataDir))
            mkdirSync(dataDir, { recursive: true });
        return openSync(join(dataDir, 'serve.log'), 'a');
    }
    catch {
        return null;
    }
}
function delay(ms) {
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
export async function ensureDaemonStarted(workdir, port, options = {}) {
    const resolvedWorkdir = resolve(workdir);
    const client = new KnowCodeRpcClient({ workdir: resolvedWorkdir, port });
    if (await client.isDaemonAlive()) {
        return { started: true, spawned: false };
    }
    const existing = inFlight.get(resolvedWorkdir);
    if (existing)
        return await existing;
    const attempt = runAutoStart(resolvedWorkdir, port, client, options);
    inFlight.set(resolvedWorkdir, attempt);
    try {
        return await attempt;
    }
    finally {
        inFlight.delete(resolvedWorkdir);
    }
}
async function runAutoStart(workdir, port, client, options) {
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
        const child = spawn(process.execPath, [cliPath, 'serve', workdir, '--port', String(port)], {
            cwd: workdir,
            detached: true,
            // The daemon outlives this process; detach its stdio so the host can exit.
            stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
            windowsHide: true,
            env: { ...process.env },
        });
        // A spawn failure surfaces asynchronously; record it and let the poll below
        // report the timeout so behaviour is identical either way.
        let spawnError = null;
        child.once('error', (err) => {
            spawnError = err;
        });
        child.unref();
        const deadline = Date.now() + readyTimeoutMs;
        while (Date.now() < deadline) {
            if (await client.isDaemonAlive())
                return { started: true, spawned: true };
            if (spawnError)
                break;
            await delay(pollIntervalMs);
        }
        if (spawnError) {
            const message = spawnError.message;
            return { started: false, reason: `failed to spawn the daemon: ${message}` };
        }
        return {
            started: false,
            reason: `the daemon did not become ready within ${readyTimeoutMs}ms`,
        };
    }
    finally {
        if (logFd !== null) {
            try {
                closeSync(logFd);
            }
            catch {
                /* the child already owns its own descriptor */
            }
        }
    }
}
