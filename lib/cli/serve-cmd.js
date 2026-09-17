import { resolve } from 'node:path';
import { KnowCodeDaemon } from '../server/daemon.js';
import { createTraceSink, isTraceEnabled } from './trace-flag.js';
export async function runServeCommand(targetDir = '.', options = {}) {
    const workdir = resolve(targetDir);
    const tracing = isTraceEnabled(options.trace);
    const daemon = new KnowCodeDaemon({
        workdir,
        port: options.port,
        dataDir: options.dataDir,
        trace: tracing,
        onTrace: createTraceSink(tracing),
        onLog: (msg) => console.log(`[KnowCode] ${msg}`),
    });
    console.log(`[KnowCode] Starting daemon & file watcher in ${workdir}...`);
    const info = await daemon.start();
    console.log(`[KnowCode] Daemon online! (PID: ${info.pid}, Port: ${info.port})`);
    const tracer = daemon.getTracer();
    if (options.forceIndex) {
        tracer.line('index mode: forced full re-index (--force-index)');
        console.log(`[KnowCode] Performing full index (forced)...`);
        await daemon.performFullIndex();
    }
    else {
        // Reconcile against the filesystem instead of always re-parsing everything.
        try {
            const stale = await daemon.staleCheck();
            const total = stale.added.length + stale.changed.length + stale.deleted.length;
            if (total === 0) {
                console.log(`[KnowCode] Index is up-to-date (${stale.checked} files checked).`);
            }
            else {
                console.log(`[KnowCode] Index stale: ${stale.added.length} added, ${stale.changed.length} changed, ` +
                    `${stale.deleted.length} deleted. Re-indexing...`);
                await daemon.reindexPaths([...stale.added, ...stale.changed], stale.deleted);
            }
        }
        catch (err) {
            // Never leave the graph unindexed because of a stale-check failure.
            tracer.line(`stale check failed: ${err?.message ?? String(err)} — falling back to full index`);
            console.log(`[KnowCode] Stale check failed; performing full index...`);
            await daemon.performFullIndex();
        }
    }
    console.log(`[KnowCode] Ready and watching for file changes. Press Ctrl+C to stop.`);
    if (tracing) {
        tracer.line('trace logging active — press Ctrl+C to stop');
    }
    // Keep process alive until interrupted
    await new Promise(() => { });
}
