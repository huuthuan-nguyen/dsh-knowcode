import { resolve } from 'node:path';
import { KnowCodeDaemon } from '../server/daemon.js';
import { DaemonAlreadyRunningError } from '../server/serve-lock.js';
import { createTraceSink, isTraceEnabled } from './trace-flag.js';

export async function runServeCommand(
  targetDir: string = '.',
  options: {
    port?: number;
    dataDir?: string;
    trace?: boolean;
    forceIndex?: boolean;
    maxFileSize?: number;
    idleTimeout?: number;
  } = {}
): Promise<void> {
  const workdir = resolve(targetDir);
  const tracing = isTraceEnabled(options.trace);

  const daemon = new KnowCodeDaemon({
    workdir,
    port: options.port,
    dataDir: options.dataDir,
    maxFileSize: options.maxFileSize,
    idleTimeoutMs: options.idleTimeout ? options.idleTimeout * 60_000 : 0,
    trace: tracing,
    onTrace: createTraceSink(tracing),
    onLog: (msg) => console.log(`[KnowCode] ${msg}`),
  });

  console.log(`[KnowCode] Starting daemon & file watcher in ${workdir}...`);

  let info: { port: number; pid: number };
  try {
    info = await daemon.start();
  } catch (err: unknown) {
    if (err instanceof DaemonAlreadyRunningError) {
      // Not a failure: this workspace already has exactly one daemon, which is the
      // invariant we want. Report it and exit without starting a second one.
      const existing = err.existing;
      console.log(
        `[KnowCode] ${workdir} is already served by daemon pid ${existing?.pid ?? '?'}` +
          `${existing?.port ? ` on port ${existing.port}` : ''}. Nothing to do.`
      );
      return;
    }
    throw err;
  }

  console.log(`[KnowCode] Daemon online! (PID: ${info.pid}, Port: ${info.port})`);

  const tracer = daemon.getTracer();

  // Wait for the watcher, then reconcile: both are owned by the daemon so it can
  // report `indexing` on /status for the whole span. A client that has just started
  // this daemon waits on that flag, which is what stops its first query from running
  // against a half-built graph.
  const summary = await daemon.reconcileStartup({ forceIndex: options.forceIndex });

  if (summary.mode === 'forced') {
    // performFullIndex already logged its own phase lines.
  } else if (summary.mode === 'fallback') {
    // The stale-check failure and fallback were logged by the daemon.
  } else if (summary.mode === 'up-to-date') {
    // Logged by the daemon.
  }

  console.log(`[KnowCode] Ready and watching for file changes. Press Ctrl+C to stop.`);
  if (tracing) {
    tracer.line('trace logging active — press Ctrl+C to stop');
  }

  // Keep process alive until interrupted
  await new Promise<void>(() => {});
}
