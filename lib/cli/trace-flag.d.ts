import type { TraceSink } from '../server/trace.js';
/**
 * Trace is opt-in: either an explicit CLI flag or the KNOWCODE_TRACE env var.
 */
export declare function isTraceEnabled(flag?: boolean): boolean;
/**
 * Build the stderr sink for trace output. Returns undefined when tracing is off
 * so the daemon falls back to its own default (also stderr).
 *
 * stdout is deliberately left untouched so `knowcode serve . > out.log` keeps a
 * clean status stream while `2> trace.log` captures the trace.
 */
export declare function createTraceSink(enabled: boolean): TraceSink | undefined;
