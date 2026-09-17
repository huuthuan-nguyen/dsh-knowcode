/**
 * Lightweight, opt-in trace logger producing Microsoft `tgrep`-style output.
 *
 * Every emitted line is prefixed with `[trace] ` and written as a single atomic
 * chunk to the sink (stderr by default), so concurrent RPC handlers can never
 * interleave partial lines.
 *
 * When disabled the hot path collapses to a single boolean check before any
 * string construction, keeping production latency unaffected.
 */
export type TraceSink = (line: string) => void;
export interface TraceOptions {
    /** Master switch. When false, every method is a no-op. */
    enabled?: boolean;
    /** Destination for emitted lines. Defaults to stderr. */
    sink?: TraceSink;
}
/**
 * Format a duration into a compact, human-readable string.
 *
 * Accepts either nanoseconds (bigint, as produced by `process.hrtime.bigint()`)
 * or a millisecond number.
 *
 *   430_000n    -> "0.4ms"
 *   12_000_000n -> "12ms"
 *   1_240_000_000n -> "1.24s"
 */
export declare function fmtMs(value: bigint | number): string;
/** Convert elapsed nanoseconds to milliseconds as a float. */
export declare function nsToMs(ns: bigint): number;
export declare class Tracer {
    /** Whether trace output is active. Read this before doing expensive work. */
    readonly enabled: boolean;
    private readonly sink;
    constructor(options?: TraceOptions);
    /**
     * Emit a complete trace line: `[trace] <msg>`.
     */
    line(msg: string): void;
    /**
     * Emit `[trace] <msg> in <elapsed>` for a previously captured start time.
     */
    done(msg: string, startNs: bigint): void;
    /**
     * Time an async operation, emitting `<label> in <elapsed>` on completion.
     * The result is passed through untouched; errors still propagate after a
     * trace line noting the failure.
     */
    step<T>(label: string, fn: () => Promise<T>): Promise<T>;
    /**
     * Begin a manual span for cases where the work is not a single awaitable
     * (e.g. a loop that accumulates counters). Returns a handle whose `end()`
     * accepts an optional detail suffix.
     */
    span(label: string): {
        end: (detail?: string) => void;
        elapsedNs: () => bigint;
    };
    /**
     * Build a child tracer that prefixes every line with a namespace, e.g.
     * `child('watch').line('batch 2')` -> `[trace] watch: batch 2`.
     */
    child(namespace: string): Tracer;
}
/** A tracer that silently discards everything, used when tracing is off. */
export declare const NULL_TRACER: Tracer;
