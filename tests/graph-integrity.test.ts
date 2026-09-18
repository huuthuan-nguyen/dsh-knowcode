import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { KnowCodeDaemon } from '../lib/server/daemon.js';
import { KnowCodeRpcClient } from '../lib/server/client-rpc.js';
import { CodeParser } from '../lib/parser/code-parser.js';
import { executeKnowCodeTool } from '../lib/tools/dispatcher.js';

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
