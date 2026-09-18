import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
export class KnowCodeRpcClient {
    options;
    basePort;
    constructor(options) {
        this.options = options;
        this.basePort = options.port ?? 48123;
    }
    /**
     * Determine the active port from .knowcode/daemon.json or default
     */
    getActivePort() {
        const dataDir = join(this.options.workdir, this.options.dataDir ?? '.knowcode');
        const infoPath = join(dataDir, 'daemon.json');
        if (existsSync(infoPath)) {
            try {
                const info = JSON.parse(readFileSync(infoPath, 'utf8'));
                if (info.port)
                    return info.port;
            }
            catch { }
        }
        return this.basePort;
    }
    /**
     * Check whether a daemon serving *this* workspace is active.
     *
     * Every workspace defaults to the same port, and a workspace that has never run
     * `knowcode serve` has no `daemon.json` to read a port from. Without an identity
     * check such a call would happily reach another project's daemon and return that
     * project's graph. The `/status` payload carries the daemon's workspace, so a
     * mismatch is rejected here.
     */
    async isDaemonAlive() {
        const status = await this.tryGetStatus(1000);
        if (status === null)
            return false;
        return this.belongsToThisWorkspace(status);
    }
    /** Fetch `/status`, or null when nothing usable answered. */
    async tryGetStatus(timeoutMs) {
        const port = this.getActivePort();
        try {
            const res = await fetch(`http://127.0.0.1:${port}/status`, {
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok)
                return null;
            return (await res.json());
        }
        catch {
            return null;
        }
    }
    /**
     * Whether a status payload came from a daemon for this workspace.
     *
     * Daemons predating the `workdir` field report `undefined`; those are accepted
     * only when the port came from this workspace's own `daemon.json`, so a
     * default-port guess is still rejected.
     */
    belongsToThisWorkspace(status) {
        const expected = resolve(this.options.workdir);
        if (typeof status.workdir === 'string' && status.workdir.length > 0) {
            return resolve(status.workdir) === expected;
        }
        return this.hasOwnDaemonFile();
    }
    /** Whether this workspace records its own daemon port. */
    hasOwnDaemonFile() {
        const dataDir = join(this.options.workdir, this.options.dataDir ?? '.knowcode');
        return existsSync(join(dataDir, 'daemon.json'));
    }
    /**
     * Wait until this workspace's daemon has finished indexing.
     *
     * A daemon starts answering `/status` as soon as its HTTP server binds, which is
     * before it has reconciled the graph. A client that has just started one therefore
     * needs to wait, or its first query runs against a partially built graph — measured
     * at 120 of 300 files on a fresh workspace.
     *
     * @param timeoutMs - give up after this long.
     * @returns the final status, or null when nothing answered or the budget expired.
     */
    async waitUntilIndexed(timeoutMs = 60_000, pollMs = 250) {
        const deadline = Date.now() + timeoutMs;
        let last = null;
        for (;;) {
            last = await this.tryGetStatus(2_000);
            if (last === null || last.indexing !== true)
                return last;
            if (Date.now() >= deadline)
                return last;
            await new Promise((r) => setTimeout(r, pollMs));
        }
    }
    /**
     * Get stats from daemon
     */
    async getStatus() {
        const port = this.getActivePort();
        const status = await this.tryGetStatus(5000);
        if (status === null) {
            throw new Error(`Failed to fetch status from port ${port}`);
        }
        if (!this.belongsToThisWorkspace(status)) {
            throw new Error(`The daemon on port ${port} serves ${status.workdir ?? 'another workspace'}, not ` +
                `${resolve(this.options.workdir)}. Run \`knowcode serve .\` in this workspace.`);
        }
        return status;
    }
    /**
     * Call a tool action via daemon RPC
     */
    async call(action, params = {}) {
        const port = this.getActivePort();
        const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, params }),
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`RPC call failed (${res.status}): ${err}`);
        }
        return await res.json();
    }
    /**
     * Run raw Cypher query
     */
    async query(cypher, params) {
        const port = this.getActivePort();
        const res = await fetch(`http://127.0.0.1:${port}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cypher, params }),
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Cypher query failed: ${err}`);
        }
        return await res.json();
    }
    /**
     * Trigger index
     */
    async triggerIndex(targetPath) {
        const port = this.getActivePort();
        const res = await fetch(`http://127.0.0.1:${port}/index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: targetPath }),
            signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Indexing failed: ${err}`);
        }
        return await res.json();
    }
    /**
     * Request daemon shutdown
     */
    async shutdown() {
        const port = this.getActivePort();
        await fetch(`http://127.0.0.1:${port}/shutdown`, {
            method: 'POST',
            signal: AbortSignal.timeout(3000),
        }).catch(() => { });
    }
}
