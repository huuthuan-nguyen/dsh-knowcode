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
export function fmtMs(value: bigint | number): string {
  let ms: number;
  if (typeof value === 'bigint') {
    ms = Number(value) / 1e6;
  } else {
    ms = value;
  }

  if (!Number.isFinite(ms) || ms < 0) ms = 0;

  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  if (ms >= 100) {
    return `${Math.round(ms)}ms`;
  }
  if (ms >= 10) {
    return `${ms.toFixed(1)}ms`;
  }
  return `${ms.toFixed(1)}ms`;
}

/** Convert elapsed nanoseconds to milliseconds as a float. */
export function nsToMs(ns: bigint): number {
  return Number(ns) / 1e6;
}

export class Tracer {
  /** Whether trace output is active. Read this before doing expensive work. */
  public readonly enabled: boolean;

  private readonly sink: TraceSink;

  constructor(options: TraceOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.sink =
      options.sink ??
      ((line: string) => {
        process.stderr.write(line + '\n');
      });
  }

  /**
   * Emit a complete trace line: `[trace] <msg>`.
   */
  public line(msg: string): void {
    if (!this.enabled) return;
    this.sink(`[trace] ${msg}`);
  }

  /**
   * Emit `[trace] <msg> in <elapsed>` for a previously captured start time.
   */
  public done(msg: string, startNs: bigint): void {
    if (!this.enabled) return;
    this.sink(`[trace] ${msg} in ${fmtMs(process.hrtime.bigint() - startNs)}`);
  }

  /**
   * Time an async operation, emitting `<label> in <elapsed>` on completion.
   * The result is passed through untouched; errors still propagate after a
   * trace line noting the failure.
   */
  public async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return await fn();

    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      this.sink(`[trace] ${label} in ${fmtMs(process.hrtime.bigint() - start)}`);
      return result;
    } catch (err: any) {
      this.sink(
        `[trace] ${label} FAILED in ${fmtMs(process.hrtime.bigint() - start)}: ${err?.message ?? String(err)}`
      );
      throw err;
    }
  }

  /**
   * Begin a manual span for cases where the work is not a single awaitable
   * (e.g. a loop that accumulates counters). Returns a handle whose `end()`
   * accepts an optional detail suffix.
   */
  public span(label: string): { end: (detail?: string) => void; elapsedNs: () => bigint } {
    const start = process.hrtime.bigint();
    const self = this;
    return {
      elapsedNs: () => process.hrtime.bigint() - start,
      end(detail?: string) {
        if (!self.enabled) return;
        const suffix = detail ? ` ${detail}` : '';
        self.sink(`[trace] ${label} in ${fmtMs(process.hrtime.bigint() - start)}${suffix}`);
      },
    };
  }

  /**
   * Build a child tracer that prefixes every line with a namespace, e.g.
   * `child('watch').line('batch 2')` -> `[trace] watch: batch 2`.
   */
  public child(namespace: string): Tracer {
    if (!this.enabled) return this;
    const parentSink = this.sink;
    return new Tracer({
      enabled: true,
      sink: (line: string) => {
        // Re-inject the namespace right after the "[trace] " prefix.
        const body = line.startsWith('[trace] ') ? line.slice(8) : line;
        parentSink(`[trace] ${namespace}: ${body}`);
      },
    });
  }
}

/** A tracer that silently discards everything, used when tracing is off. */
export const NULL_TRACER = new Tracer({ enabled: false });
