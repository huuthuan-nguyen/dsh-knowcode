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
import { isIndexablePath, isNonTextPath, decideIndexing } from '../lib/server/indexable.js';

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

test('static methods are indexed, and regex braces do not hide the class body', () => {
  // Two defects in one shape. `public static name(...)` did not match the member
  // pattern, so every static method was invisible — and this codebase's utility
  // classes are almost entirely static. Separately, a regex literal with unbalanced
  // braces (`/[^{\n]*\{([\s\S]*?)\}/`) pushed the class-body depth to 2 for the
  // rest of the file, hiding every method after it.
  const parsed = CodeParser.parseFile(
    'src/util.ts',
    [
      'export class Util {', // 1
      '  public static alpha(a: string): number { return 1; }', // 2
      '  private static async beta(): Promise<void> {}', // 3
      '  static gamma(): void {}', // 4
      '  private readonly re = /[^{\n]*\\{([\\s\\S]*?)\\}/g;', // 5
      '  public static delta(): void {}', // 6
      '  instance(): void {}', // 7
      '}', // 8
    ].join('\n')
  )!;

  const names = parsed.symbols.filter((s) => s.kind === 'method').map((s) => s.name);
  for (const expected of ['alpha', 'beta', 'gamma', 'delta', 'instance']) {
    assert.ok(names.includes(expected), `method ${expected} must be indexed, got ${JSON.stringify(names)}`);
  }

  // Visibility is taken from whichever modifier was used.
  assert.strictEqual(parsed.symbols.find((s) => s.name === 'alpha')!.visibility, 'public');
  assert.strictEqual(parsed.symbols.find((s) => s.name === 'beta')!.visibility, 'private');
  assert.strictEqual(parsed.symbols.find((s) => s.name === 'delta')!.visibility, 'public');
});

test('interface members are indexed and never become calls', () => {
  // Members give a generated trait its methods and let an implementing method be
  // recognised as satisfying a contract, which keeps it out of dead-code reports.
  const parsed = CodeParser.parseFile(
    'src/shapes.ts',
    [
      'export interface Shape {', // 1
      '  area(): number;', // 2
      '  readonly name?: string;', // 3
      '}', // 4
      'export class Circle implements Shape {', // 5
      '  area(): number { return 1; }', // 6
      '}', // 7
    ].join('\n')
  )!;

  const qnames = parsed.symbols.map((s) => s.qname).sort();
  assert.deepStrictEqual(qnames, [
    'Circle',
    'Circle.area',
    'Shape',
    'Shape.area',
    'Shape.name',
  ]);
  assert.deepStrictEqual(parsed.calls, [], 'a member signature is not a call');
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
// What gets indexed: extensions and size
// ---------------------------------------------------------------------------

test('database and binary files are never read or indexed', () => {
  // Indexing always excluded them through its extension allowlist, but the watcher
  // accepted anything chokidar reported and read it in full before discovering it
  // had nothing to parse — so a SQLite database being written by a running
  // application was read and hashed on every change, only to be discarded.
  for (const p of [
    'data.db',
    'data.db-wal',
    'data.db-shm',
    'data.db-journal',
    'app.sqlite',
    'app.sqlite-wal',
    'notes.sqlite3',
    'notes.sqlite3-shm',
    'cache.duckdb',
    'dump.rdb',
    'native.node',
    'lib.dylib',
    'bundle.wasm',
    'archive.zip',
    'photo.png',
    'font.woff2',
    'compiled.pyc',
  ]) {
    assert.strictEqual(isIndexablePath(p), false, `${p} must not be indexable`);
    assert.strictEqual(isNonTextPath(p), true, `${p} must be recognised as non-text`);
  }

  // Real source and documentation stay indexable.
  for (const p of ['src/a.ts', 'src/a.jsx', 'main.py', 'main.go', 'lib.rs', 'README.md', 'notes.txt']) {
    assert.strictEqual(isIndexablePath(p), true, `${p} must stay indexable`);
  }

  // Ignored directories win regardless of extension.
  assert.strictEqual(isIndexablePath('node_modules/x/index.js'), false);
});

test('multi-line return types survive into the stored signature', () => {
  // `gatherParens` stopped at the parameter list's closing paren, so a return type
  // that wrapped onto following lines was erased: every such signature was stored
  // as `…): Promise<` and the porting contract lost the real contract.
  const parsed = CodeParser.parseFile(
    'src/api.ts',
    [
      'export class Repo {', // 1
      '  public async explore(limit: number = 25): Promise<{', // 2
      '    files: Array<{ path: string }>;', // 3
      '    total: number;', // 4
      '  }> {', // 5
      '    return { files: [], total: 0 };', // 6
      '  }', // 7
      '  async search(q: string): Promise<', // 8
      '    Array<{ title: string }>', // 9
      '  > {', // 10
      '    return [];', // 11
      '  }', // 12
      '}', // 13
    ].join('\n')
  )!;

  const explore = parsed.symbols.find((s) => s.name === 'explore')!;
  assert.match(explore.signature, /Promise<\{ files: Array<\{ path: string \}>; total: number; \}>/);
  assert.strictEqual(explore.endLine, 7, 'the body must still end at its own brace');

  const search = parsed.symbols.find((s) => s.name === 'search')!;
  assert.match(search.signature, /Promise< Array<\{ title: string \}> >/);
  assert.strictEqual(search.endLine, 12);
});

test('comments are not mined for calls', () => {
  // Call extraction ran over the line with strings stripped but comments intact, so
  // a note reading "Comma-delimited (and wrapped)…" produced a call to `delimited`
  // and every dependency list collected stray words from prose.
  const parsed = CodeParser.parseFile(
    'src/a.ts',
    [
      '// Comma-delimited (and wrapped) so containment matches whole names only.',
      '/* By naming convention (entryPoints) and referencedSymbols */',
      'export function real(a: number) {',
      '  return helper(a);',
      '}',
    ].join('\n')
  )!;

  const names = parsed.calls.map((c) => c.calleeName);
  for (const word of ['delimited', 'convention', 'entryPoints', 'referencedSymbols']) {
    assert.ok(!names.includes(word), `"${word}" from a comment must not be a call`);
  }
  assert.ok(names.includes('helper'), 'a real call must survive');
});

test('imports written inside a template literal are not extracted', () => {
  // Test fixtures hold sample source in template literals. Declarations were already
  // skipped there, but import matching still used the raw line, so fixtures produced
  // imports of `./base` and `./logger` that then became external packages.
  const parsed = CodeParser.parseFile(
    'tests/fixture.test.ts',
    [
      'import { real } from "./real";',
      'const fixture = `',
      "import { BaseService } from './base';",
      '`;',
      'export function useIt() { return real(); }',
    ].join('\n')
  )!;

  assert.deepStrictEqual(parsed.imports.map((i) => i.importedPath), ['./real']);
});

test('locals assigned from a library binding are recorded as aliases', () => {
  // `const cache = CacheBuilder.newBuilder().build()` then `cache.put(...)` is
  // library usage, but the receiver is `cache`. Without this signal a usage slice
  // could only see calls made directly on the imported binding.
  const parsed = CodeParser.parseFile(
    'src/a.ts',
    [
      "import { CacheBuilder } from 'guava';",
      "const cache = CacheBuilder.newBuilder().build();",
      'export function use() { return cache.get(1); }',
    ].join('\n')
  )!;

  assert.deepStrictEqual(parsed.libraryAliases, ['cache|guava']);
});

test('heritage to a supertype outside the workspace is still recorded', async () => {
  // `class X extends Error` produced no edge at all, because the ingestion query
  // required an indexed `:Symbol` for the supertype and simply matched nothing.
  writeWs(GRAPH_WS, { 'src/e.ts': 'export class MyError extends Error {}\n' });

  const port = 48610;
  const daemon = new KnowCodeDaemon({ workdir: GRAPH_WS, port });

  try {
    await daemon.start();
    await daemon.performFullIndex();
    const client = new KnowCodeRpcClient({ workdir: GRAPH_WS, port });

    const rows = await client.query(
      'MATCH (c:Symbol)-[r:EXTENDS]->(p) RETURN c.name AS child, p.name AS parent, labels(p) AS labels'
    );
    const edge = (rows.data as any[]).find((r) => r.child === 'MyError');
    assert.ok(edge, 'extends Error must be recorded, not silently dropped');
    assert.strictEqual(edge.parent, 'Error');
    assert.deepStrictEqual(edge.labels, ['ExternalType']);
  } finally {
    await daemon.stop();
    clean([GRAPH_WS]);
  }
});

test('a usage slice counts only calls made on the library', async () => {
  // The slice returned every call made anywhere in a file that imports the library,
  // so `falkordb` reported 71 "methods" including `map`, `join`, `Set` and this
  // project's own helpers.
  writeWs(GRAPH_WS, { 'src/uses.ts': '// placeholder\n' });

  const port = 48620;
  const daemon = new KnowCodeDaemon({ workdir: GRAPH_WS, port });

  try {
    await daemon.start();
    await daemon.performFullIndex();
    const repo = (daemon as any).repo as KnowCodeRepository;

    await repo.ingestCodeFile({
      path: 'src/uses.ts',
      language: 'typescript',
      lineCount: 10,
      hash: 'h',
      size: 100,
      isTest: false,
      libraryAliases: ['client|mylib'],
      symbols: [
        {
          id: 'src/uses.ts:run',
          name: 'run',
          qname: 'run',
          kind: 'function',
          file: 'src/uses.ts',
          startLine: 1,
          endLine: 10,
          signature: 'function run()',
          isExported: true,
        },
      ],
      calls: [],
      imports: [],
      heritage: [],
    });
    await repo.ingestImports([
      {
        sourceFile: 'src/uses.ts',
        importedPath: 'mylib',
        specifiers: ['createClient'],
        resolvedCandidates: [],
      },
    ]);
    await repo.ingestCalls([
      // On the library, through the imported binding.
      { callerId: 'src/uses.ts:run', file: 'src/uses.ts', line: 2, calleeName: 'createClient', calleeQName: 'createClient' },
      // On a local derived from the library.
      { callerId: 'src/uses.ts:run', file: 'src/uses.ts', line: 3, calleeName: 'fetch', calleeQName: 'client.fetch' },
      // Nothing to do with the library.
      { callerId: 'src/uses.ts:run', file: 'src/uses.ts', line: 4, calleeName: 'map', calleeQName: 'items.map' },
      { callerId: 'src/uses.ts:run', file: 'src/uses.ts', line: 5, calleeName: 'localHelper', calleeQName: 'localHelper' },
    ]);

    const slice = await repo.extractThirdPartyUsageSlice('mylib', 'rust');
    assert.deepStrictEqual(
      slice.invokedMethods.map((m) => m.name).sort(),
      ['createClient', 'fetch'],
      'only calls on the library or its derived locals may be counted'
    );
  } finally {
    await daemon.stop();
    clean([GRAPH_WS]);
  }
});


test('no database binary is ever read, and schema comes only from repository text', async () => {
  // Two guarantees in one place:
  //  - a running database's files are never opened by the indexer or the watcher;
  //  - schema/DDL knowledge is derived only from text committed to the repository.
  const artifacts: Array<[string, Buffer]> = [
    ['app.sqlite', Buffer.from('SQLite format 3\0' + 'A'.repeat(400))],
    ['app.sqlite-wal', Buffer.from('\0\0\0\0wal')],
    ['data.db', Buffer.from('SQLite format 3\0more')],
    ['dump.rdb', Buffer.from('REDIS0011\0\0\0')],
    ['appendonly.aof', Buffer.from('*2\r\n$6\r\nSELECT\r\n')],
    ['users.ibd', Buffer.from('\0'.repeat(300))],
    ['orders.frm', Buffer.from('\0\0\0'.repeat(50))],
    ['collection-1.wt', Buffer.from('\0\0WiredTiger')],
    ['_0.cfs', Buffer.from('\0'.repeat(200))],
    ['segment.si', Buffer.from('\0'.repeat(100))],
    ['000003.sst', Buffer.from('\0'.repeat(150))],
  ];

  const files: Record<string, string | Buffer> = {};
  for (const [name, buf] of artifacts) files[name] = buf;
  // A binary payload behind an allowed extension: only the NUL-byte sniff catches it.
  files['sneaky.txt'] = Buffer.from('\0\0\0binarypayload');
  // Repository text that carries schema knowledge.
  files['migrations/001_init.sql'] =
    'CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL\n);\n';
  files['prisma/schema.prisma'] =
    'datasource db {\n  provider = "postgresql"\n}\n\nmodel Post {\n  id Int @id\n  title String\n}\n';
  files['proto/user.proto'] = 'message User {\n  string id = 1;\n}\n';
  files['src/models.ts'] =
    'import mongoose from "mongoose";\nexport const AccountSchema = new mongoose.Schema({\n  owner: { type: String, required: true },\n});\n';
  files['openapi.json'] = JSON.stringify({
    openapi: '3.0.0',
    components: { schemas: { Payment: { type: 'object', properties: { amount: { type: 'number' } } } } },
  });
  files['src/app.ts'] = 'export function boot() { return 1; }\n';

  writeWs(GRAPH_WS, files as Record<string, string>);

  // Unit level: every artifact is refused before a read.
  for (const [name] of artifacts) {
    const decision = decideIndexing(join(GRAPH_WS, name), 4 * 1024 * 1024, name);
    assert.strictEqual(decision.ok, false, `${name} must never be read`);
  }
  assert.strictEqual(
    decideIndexing(join(GRAPH_WS, 'sneaky.txt'), 4 * 1024 * 1024, 'sneaky.txt').reason,
    'binary',
    'a binary payload behind a .txt name must be detected'
  );

  const port = 48630;
  const daemon = new KnowCodeDaemon({ workdir: GRAPH_WS, port });

  try {
    await daemon.start();
    await daemon.performFullIndex();
    const client = new KnowCodeRpcClient({ workdir: GRAPH_WS, port });

    // No File node may exist for a database artifact.
    const fileRows = await client.query('MATCH (f:File) RETURN f.path AS p');
    const paths = (fileRows.data as any[]).map((r) => r.p).sort();
    assert.deepStrictEqual(
      paths,
      ['src/app.ts', 'src/models.ts'],
      `only source files may be indexed, got: ${JSON.stringify(paths)}`
    );

    // Schema knowledge comes from the repository text above.
    const contracts = await client.query('MATCH (c:ContractEntity) RETURN c.name AS n ORDER BY n');
    assert.deepStrictEqual(
      (contracts.data as any[]).map((r) => r.n).sort(),
      ['Payment', 'User'],
      'contracts come from the OpenAPI document and the .proto file'
    );

    const containers = await client.query(
      'MATCH (sc:StorageContainer) RETURN sc.name AS n, sc.engine AS e ORDER BY n'
    );
    const byName = new Map((containers.data as any[]).map((r) => [r.n, r.e]));
    assert.strictEqual(byName.get('users'), 'sql', 'SQL DDL from the migration');
    assert.strictEqual(byName.get('Post'), 'sql', 'Prisma model');
    assert.strictEqual(byName.get('accounts'), 'mongodb', 'Mongoose model in a .ts source file');
    assert.strictEqual(
      byName.has('openapi'),
      false,
      'an OpenAPI document must not be mistaken for an Elasticsearch mapping'
    );
  } finally {
    await daemon.stop();
    clean([GRAPH_WS]);
  }
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
// Auto-start: the first query must see a settled graph
// ---------------------------------------------------------------------------

test('the call that auto-starts a daemon reports it, and sees a settled index', async () => {
  // A daemon answers /status as soon as its port binds, which is before it has
  // reconciled the graph. The first tool call used to query a partially built index:
  // measured at 120 of 300 files, so `explore` and friends answered from a fraction of
  // the workspace and looked authoritative doing it.
  const files: Record<string, string> = {};
  for (let i = 0; i < 300; i++) {
    files[`src/m${i}.ts`] = `export function fn${i}(a: number) { return helper${i}(a); }\nexport function helper${i}(a: number) { return a + ${i}; }\n`;
  }
  writeWs(GRAPH_WS, files);

  const port = 48650;
  const client = new KnowCodeRpcClient({ workdir: GRAPH_WS, port });

  try {
    const first = await executeKnowCodeTool('status', {}, GRAPH_WS, port, {
      autoStartDaemon: true,
      indexTimeoutMs: 60_000,
    });
    const second = await executeKnowCodeTool('status', {}, GRAPH_WS, port, { autoStartDaemon: true });

    const count = (text: string) => {
      const m = /\*\*Symbols\*\*: (\d+)/.exec(text);
      return m ? Number(m[1]) : -1;
    };

    assert.ok(count(first.content) > 0, 'the first call must see a non-empty graph');
    assert.strictEqual(
      count(first.content),
      count(second.content),
      'the first call must see the same settled graph as the second'
    );

    // The note is attached once, to the call that paid for the start.
    assert.match(first.content, /KnowCode daemon auto-started for/, 'the triggering call must say so');
    assert.match(first.content, /indexed \d+ files, \d+ symbols/, 'and report what it cost');
    assert.doesNotMatch(second.content, /auto-started/, 'a later call must not repeat the note');

    // `sync` issued while the daemon is reconciling must not surface an error.
    const sync = await executeKnowCodeTool('sync', {}, GRAPH_WS, port, { autoStartDaemon: true });
    assert.doesNotMatch(sync.content, /Indexing already in progress|KnowCode Error/, 'a concurrent sync must not fail');
    assert.match(sync.content, /Indexed \d+ files/);
  } finally {
    await client.shutdown().catch(() => {});
    clean([GRAPH_WS]);
  }
});

// ---------------------------------------------------------------------------
// Idle timeout
// ---------------------------------------------------------------------------

test('a daemon with an idle budget stops itself, and one without does not', async () => {
  writeWs(GRAPH_WS, { 'src/a.ts': 'export function a() { return 1; }\n' });

  const withBudget = 48660;
  const withoutBudget = 48661;

  const serves = async (port: number): Promise<boolean> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(600) });
      return res.ok;
    } catch {
      return false;
    }
  };

  try {
    // A small budget, and no requests: nothing should keep it alive.
    const idle = new KnowCodeDaemon({ workdir: GRAPH_WS, port: withBudget, idleTimeoutMs: 1_500 });
    const info = await idle.start({ withWatcher: false });
    await idle.reconcileStartup({});

    // Wait without polling: a `/status` probe is itself a request, and the daemon
    // counts any contact as activity, so polling would keep it alive forever.
    await new Promise((r) => setTimeout(r, 5_000));
    assert.strictEqual(await serves(info.port), false, 'an idle daemon must stop itself');
    assert.strictEqual(existsSync(join(GRAPH_WS, '.knowcode', 'daemon.json')), false, 'and clean up its record');
    assert.strictEqual(existsSync(join(GRAPH_WS, '.knowcode', 'serve.lock')), false, 'and release its guard');

    // No budget: unchanged behaviour.
    const busy = new KnowCodeDaemon({ workdir: GRAPH_WS, port: withoutBudget, idleTimeoutMs: 0 });
    const busyInfo = await busy.start({ withWatcher: false });
    await busy.reconcileStartup({});
    await new Promise((r) => setTimeout(r, 2_500));
    assert.strictEqual(await serves(busyInfo.port), true, 'without a budget a daemon must not stop');
    await busy.stop();
  } finally {
    clean([GRAPH_WS]);
  }
});

test('activity resets the idle budget', async () => {
  writeWs(GRAPH_WS, { 'src/a.ts': 'export function a() { return 1; }\n' });

  const port = 48662;
  const daemon = new KnowCodeDaemon({ workdir: GRAPH_WS, port, idleTimeoutMs: 1_500 });

  try {
    const info = await daemon.start({ withWatcher: false });
    await daemon.reconcileStartup({});

    // Keep asking for longer than the budget; each request must reset the clock.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${info.port}/status`, { signal: AbortSignal.timeout(600) });
      assert.strictEqual(res.ok, true, 'a daemon answering requests must stay up');
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await daemon.stop();
    clean([GRAPH_WS]);
  }
});

// ---------------------------------------------------------------------------
// Parser robustness: one file must never be able to abort a pass
// ---------------------------------------------------------------------------

test('a parenthesised Python import does not break parsing or indexing', async () => {
  // `from x import (` opened a specifier list that continues for several lines. Only
  // the first line was read, so the `(` itself became a specifier and the alias
  // matcher built `new RegExp('\\b(\\b')` from it — an invalid pattern that threw and
  // took the entire indexing pass, and the daemon, down with it.
  const parens = 'from renderer.models import (\n    ActionCommandData,\n    BoardData,\n)\n\n\ndef render():\n    return ActionCommandData()\n';
  const parsed = CodeParser.parseFile('renderer/__init__.py', parens);
  assert.ok(parsed, 'the file must parse');
  assert.deepStrictEqual(parsed!.imports[0].specifiers, ['ActionCommandData', 'BoardData']);
  assert.ok(
    parsed!.imports.every((imp) => imp.specifiers.every((spec) => /^\w+$/.test(spec))),
    'only identifiers may be recorded as specifiers'
  );

  // And the same file must not stop a whole workspace from being indexed.
  writeWs(GRAPH_WS, {
    'renderer/__init__.py': parens,
    'src/a.ts': 'export function alpha() { return 1; }\n',
  });

  const port = 48670;
  const daemon = new KnowCodeDaemon({ workdir: GRAPH_WS, port });
  try {
    await daemon.start();
    const summary = await daemon.performFullIndex();
    assert.strictEqual(summary.skippedFiles ?? 0, 0, 'no file may be skipped');

    const client = new KnowCodeRpcClient({ workdir: GRAPH_WS, port });
    const files = await client.query('MATCH (f:File) RETURN f.path AS p ORDER BY p');
    assert.deepStrictEqual(
      (files.data as any[]).map((r) => r.p),
      ['renderer/__init__.py', 'src/a.ts'],
      'the Python file must be indexed alongside the TypeScript one'
    );
  } finally {
    await daemon.stop();
    clean([GRAPH_WS]);
  }
});

test('the parser does not throw on awkward inputs', () => {
  // The invariant that mattered: a single file could abort an entire pass. Every one
  // of these used to be a candidate for an exception somewhere in the parser.
  const cases: Array<[string, string]> = [
    ['a.py', 'from x import (\n    a,\n    b,\n)\n'],
    ['b.py', 'from x import (\n'],
    ['c.py', 'import *\nfrom . import ()\n'],
    ['d.ts', 'export class A {\n  private re = /[^{\\n]*\\{([\\s\\S]*?)\\}/g;\n  m(): void {}\n}\n'],
    ['e.ts', 'export function f( {\n'],
    ['f.ts', 'export interface I { a(): void; }\nexport class C implements I { a(): void {} }\n'],
    ['g.ts', 'const s = `unterminated template\n'],
    ['h.ts', '// comment with ) and } and {\nexport function g() { return h(); }\n'],
    ['i.ts', 'import { } from "";\nimport x from ;\n'],
    ['j.ts', 'export const t = (a) => { return a > b < c; };\n'],
    ['k.ts', '/* unterminated block comment\nexport function k() {}\n'],
  ];

  for (const [file, source] of cases) {
    assert.doesNotThrow(() => {
      const parsed = CodeParser.parseFile(file, source);
      // A parsed file must survive the alias and signature passes too.
      if (parsed) JSON.stringify(parsed.libraryAliases ?? []);
    }, `${file} must not throw`);
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
