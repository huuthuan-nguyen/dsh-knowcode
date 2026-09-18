import { resolve } from 'node:path';
import { KnowCodeDaemon } from '../server/daemon.js';
import { DaemonAlreadyRunningError } from '../server/serve-lock.js';
import { createTraceSink, isTraceEnabled } from './trace-flag.js';
export async function runServeCommand(targetDir = '.', options = {}) {
    const workdir = resolve(targetDir);
    const tracing = isTraceEnabled(options.trace);
    const daemon = new KnowCodeDaemon({
        workdir,
        port: options.port,
        dataDir: options.dataDir,
        maxFileSize: options.maxFileSize,
        trace: tracing,
        onTrace: createTraceSink(tracing),
        onLog: (msg) => console.log(`[KnowCode] ${msg}`),
    });
    console.log(`[KnowCode] Starting daemon & file watcher in ${workdir}...`);
    let info;
    try {
        info = await daemon.start();
    }
    catch (err) {
        if (err instanceof DaemonAlreadyRunningError) {
            // Not a failure: this workspace already has exactly one daemon, which is the
            // invariant we want. Report it and exit without starting a second one.
            const existing = err.existing;
            console.log(`[KnowCode] ${workdir} is already served by daemon pid ${existing?.pid ?? '?'}` +
                `${existing?.port ? ` on port ${existing.port}` : ''}. Nothing to do.`);
            return;
        }
        throw err;
    }
    console.log(`[KnowCode] Daemon online! (PID: ${info.pid}, Port: ${info.port})`);
    const tracer = daemon.getTracer();
    // Wait for the watcher to actually deliver events before reconciling. A file
    // created between the stale check and chokidar's initial scan completing would
    // otherwise be missed by both.
    const watcherReady = await daemon.waitForWatcherReady();
    if (!watcherReady) {
        tracer.line('watcher did not report ready; reconciling anyway');
    }
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
