/**
 * Trace is opt-in: either an explicit CLI flag or the KNOWCODE_TRACE env var.
 */
export function isTraceEnabled(flag) {
    if (flag)
        return true;
    const env = process.env.KNOWCODE_TRACE;
    return env === '1' || env === 'true' || env === 'yes';
}
/**
 * Build the stderr sink for trace output. Returns undefined when tracing is off
 * so the daemon falls back to its own default (also stderr).
 *
 * stdout is deliberately left untouched so `knowcode serve . > out.log` keeps a
 * clean status stream while `2> trace.log` captures the trace.
 */
export function createTraceSink(enabled) {
    if (!enabled)
        return undefined;
    return (line) => {
        process.stderr.write(line + '\n');
    };
}
