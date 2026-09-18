import test from 'node:test';
import assert from 'node:assert';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { KnowCodeDaemon } from '../lib/server/daemon.js';
import { KnowCodeRpcClient } from '../lib/server/client-rpc.js';
import { CodeWatcher } from '../lib/server/watcher.js';
import { Tracer, fmtMs } from '../lib/server/trace.js';
import { FalkorDBManager } from '../lib/db/falkor-manager.js';
import { initGraphSchema } from '../lib/db/schema.js';
import { KnowCodeRepository } from '../lib/db/client.js';

const TRACE_WS = resolve('/tmp/knowcode-trace-test');
const STALE_WS = resolve('/tmp/knowcode-trace-stale');
const WATCH_WS = resolve('/tmp/knowcode-trace-watch');
const WATCH_DB = resolve('/tmp/knowcode-trace-watch-db');

/** Collect trace lines into an array instead of touching real stderr. */
function collector(): { lines: string[]; sink: (l: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (l: string) => void lines.push(l) };
}

// ---------------------------------------------------------------------------
// 1. Tracer unit behaviour
// ---------------------------------------------------------------------------

test('Tracer is silent when disabled and formatted when enabled', () => {
  const off = collector();
  const disabled = new Tracer({ enabled: false, sink: off.sink });
  disabled.line('should not appear');
  disabled.done('should not appear', process.hrtime.bigint());
  assert.strictEqual(off.lines.length, 0, 'disabled tracer must emit nothing');

  const on = collector();
  const enabled = new Tracer({ enabled: true, sink: on.sink });
  enabled.line('opened index: 3 files');
  assert.strictEqual(on.lines.length, 1);
  assert.strictEqual(on.lines[0], '[trace] opened index: 3 files');

  const child = enabled.child('watch');
  child.line('batch 2 change(s)');
  assert.strictEqual(on.lines[1], '[trace] watch: batch 2 change(s)');
});

test('Tracer.step and span report elapsed durations', async () => {
  const c = collector();
  const t = new Tracer({ enabled: true, sink: c.sink });

  await t.step('slow op', async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
  assert.match(c.lines[0], /^\[trace\] slow op in \d+(\.\d+)?m?s$/);

  const span = t.span('manual span');
  await new Promise((r) => setTimeout(r, 5));
  span.end('(detail=1)');
  assert.match(c.lines[1], /^\[trace\] manual span in \d+(\.\d+)?m?s \(detail=1\)$/);
});

test('Tracer.step propagates errors while still tracing the failure', async () => {
  const c = collector();
  const t = new Tracer({ enabled: true, sink: c.sink });

  await assert.rejects(
    () => t.step('failing op', async () => { throw new Error('boom'); }),
    /boom/
  );
  assert.match(c.lines[0], /^\[trace\] failing op FAILED in .*: boom$/);
});

test('fmtMs formats nanoseconds, milliseconds and seconds', () => {
  assert.strictEqual(fmtMs(430_000n), '0.4ms');
  assert.strictEqual(fmtMs(12_000_000n), '12.0ms');
  assert.strictEqual(fmtMs(150_000_000n), '150ms');
  assert.strictEqual(fmtMs(1_240_000_000n), '1.24s');
  assert.strictEqual(fmtMs(3.5), '3.5ms');
});

// ---------------------------------------------------------------------------
// 2. Daemon startup + RPC search traces
// ---------------------------------------------------------------------------

test('knowcode serve emits tgrep-style startup and search traces', async () => {
  if (existsSync(TRACE_WS)) rmSync(TRACE_WS, { recursive: true, force: true });
  mkdirSync(join(TRACE_WS, 'src'), { recursive: true });

  writeFileSync(
    join(TRACE_WS, 'src/math.ts'),
    `
export function add(a: number, b: number): number {
  return a + b;
}

export function addAll(items: number[]): number {
  let total = 0;
  for (const n of items) total = add(total, n);
  return total;
}
`
  );

  const capture = collector();
  const daemon = new KnowCodeDaemon({
    workdir: TRACE_WS,
    port: 48210,
    trace: true,
    onTrace: capture.sink,
  });

  try {
    await daemon.start();
    // Startup block: index contents + readiness line.
    assert.ok(
      capture.lines.some((l) => /^\[trace\] opened index: /.test(l)),
      `expected "opened index:" trace, got:\n${capture.lines.join('\n')}`
    );
    assert.ok(
      capture.lines.some((l) => /^\[trace\] serve ready in .*HTTP on port 48210/.test(l)),
      'expected "serve ready" trace with the port'
    );
    // Watcher configuration traces.
    assert.ok(capture.lines.some((l) => l.includes('refresh mode: auto')));
    assert.ok(capture.lines.some((l) => l.startsWith('[trace] watch: ignore matcher ready')));
    assert.ok(capture.lines.some((l) => l.startsWith('[trace] watch: worker started')));

    // Full index reports phase timings.
    await daemon.performFullIndex();
    const indexLine = capture.lines.find((l) => l.startsWith('[trace] index: scan='));
    assert.ok(indexLine, 'expected an "index: scan=..." phase trace');
    assert.match(indexLine!, /parse\+ingest=.*relink=.*total=/);

    // Stale check on a freshly indexed workspace must report up-to-date.
    const stale = await daemon.staleCheck();
    assert.strictEqual(stale.added.length, 0);
    assert.strictEqual(stale.changed.length, 0);
    assert.strictEqual(stale.deleted.length, 0);
    assert.ok(
      capture.lines.some((l) => /^\[trace\] stale check: index is up-to-date \(\d+ files checked in /.test(l)),
      'expected up-to-date stale check trace'
    );

    // RPC search produces both a generic rpc: line and a detailed search: line.
    const client = new KnowCodeRpcClient({ workdir: TRACE_WS, port: 48210 });
    const results = await client.call('search_symbols', { pattern: 'add' });
    assert.ok(results.length >= 1);

    assert.ok(
      capture.lines.some((l) => /^\[trace\] rpc: action=search_symbols elapsed=.*result=\d+/.test(l)),
      'expected generic rpc trace line'
    );

    const searchLine = capture.lines.find((l) => l.startsWith('[trace] search: pattern="add"'));
    assert.ok(searchLine, `expected "search:" trace, got:\n${capture.lines.join('\n')}`);
    assert.match(searchLine!, /case_insensitive=true/);
    assert.match(searchLine!, /raw_candidates=\d+/);
    assert.match(searchLine!, /candidates=\d+/);
    assert.match(searchLine!, /matches=\d+/);
    assert.match(searchLine!, /elapsed=/);
  } finally {
    await daemon.stop();
    if (existsSync(TRACE_WS)) rmSync(TRACE_WS, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Tracing off must produce zero trace output
// ---------------------------------------------------------------------------

test('daemon emits no traces when tracing is not enabled', async () => {
  if (existsSync(TRACE_WS)) rmSync(TRACE_WS, { recursive: true, force: true });
  mkdirSync(join(TRACE_WS, 'src'), { recursive: true });
  writeFileSync(join(TRACE_WS, 'src/math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

  const capture = collector();
  const daemon = new KnowCodeDaemon({
    workdir: TRACE_WS,
    port: 48213,
    // trace intentionally omitted
    onTrace: capture.sink,
  });

  try {
    await daemon.start();
    await daemon.performFullIndex();

    const client = new KnowCodeRpcClient({ workdir: TRACE_WS, port: 48213 });
    await client.call('search_symbols', { pattern: 'add' });

    assert.strictEqual(
      capture.lines.length,
      0,
      `tracing must be off by default, but got:\n${capture.lines.join('\n')}`
    );
  } finally {
    await daemon.stop();
    if (existsSync(TRACE_WS)) rmSync(TRACE_WS, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Stale check detects added / changed / deleted
// ---------------------------------------------------------------------------

test('stale check detects added, changed and deleted files', async () => {
  if (existsSync(STALE_WS)) rmSync(STALE_WS, { recursive: true, force: true });
  mkdirSync(join(STALE_WS, 'src'), { recursive: true });
  writeFileSync(join(STALE_WS, 'src/one.ts'), 'export function one() { return 1; }\n');
  writeFileSync(join(STALE_WS, 'src/two.ts'), 'export function two() { return 2; }\n');

  const capture = collector();
  const daemon = new KnowCodeDaemon({
    workdir: STALE_WS,
    port: 48211,
    trace: true,
    onTrace: capture.sink,
  });

  try {
    await daemon.start({ withWatcher: false });
    await daemon.performFullIndex();

    // Freshly indexed -> up to date.
    let stale = await daemon.staleCheck();
    assert.deepStrictEqual(
      { a: stale.added.length, c: stale.changed.length, d: stale.deleted.length },
      { a: 0, c: 0, d: 0 }
    );

    // Touch mtime WITHOUT changing content -> must NOT be reported (hash confirms).
    const onePath = join(STALE_WS, 'src/one.ts');
    const future = new Date(Date.now() + 10_000);
    utimesSync(onePath, future, future);
    stale = await daemon.staleCheck();
    assert.strictEqual(stale.changed.length, 0, 'mtime-only change must not count as stale');

    // Real content change -> changed.
    writeFileSync(onePath, 'export function one() { return 111; }\n');
    const future2 = new Date(Date.now() + 20_000);
    utimesSync(onePath, future2, future2);
    stale = await daemon.staleCheck();
    assert.deepStrictEqual(stale.changed, ['src/one.ts']);

    // New file -> added.
    writeFileSync(join(STALE_WS, 'src/three.ts'), 'export function three() { return 3; }\n');
    stale = await daemon.staleCheck();
    assert.deepStrictEqual(stale.added, ['src/three.ts']);

    // Removed file -> deleted.
    unlinkSync(join(STALE_WS, 'src/two.ts'));
    stale = await daemon.staleCheck();
    assert.deepStrictEqual(stale.deleted, ['src/two.ts']);

    assert.ok(
      capture.lines.some((l) => /^\[trace\] stale check: \d+ added \/ \d+ changed \/ \d+ deleted/.test(l)),
      'expected a stale summary trace line'
    );

    // Incremental reconcile removes the deleted file and refreshes the changed one.
    await daemon.reindexPaths([...stale.added, ...stale.changed], stale.deleted);
    const after = await daemon.staleCheck();
    assert.deepStrictEqual(
      { a: after.added.length, c: after.changed.length, d: after.deleted.length },
      { a: 0, c: 0, d: 0 },
      'workspace must be clean after an incremental reindex'
    );
  } finally {
    await daemon.stop();
    if (existsSync(STALE_WS)) rmSync(STALE_WS, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Watcher traces during an incremental reindex
// ---------------------------------------------------------------------------

test('watcher emits batch and reindex traces for a live edit', async () => {
  for (const dir of [WATCH_WS, WATCH_DB]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(join(WATCH_WS, 'src'), { recursive: true });

  const mgr = new FalkorDBManager();
  const instance = await mgr.start({ dataDir: WATCH_DB, preferredPort: 48230 });

  try {
    const graph = instance.client.selectGraph('knowcode-watch');
    await initGraphSchema(graph);
    const repo = new KnowCodeRepository(graph);

    const capture = collector();
    const watcher = new CodeWatcher({
      workdir: WATCH_WS,
      repo,
      debounceMs: 50,
      trace: true,
      onTrace: capture.sink,
    });
    watcher.start();

    assert.ok(capture.lines.some((l) => l.startsWith('[trace] watch: ignore matcher ready')));
    assert.ok(capture.lines.some((l) => l.startsWith('[trace] watch: worker started')));

    // chokidar can swallow a file created before its initial scan completes, so
    // wait for readiness rather than racing it — this was the source of an
    // intermittent 6s timeout under load.
    assert.strictEqual(await watcher.waitUntilReady(10_000), true, 'watcher must become ready');

    // Write a brand-new file so chokidar fires an "add" event.
    writeFileSync(
      join(WATCH_WS, 'src/live.ts'),
      'export function liveOne() { return 1; }\nexport function liveTwo() { return 2; }\n'
    );

    // Wait for: awaitWriteFinish (200ms) + debounce (50ms) + ingest.
    const deadline = Date.now() + 6000;
    while (
      Date.now() < deadline &&
      !capture.lines.some((l) => l.includes('incremental reindex complete'))
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }

    await watcher.stop();

    assert.ok(
      capture.lines.some((l) => /^\[trace\] watch: batch \d+ change\(s\), \d+ deletion\(s\)/.test(l)),
      `expected a batch trace, got:\n${capture.lines.join('\n')}`
    );
    assert.ok(
      capture.lines.some((l) => /^\[trace\] watch: update src\/live\.ts in .*symbols=2/.test(l)),
      `expected a per-file update trace, got:\n${capture.lines.join('\n')}`
    );
    const done = capture.lines.find((l) => l.includes('incremental reindex complete'));
    assert.ok(done, 'expected an incremental reindex completion trace');
    assert.match(done!, /relink=/);
  } finally {
    await mgr.stop();
    for (const dir of [WATCH_WS, WATCH_DB]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }
});
