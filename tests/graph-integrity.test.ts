import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { KnowCodeDaemon } from '../lib/server/daemon.js';
import { KnowCodeRpcClient } from '../lib/server/client-rpc.js';
import { CodeParser } from '../lib/parser/code-parser.js';
import { FalkorDBManager } from '../lib/db/falkor-manager.js';
import { initGraphSchema } from '../lib/db/schema.js';
import { KnowCodeRepository } from '../lib/db/client.js';
import { executeKnowCodeTool } from '../lib/tools/dispatcher.js';
import {
  ensureDaemonStarted,
  ownedDaemonPids,
  stopOwnedDaemons,
  __resetOwnedDaemonsForTest,
} from '../lib/server/auto-start.js';
import { apply } from '../lib/index.js';
import {
  readServeLock,
  DaemonAlreadyRunningError,
} from '../lib/server/serve-lock.js';

const GRAPH_WS = resolve('/tmp/knowcode-graph-integrity');
const IDENTITY_A = resolve('/tmp/knowcode-identity-a');
const IDENTITY_B = resolve('/tmp/knowcode-identity-b');
const IDENTITY_FOREIGN = resolve('/tmp/knowcode-identity-foreign');

function clean(dirs: string[]): void {
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}

function writeWs(root: string, files: Record<string, string>): void {
  clean([root]);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

// ---------------------------------------------------------------------------
// endLine / language scope — these feed structural hashing and git-diff mapping
// ---------------------------------------------------------------------------

test('parser computes full-body endLine for brace-based languages', () => {
  const parsed = CodeParser.parseFile(
    'src/calc.ts',
    [
      'export class Calculator {', // 1
      '  private total = 0;', // 2
      '', // 3
      '  add(a: number, b: number): number {', // 4
      '    if (a > 0) {', // 5
      '      return a + b;', // 6
      '    }', // 7
      '    return b;', // 8
      '  }', // 9
      '}', // 10
      '', // 11
      'export function computeTotal(items: number[]): number {', // 12
      '  return items.length;', // 13
      '}', // 14
    ].join('\n')
  )!;

  const cls = parsed.symbols.find((s) => s.name === 'Calculator')!;
  assert.strictEqual(cls.startLine, 1);
  assert.strictEqual(cls.endLine, 10, 'class must span to its closing brace');

  const add = parsed.symbols.find((s) => s.name === 'add')!;
  assert.strictEqual(add.startLine, 4);
  assert.strictEqual(add.endLine, 9, 'method must include its nested block');

  const fn = parsed.symbols.find((s) => s.name === 'computeTotal')!;
  assert.strictEqual(fn.endLine, 14, 'function must span its body, not just the signature');
});

test('parser computes indentation-based endLine for Python and keeps class scope', () => {
  const parsed = CodeParser.parseFile(
    'calc.py',
    [
      'class Calculator:', // 1
      '    def add(self, a, b):', // 2
      '        if a > 0:', // 3
      '            return a + b', // 4
      '        return b', // 5
      '', // 6
      '', // 7
      'def compute_total(items):', // 8
      '    total = 0', // 9
      '    return total', // 10
    ].join('\n')
  )!;

  const cls = parsed.symbols.find((s) => s.name === 'Calculator')!;
  assert.strictEqual(cls.endLine, 5, 'class ends before the top-level def');

  const add = parsed.symbols.find((s) => s.name === 'add')!;
  assert.strictEqual(add.endLine, 5, 'method ends at last indented line');

  // Regression: an unindented `def` after a class must NOT be treated as its method.
  const compute = parsed.symbols.find((s) => s.name === 'compute_total')!;
  assert.strictEqual(compute.kind, 'function', 'top-level def after a class must be a function');
  assert.strictEqual(compute.qname, 'compute_total', 'must not be qualified by the previous class');
  assert.strictEqual(compute.endLine, 10);
});

test('braces inside a parameter list or return type do not truncate a body', () => {
  // Regression: brace counting started on the declaration's first line, so a
  // balanced `{}` in a default value (`opts: Thing = {}`) or a return type
  // (`Promise<{ ok: boolean }>`) closed the count immediately. A 380-line
  // function was recorded as ending on its own signature line, which broke
  // structural hashing and git-diff range mapping, and truncated the signature.
  const src = [
    'export async function withDefault(', // 1
    '  opts: Thing = {},', // 2
    '  other: string = "x",', // 3
    '): Promise<{ ok: boolean }> {', // 4
    '  const inner = { a: 1 };', // 5
    '  if (inner.a) {', // 6
    '    return { ok: true };', // 7
    '  }', // 8
    '  return { ok: false };', // 9
    '}', // 10
  ].join('\n');

  const parsed = CodeParser.parseFile('src/api.ts', src)!;
  const fn = parsed.symbols.find((s) => s.name === 'withDefault')!;

  assert.strictEqual(fn.endLine, 10, 'body must run to the real closing brace');
  assert.strictEqual(
    fn.signature,
    'export async function withDefault( opts: Thing = {}, other: string = "x", ): Promise<{ ok: boolean }>',
    'signature must keep default values and the return type'
  );

  // A wrapped class header must not have its body truncated either.
  const cls = CodeParser.parseFile(
    'src/c.ts',
    ['export class Multi', '  extends Base', '  implements IFace {', '  run(): void {}', '}'].join('\n')
  )!;
  assert.strictEqual(cls.symbols.find((s) => s.name === 'Multi')!.endLine, 5);
  assert.strictEqual(cls.symbols.find((s) => s.name === 'run')!.endLine, 4);
});

test('call extraction ignores text inside string and template literals', () => {
  // Regression: call extraction ran over raw source, so a Cypher/SQL query held in
  // a template literal produced "calls" to MATCH, MERGE, CREATE, count, … — this
  // repository accumulated 600+ such phantom edges, which dominated `explore`'s
  // hub ranking and polluted caller/callee/blast-radius output with SQL keywords.
  const src = [
    'const cypher = `', // 1
    '  MATCH (a:File)-[:IMPORTS]->(b:File)', // 2
    '  MERGE (x)-[:Y]->(z)', // 3
    '  RETURN count(*) AS n', // 4
    '`;', // 5
    'const sql = "SELECT func() FROM t";', // 6
    "const other = 'CALL thing()';", // 7
    'export function real(a: number) {', // 8
    '  return helper(a) + util.format(a);', // 9
    '}', // 10
  ].join('\n');

  const parsed = CodeParser.parseFile('src/queries.ts', src)!;
  const names = parsed.calls.map((c) => c.calleeName);

  for (const keyword of ['MATCH', 'MERGE', 'CREATE', 'RETURN', 'count', 'SELECT', 'func', 'CALL', 'thing']) {
    assert.ok(!names.includes(keyword), `"${keyword}" from a string literal must not be a call`);
  }

  // Real calls on code lines are still found.
  assert.ok(names.includes('helper'), 'helper(a) must be extracted');
  assert.ok(names.includes('format'), 'util.format(a) must be extracted');
});

test('query strings do not create phantom class methods', () => {
  // Regression: the in-class method pattern accepts any `identifier(` at line
  // start, and it ran on the raw line. Inside a class, a multi-line Cypher query
  // therefore contributed a bogus method per fragment, so this repository gained
  // 40 phantom methods named MATCH / MERGE / CREATE / AND / WHERE — which then
  // filled `code_find_unused_dead_symbols` with fake dead-code candidates.
  const src = [
    'export class Repo {', // 1
    '  async load(id: string) {', // 2
    '    await this.graph.query(`', // 3
    '      MATCH (s:Symbol {id: $id})', // 4
    '      MERGE (a)-[:X]->(b)', // 5
    '      RETURN count(*) AS n', // 6
    '    `);', // 7
    '  }', // 8
    '  run(x: number) {', // 9
    '    if (x > 0) {', // 10
    '      return helper(x);', // 11
    '    }', // 12
    '  }', // 13
    '}', // 14
  ].join('\n');

  const parsed = CodeParser.parseFile('src/repo.ts', src)!;
  const qnames = parsed.symbols.map((s) => s.qname);

  assert.deepStrictEqual(
    parsed.symbols.filter((s) => s.kind !== 'class').map((s) => s.name).sort(),
    ['load', 'run'],
    `only real methods may be indexed, got: ${JSON.stringify(qnames)}`
  );

  for (const keyword of ['MATCH', 'MERGE', 'RETURN', 'count', 'if']) {
    assert.ok(
      !parsed.symbols.some((s) => s.name === keyword),
      `"${keyword}" from a query string must not become a symbol`
    );
  }

  // The enclosing class must still close at its real brace.
  assert.strictEqual(parsed.symbols.find((s) => s.name === 'Repo')!.endLine, 14);
  assert.strictEqual(parsed.symbols.find((s) => s.name === 'load')!.endLine, 8);
  assert.strictEqual(parsed.symbols.find((s) => s.name === 'run')!.endLine, 13);
});

test('code embedded in a template literal is not indexed', () => {
  // Test fixtures and code generators hold sample source inside template
  // literals. Parsing it produced phantom symbols — this repository gained a
  // `Calculator` class that only existed in a test fixture string, plus a
  // `Calculator.join` method attributed from unrelated lines nearby.
  const src = [
    'import { join } from "node:path";', // 1
    'test("fixture", () => {', // 2
    '  writeFileSync(', // 3
    '    join(WS, "src/math.ts"),', // 4
    '    `', // 5
    'export interface Adder { add(a: number, b: number): number }', // 6
    '', // 7
    'export class Calculator implements Adder {', // 8
    '  add(a: number, b: number): number { return a + b; }', // 9
    '}', // 10
    '`', // 11
    '  );', // 12
    '});', // 13
    '', // 14
    'export class Real {', // 15
    '  realMethod(): void {}', // 16
    '}', // 17
  ].join('\n');

  const parsed = CodeParser.parseFile('tests/fixture.test.ts', src)!;
  const qnames = parsed.symbols.map((s) => s.qname).sort();

  assert.deepStrictEqual(
    qnames,
    ['Real', 'Real.realMethod'],
    `only real declarations may be indexed, got: ${JSON.stringify(qnames)}`
  );
});

test('control-flow keywords are never indexed as methods', () => {
  // The in-class pattern accepts any `identifier(`, so `while (…)` inside a method
  // became a method named `while`. Filtering must be by exact keyword: a
  // `startsWith` test would also discard genuine methods like `iffy` or `format`.
  const src = [
    'export class Repo {', // 1
    '  async load(id: string) {', // 2
    '    while (this.pending) {', // 3
    '      await this.flush();', // 4
    '    }', // 5
    '    for (const x of items) { consume(x); }', // 6
    '    try { risky(); } catch (e) { handle(e); }', // 7
    '    if (x) { return; }', // 8
    '  }', // 9
    '  iffy(a: number): void {}', // 10
    '  format(a: string): string { return a; }', // 11
    '}', // 12
  ].join('\n');

  const parsed = CodeParser.parseFile('src/repo.ts', src)!;
  const names = parsed.symbols.map((s) => s.name);

  for (const keyword of ['while', 'for', 'catch', 'if', 'try', 'else', 'do', 'switch']) {
    assert.ok(!names.includes(keyword), `"${keyword}" must not be indexed as a symbol`);
  }

  // Genuine methods whose names merely start with a keyword stay indexed.
  assert.ok(names.includes('iffy'), 'a method named iffy must survive keyword filtering');
  assert.ok(names.includes('format'), 'a method named format must survive keyword filtering');
});

test('parser indexes declarations whose parameters wrap across lines', () => {
  // Regression: the declaration regexes required the whole `(...)` on one line, so
  // every wrapped signature was invisible to the graph — no symbol, hence no
  // definition lookup, no caller/callee tracing, no blast radius, no clone match.
  const ts = CodeParser.parseFile(
    'src/api.ts',
    [
      'export async function wrapped(', // 1
      '  alpha: string,', // 2
      '  beta: number,', // 3
      '): Promise<void> {', // 4
      '  return;', // 5
      '}', // 6
      '', // 7
      'export class Multi', // 8
      '  extends Base', // 9
      '  implements IFace {', // 10
      '  run(', // 11
      '    a: number,', // 12
      '  ): void {}', // 13
      '}', // 14
    ].join('\n')
  )!;

  const fn = ts.symbols.find((s) => s.name === 'wrapped');
  assert.ok(fn, 'multi-line function signature must be indexed');
  assert.strictEqual(fn!.kind, 'function');
  assert.strictEqual(fn!.startLine, 1);
  assert.strictEqual(fn!.endLine, 6, 'endLine must cover the whole body');
  assert.match(fn!.signature, /alpha: string/, 'signature must include wrapped parameters');

  const cls = ts.symbols.find((s) => s.name === 'Multi');
  assert.ok(cls, 'class with wrapped heritage clause must be indexed');

  const method = ts.symbols.find((s) => s.name === 'run');
  assert.ok(method, 'method with wrapped parameters must be indexed');
  assert.strictEqual(method!.endLine, 13);

  // Python: `def foo(\n a,\n b\n):`
  const py = CodeParser.parseFile(
    'api.py',
    ['def wrapped(', '    alpha,', '    beta,', '):', '    return alpha'].join('\n')
  )!;
  const pyFn = py.symbols.find((s) => s.name === 'wrapped');
  assert.ok(pyFn, 'multi-line python def must be indexed');
  assert.strictEqual(pyFn!.endLine, 5);

  // Go: `func Foo(\n a int,\n) error {`
  const go = CodeParser.parseFile('api.go', ['func Wrapped(', '  a int,', ') error {', '  return nil', '}'].join('\n'))!;
  assert.ok(go.symbols.find((s) => s.name === 'Wrapped'), 'multi-line go func must be indexed');

  // Rust: `pub fn wrapped(\n a: i32,\n) -> i32 {`
  const rs = CodeParser.parseFile('api.rs', ['pub fn wrapped(', '  a: i32,', ') -> i32 {', '  a', '}'].join('\n'))!;
  assert.ok(rs.symbols.find((s) => s.name === 'wrapped'), 'multi-line rust fn must be indexed');
});

// ---------------------------------------------------------------------------
// Import resolution — a single extension-less guess silently produced zero
// :IMPORTS edges, which broke TESTS_FOR and affected-test discovery
// ---------------------------------------------------------------------------

test('relative imports produce :IMPORTS edges, externals stay external', async () => {
  writeWs(GRAPH_WS, {
    'src/b.ts': 'export function helper() { return 1; }\n',
    'src/util/index.ts': 'export const U = 1;\n',
    'src/a.ts': [
      'import { helper } from "./b";',
      'import { U } from "./util";',
      'import { readFileSync } from "node:fs";',
      'export function main() { return helper() + U; }',
    ].join('\n'),
    'src/a.test.ts': 'import { main } from "./a";\n',
  });

  const port = 48410;
  const daemon = new KnowCodeDaemon({ workdir: GRAPH_WS, port });

  try {
    await daemon.start();
    await daemon.performFullIndex();

    const client = new KnowCodeRpcClient({ workdir: GRAPH_WS, port });

    // Local imports must resolve to real File nodes, including extension-less
    // specifiers and directory index files.
    const edges = await client.query(
      'MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS from, b.path AS to'
    );
    const pairs = (edges.data as any[]).map((r) => `${r.from}->${r.to}`).sort();
    assert.deepStrictEqual(pairs, [
      'src/a.test.ts->src/a.ts',
      'src/a.ts->src/b.ts',
      'src/a.ts->src/util/index.ts',
    ]);

    // A bare package specifier is still recorded as external.
    const external = await client.query(
      'MATCH (a:File)-[:IMPORTS]->(p:ExternalPackage) RETURN p.path AS to'
    );
    assert.deepStrictEqual((external.data as any[]).map((r) => r.to), ['node:fs']);

    // TESTS_FOR and affected-tests depend on those File->File edges.
    const tests = await client.call('affected_tests', { files: ['src/a.ts'] });
    assert.deepStrictEqual(tests, ['src/a.test.ts']);
  } finally {
    await daemon.stop();
    clean([GRAPH_WS]);
  }
});

// ---------------------------------------------------------------------------
// Imports that cross the build-output boundary (tests import compiled `lib/`)
// ---------------------------------------------------------------------------

test('imports of compiled output link back to the source tree', async () => {
  // TypeScript projects compile src/ -> lib/ and their tests import '../lib/x.js',
  // while only src/ is indexed. Without the build->source mapping those imports
  // resolved to nothing, so no TESTS_FOR edge existed and affected-test discovery
  // silently under-reported.
  writeWs(GRAPH_WS, {
    'src/math.ts': 'export function alpha(a: number, b: number) { return a + b; }\n',
    'tests/math.test.ts': 'import { alpha } from "../lib/math.js";\nalpha(1, 2);\n',
  });

  const port = 48480;
  const daemon = new KnowCodeDaemon({ workdir: GRAPH_WS, port });

  try {
    await daemon.start();
    await daemon.performFullIndex();
    const client = new KnowCodeRpcClient({ workdir: GRAPH_WS, port });

    const edges = await client.query(
      'MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS from, b.path AS to'
    );
    assert.deepStrictEqual(
      (edges.data as any[]).map((r) => `${r.from}->${r.to}`),
      ['tests/math.test.ts->src/math.ts'],
      'an import of ../lib/math.js must link to src/math.ts'
    );

    const tests = await client.call('affected_tests', { files: ['src/math.ts'] });
    assert.deepStrictEqual(tests, ['tests/math.test.ts']);
  } finally {
    await daemon.stop();
    clean([GRAPH_WS]);
  }
});

test('concurrent ingestion of one file cannot duplicate symbols', async () => {
  // Ingestion is delete-then-create with many awaits, so overlapping calls for the
  // same path interleaved and every CREATE survived: four concurrent calls for one
  // file produced 48 symbols and 4 File nodes instead of 3 and 1, and the
  // duplicates then appeared repeatedly in dead-code and explore output.
  const dbDir = resolve('/tmp/knowcode-ingest-race-db');
  clean([dbDir]);

  const mgr = new FalkorDBManager();
  const instance = await mgr.start({ dataDir: dbDir, preferredPort: 48520 });

  try {
    const graph = instance.client.selectGraph('knowcode-ingest-race');
    await initGraphSchema(graph);
    const repo = new KnowCodeRepository(graph);

    const parsed = CodeParser.parseFile(
      'src/a.ts',
      'export class A {\n  m(): void {}\n  n(): void {}\n}\n'
    )!;

    await Promise.all([1, 2, 3, 4].map(() => repo.ingestCodeFile(parsed)));

    const symbols = await repo.query('MATCH (s:Symbol) RETURN count(s) AS n');
    const files = await repo.query('MATCH (f:File) RETURN count(f) AS n');
    const dupes = await repo.query(
      'MATCH (s:Symbol) RETURN s.id AS id, count(*) AS n ORDER BY n DESC LIMIT 1'
    );

    assert.strictEqual(symbols.data[0].n, 3, `expected 3 symbols, got ${symbols.data[0].n}`);
    assert.strictEqual(files.data[0].n, 1, `expected 1 File node, got ${files.data[0].n}`);
    assert.strictEqual(dupes.data[0].n, 1, `symbol ${dupes.data[0].id} was duplicated`);
  } finally {
    await mgr.stop();
    clean([dbDir]);
  }
});

// ---------------------------------------------------------------------------
// autoStartDaemon
// ---------------------------------------------------------------------------

test('autoStartDaemon brings up a daemon for an idle workspace', async () => {
  writeWs(GRAPH_WS, { 'src/math.ts': 'export function alpha() { return 1; }\n' });

  const port = 48490;
  const client = new KnowCodeRpcClient({ workdir: GRAPH_WS, port });

  try {
    // Without the option the workspace reports itself offline.
    const offline = await executeKnowCodeTool('status', {}, GRAPH_WS, port);
    assert.match(offline.content, /Offline/, 'a fresh workspace has no daemon');

    // With it, a daemon is spawned from this package's own CLI and answers.
    const online = await executeKnowCodeTool('status', {}, GRAPH_WS, port, {
      autoStartDaemon: true,
      autoStartTimeoutMs: 25_000,
    });
    assert.doesNotMatch(online.content, /Offline/, `expected an online daemon, got: ${online.content}`);
    assert.strictEqual(await client.isDaemonAlive(), true);

    // The daemon's own log is kept so a failed start stays diagnosable.
    assert.ok(existsSync(join(GRAPH_WS, '.knowcode', 'serve.log')), 'serve.log must be written');

    // Indexing works through the auto-started daemon.
    const indexed = await client.triggerIndex();
    assert.ok(indexed.filesIndexed >= 1);
  } finally {
    // The daemon runs detached, so shut it down explicitly.
    await client.shutdown().catch(() => {});
    clean([GRAPH_WS]);
  }
});

// ---------------------------------------------------------------------------
// Orphan prevention: stop daemons this process spawned
// ---------------------------------------------------------------------------

test('stopOwnedDaemons stops only the daemons this process spawned', async () => {
  // Daemons are detached so they outlive a tool call, which is exactly why
  // anything not cleaned up on shutdown becomes a permanent orphan. Ownership must
  // be exact: a daemon the user started by hand must survive.
  const foreignWs = resolve('/tmp/knowcode-orphan-foreign');
  writeWs(GRAPH_WS, { 'src/math.ts': 'export function alpha() { return 1; }\n' });
  writeWs(foreignWs, { 'src/math.ts': 'export function beta() { return 2; }\n' });

  // Ownership recorded by an earlier test must not leak into this one.
  __resetOwnedDaemonsForTest();

  const ownedPort = 48540;
  const foreignPort = 48550;

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // A daemon this process did NOT spawn (started in-process, as `knowcode serve`
  // does). It lives in its own workspace so it cannot satisfy the auto-start probe
  // for GRAPH_WS and mask the spawn under test.
  const foreign = new KnowCodeDaemon({ workdir: foreignWs, port: foreignPort });
  const foreignInfo = await foreign.start({ withWatcher: false });

  try {
    const spawned = await ensureDaemonStarted(GRAPH_WS, ownedPort, { readyTimeoutMs: 25_000 });
    assert.strictEqual(spawned.started, true, 'auto-start must bring a daemon up');
    assert.strictEqual(spawned.spawned, true, 'this process must be the one that spawned it');

    const ownedPids = ownedDaemonPids();
    assert.strictEqual(ownedPids.length, 1, 'exactly one daemon must be owned');
    assert.ok(isAlive(ownedPids[0]), 'the owned daemon must be running');
    assert.ok(
      !ownedPids.includes(foreignInfo.pid),
      'a daemon started outside ensureDaemonStarted must not be claimed'
    );

    const stopped = stopOwnedDaemons();
    assert.deepStrictEqual(stopped, ownedPids, 'exactly the owned pids must be signalled');
    assert.deepStrictEqual(ownedDaemonPids(), [], 'ownership is cleared after stopping');

    // SIGTERM delivery is asynchronous.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isAlive(ownedPids[0])) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(isAlive(ownedPids[0]), false, 'the owned daemon must be gone');
    assert.strictEqual(isAlive(foreignInfo.pid), true, 'an unowned daemon must survive');
  } finally {
    await foreign.stop();
    __resetOwnedDaemonsForTest();
    clean([GRAPH_WS, foreignWs]);
  }
});

test('the plugin registers a disposal effect that stops owned daemons', () => {
  // DSH disposes the host fiber from its SIGINT/SIGTERM handler, so this effect is
  // the only place an orphaned daemon can be stopped.
  const effects: Array<() => void> = [];
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => {} },
    effect: (execute: () => () => void) => {
      effects.push(execute());
      return () => {};
    },
  } as any;

  apply(ctx, {});
  assert.strictEqual(effects.length, 1, 'exactly one disposal effect must be registered');

  __resetOwnedDaemonsForTest();
  assert.doesNotThrow(() => effects[0](), 'disposal must not throw with nothing owned');
});

// ---------------------------------------------------------------------------
// Single instance per workspace
// ---------------------------------------------------------------------------

test('only one daemon may serve a workspace at a time', async () => {
  // Without this, a second `knowcode serve` for the same workspace falls back to
  // another port and then overwrites daemon.json, leaving two HTTP servers, two
  // watchers and two embedded FalkorDB processes over the same `.rdb`.
  writeWs(GRAPH_WS, { 'src/math.ts': 'export function alpha() { return 1; }\n' });
  const dataDir = join(GRAPH_WS, '.knowcode');

  const first = new KnowCodeDaemon({ workdir: GRAPH_WS, port: 48560 });

  try {
    const firstInfo = await first.start({ withWatcher: false });

    const lock = readServeLock(dataDir);
    assert.ok(lock, 'the guard must be recorded');
    assert.strictEqual(lock!.pid, firstInfo.pid);
    assert.strictEqual(lock!.port, firstInfo.port);

    // A second daemon for the same workspace must refuse to start.
    const second = new KnowCodeDaemon({ workdir: GRAPH_WS, port: 48570 });
    await assert.rejects(
      () => second.start({ withWatcher: false }),
      (err: any) => err instanceof DaemonAlreadyRunningError,
      'a second daemon for one workspace must be refused'
    );

    // The refusal must not have disturbed the incumbent.
    assert.strictEqual((await new KnowCodeRpcClient({ workdir: GRAPH_WS, port: firstInfo.port }).isDaemonAlive()), true);
  } finally {
    await first.stop();
  }

  // Stopping releases the guard so the workspace can be served again.
  assert.strictEqual(readServeLock(dataDir), null, 'the guard must be released on stop');

  const third = new KnowCodeDaemon({ workdir: GRAPH_WS, port: 48580 });
  try {
    const info = await third.start({ withWatcher: false });
    assert.ok(info.port > 0, 'a workspace must be servable again after its daemon stops');
  } finally {
    await third.stop();
    clean([GRAPH_WS]);
  }
});

test('a guard left by a dead daemon is reclaimed', async () => {
  // A crashed daemon must never block its workspace forever.
  writeWs(GRAPH_WS, { 'src/math.ts': 'export function alpha() { return 1; }\n' });
  const dataDir = join(GRAPH_WS, '.knowcode');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'serve.lock'),
    JSON.stringify({ pid: 999_999, port: 1, workdir: GRAPH_WS, startedAt: 'stale' })
  );

  const daemon = new KnowCodeDaemon({ workdir: GRAPH_WS, port: 48590 });
  try {
    const info = await daemon.start({ withWatcher: false });
    assert.ok(info.port > 0, 'a stale guard must not block startup');
    assert.strictEqual(readServeLock(dataDir)!.pid, info.pid, 'the guard must be replaced');
  } finally {
    await daemon.stop();
    clean([GRAPH_WS]);
  }
});

// ---------------------------------------------------------------------------
// Daemon identity and port selection
// ---------------------------------------------------------------------------

test('a second workspace falls back to a free port instead of failing', async () => {
  clean([IDENTITY_A, IDENTITY_B]);
  mkdirSync(IDENTITY_A, { recursive: true });
  mkdirSync(IDENTITY_B, { recursive: true });

  const requested = 48420;
  const a = new KnowCodeDaemon({ workdir: IDENTITY_A, port: requested });
  const b = new KnowCodeDaemon({ workdir: IDENTITY_B, port: requested });

  try {
    await a.start({ withWatcher: false });
    const infoB = await b.start({ withWatcher: false });

    assert.notStrictEqual(
      infoB.port,
      requested,
      'the second workspace must not try to share the taken port'
    );

    // The actual port is recorded so clients of each workspace find their own daemon.
    const recorded = JSON.parse(readFileSync(join(IDENTITY_B, '.knowcode', 'daemon.json'), 'utf8'));
    assert.strictEqual(recorded.port, infoB.port);
    assert.strictEqual(recorded.workdir, IDENTITY_B);
  } finally {
    await a.stop();
    await b.stop();
    clean([IDENTITY_A, IDENTITY_B]);
  }
});

test('a client refuses a daemon that serves a different workspace', async () => {
  clean([IDENTITY_A, IDENTITY_FOREIGN]);
  mkdirSync(IDENTITY_A, { recursive: true });
  mkdirSync(IDENTITY_FOREIGN, { recursive: true });

  const port = 48430;
  const daemon = new KnowCodeDaemon({ workdir: IDENTITY_A, port });

  try {
    await daemon.start({ withWatcher: false });

    // Own workspace: accepted.
    const own = new KnowCodeRpcClient({ workdir: IDENTITY_A, port });
    assert.strictEqual(await own.isDaemonAlive(), true);
    assert.strictEqual((await own.getStatus()).workdir, IDENTITY_A);

    // Another workspace pointing at the same port must be rejected rather than
    // silently served that workspace's graph.
    const foreign = new KnowCodeRpcClient({ workdir: IDENTITY_FOREIGN, port });
    assert.strictEqual(
      await foreign.isDaemonAlive(),
      false,
      'a daemon for another workspace must not count as alive'
    );
    await assert.rejects(() => foreign.getStatus(), /serves .*not/s);
  } finally {
    await daemon.stop();
    clean([IDENTITY_A, IDENTITY_FOREIGN]);
  }
});
