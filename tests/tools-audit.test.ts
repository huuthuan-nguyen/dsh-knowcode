import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { KnowCodeDaemon } from '../lib/server/daemon.js';
import { executeKnowCodeTool } from '../lib/tools/dispatcher.js';

/**
 * End-to-end audit of **every** tool in the catalog.
 *
 * Each tool is exercised against a fixture whose correct answer is known in advance,
 * so one that merely returns plausible-looking text still fails. Targeted suites
 * missed defects this catches: the call graph, for instance, silently dropped every
 * call written on the same line as its enclosing declaration, which left callers,
 * callees, blast radius, call paths and diff impact all reporting zero.
 */

const WS = resolve('/tmp/knowcode-tools-audit');
const PORT = 48640;

async function tool(action: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await executeKnowCodeTool(action, args, WS, PORT);
  return result.content ?? '';
}

function buildFixture(): void {
  rmSync(WS, { recursive: true, force: true });
  const write = (rel: string, body: string) => {
    const full = join(WS, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  };

  // A three-hop call cycle written *on one line each*, which is the shape that used
  // to lose its calls entirely: alpha -> beta -> gamma -> alpha.
  write('src/a.ts', "import { beta } from './b';\nexport function alpha() { return beta(); }\n");
  write('src/b.ts', "import { gamma } from './c';\nexport function beta() { return gamma(); }\n");
  write('src/c.ts', "import { alpha } from './a';\nexport function gamma() { return alpha(); }\n");

  // An interface with two implementations. Members are signatures, never calls.
  write(
    'src/shapes.ts',
    [
      'export interface Shape {',
      '  area(): number;',
      '}',
      '',
      'export class Circle implements Shape {',
      '  area(): number { return 1; }',
      '}',
      '',
      'export class Square implements Shape {',
      '  area(): number { return 2; }',
      '}',
    ].join('\n') + '\n'
  );

  // One exported and one private symbol, neither called: only the private one is a
  // dead-code candidate under the tool's stated contract.
  write(
    'src/unused.ts',
    'export function neverCalledAnywhere() { return 0; }\nfunction privateDeadCode() { return 1; }\n'
  );

  // Two structurally identical functions, for clone detection.
  const twin = 'export function {NAME}(value: number) {\n  const doubled = value * 2;\n  return doubled + {NAME}Offset;\n}\n';
  write(
    'src/twins.ts',
    'const twinOffset = 1;\n' + twin.replace(/\{NAME\}/g, 'firstTwin') + twin.replace(/\{NAME\}/g, 'secondTwin')
  );

  // Third-party usage: one call on the imported binding, one on a local derived from
  // it, and one unrelated array method that must not be counted.
  write(
    'src/uses-lib.ts',
    [
      "import { createClient } from 'fakelib';",
      'export function connect() {',
      '  const client = createClient();',
      '  return client.fetch(1);',
      '}',
      'export function unrelated() {',
      '  return [1, 2].map((n) => n * 2);',
      '}',
    ].join('\n') + '\n'
  );

  write('tests/a.test.ts', "import { alpha } from '../src/a';\nexport function checksAlpha() { return alpha(); }\n");

  write(
    'docs/spec.md',
    ['# Ordering Feature', '', 'The ordering flow starts at `alpha` and ends at `Shape`.', '', '## Rules', '- Orders MUST be idempotent.'].join('\n') + '\n'
  );

  write('schema/orders.sql', 'CREATE TABLE orders (\n  id SERIAL PRIMARY KEY,\n  total INTEGER NOT NULL\n);\n');
  write('proto/order.proto', 'message Order {\n  string id = 1;\n  int32 total = 2;\n}\n');

  const git = (...args: string[]) => execFileSync('git', args, { cwd: WS, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'audit@example.com');
  git('config', 'user.name', 'Audit');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  // An uncommitted edit inside `alpha`'s body.
  write('src/a.ts', "import { beta } from './b';\nexport function alpha() {\n  const guard = 1;\n  return beta() + guard;\n}\n");
}

test('every tool in the catalog works against a known fixture', async () => {
  buildFixture();

  const daemon = new KnowCodeDaemon({ workdir: WS, port: PORT });
  await daemon.start();
  await daemon.performFullIndex();

  try {
    // 1 — status
    const status = await tool('knowcode_check_index_health_and_stats');
    assert.match(status, /Daemon.*Online/s);
    assert.match(status, /\*\*Symbols\*\*: [1-9]/);
    assert.match(status, /\*\*Call Edges\*\*: [1-9]/);

    // 2 — sync
    assert.match(await tool('knowcode_trigger_incremental_reindex'), /Indexed \d+ files and \d+ symbols/);

    // 3 — explore
    const overview = await tool('code_get_architecture_overview', { limit: 10 });
    assert.match(overview, /Central Hub Symbols/);
    assert.match(overview, /`(alpha|beta|gamma)`/, 'a called symbol must rank as a hub');
    assert.doesNotMatch(overview, /`area`/, 'interface members are not calls, so not hubs');

    // 4 — symbol definition
    const definition = await tool('code_get_symbol_definition_and_signature', { name: 'alpha' });
    assert.match(definition, /Symbol: `alpha`/);
    assert.match(definition, /src\/a\.ts/);
    assert.match(definition, /lines \d+-\d+/);

    // 5 — callers / 6 — callees : proves single-line calls are captured
    assert.match(await tool('code_find_function_callers', { symbol: 'beta' }), /`alpha`/);
    assert.match(await tool('code_find_function_callees', { symbol: 'alpha' }), /`beta`/);
    assert.match(await tool('code_find_function_callers', { symbol: 'alpha' }), /`gamma`/, 'gamma calls alpha');

    // 7 — blast radius
    const blast = await tool('code_analyze_refactor_blast_radius', { symbol: 'alpha', depth: 5 });
    assert.match(blast, /Risk.*RISK/s);
    assert.doesNotMatch(blast, /Total Affected Callers\*\*: 0/, 'the cycle gives alpha real callers');
    assert.match(blast, /gamma/, 'the transitive chain must be reported');

    // 8 — circular dependencies
    const cycles = await tool('code_detect_circular_dependencies');
    assert.match(cycles, /Circular Dependencies Detected/);
    // The tool reports import cycles between files, not symbol names.
    assert.match(cycles, /src\/(a|b|c)\.ts/, 'the cycle members must be named');
    assert.match(cycles, /src\/a\.ts/);
    assert.match(cycles, /src\/b\.ts/);

    // 9 — affected tests
    assert.match(await tool('code_find_affected_test_files', { files: ['src/a.ts'] }), /tests\/a\.test\.ts/);

    // 10 — call path
    const path = await tool('code_find_call_path_between_symbols', { fromSymbol: 'alpha', toSymbol: 'gamma' });
    assert.doesNotMatch(path, /No call path found/);
    assert.match(path, /beta/, 'the intermediate hop must appear');

    // 11 — subtypes
    const subtypes = await tool('code_find_implementations_and_subtypes', { symbol: 'Shape' });
    assert.match(subtypes, /Circle/);
    assert.match(subtypes, /Square/);

    // 12 — symbol search
    assert.match(await tool('code_search_symbols_by_pattern', { pattern: 'Circ' }), /Circle/);

    // 13 — dead code: the private symbol only
    const unused = await tool('code_find_unused_dead_symbols', { limit: 25 });
    assert.match(unused, /privateDeadCode/);
    assert.doesNotMatch(unused, /neverCalledAnywhere/, 'exported symbols are not dead code under this contract');

    // 14 — git diff impact
    const diff = await tool('code_analyze_git_diff_semantic_impact', {});
    assert.match(diff, /src\/a\.ts/);
    assert.match(diff, /alpha/);
    assert.doesNotMatch(diff, /\*\*Incoming Callers at Risk\*\*: 0/, 'alpha has callers in the fixture');

    // 15 — porting contract: supertypes are a porting dependency
    const porting = await tool('code_extract_symbol_porting_contract', { symbol: 'Circle' });
    assert.match(porting, /Porting Contract: `Circle`/);
    assert.match(porting, /area/, 'enclosed members must be listed');
    assert.match(porting, /Shape/, 'the implemented interface must be reported as a dependency');

    // 16 — cross-paradigm blueprint
    const blueprint = await tool('code_generate_cross_paradigm_porting_blueprint', {
      symbol: 'Circle',
      targetLanguage: 'rust',
    });
    assert.match(blueprint, /Cross-Paradigm Blueprint: `Circle`/);
    assert.match(blueprint, /Shape/, 'the interface becomes a trait');
    assert.doesNotMatch(blueprint, /CircleErrorError/, 'an Error suffix must not be doubled');

    // 17 — third-party slice: only calls on the library
    const slice = await tool('code_extract_third_party_usage_slice', { libraryPrefix: 'fakelib', targetLanguage: 'rust' });
    assert.match(slice, /createClient/);
    assert.match(slice, /fetch/, 'a call on a local derived from the library counts');
    assert.doesNotMatch(slice, /\bmap\b/, 'an unrelated array method must not be counted');

    // 18 — clone detection
    const clones = await tool('code_find_similar_duplicate_functions', { minLines: 3 });
    assert.match(clones, /firstTwin/);
    assert.match(clones, /secondTwin/);

    // 19 — spec to code flow
    const flow = await tool('spec_find_code_flow_for_feature', { query: 'Ordering Feature', flowDepth: 2 });
    assert.match(flow, /Ordering Feature/);
    assert.match(flow, /alpha/);
    assert.doesNotMatch(flow, /`(walk|clean|start|line)`/, 'prose words must not become entry points');

    // 20 — code to spec
    const features = await tool('code_find_spec_features_for_symbol', { symbol: 'alpha' });
    assert.match(features, /spec\.md/);

    // 21 — knowledge search
    assert.match(await tool('knowledge_search_documentation_and_rules', { query: 'Ordering' }), /spec\.md/);

    // 22 — knowledge doc, by bare file name as well as by path
    const doc = await tool('knowledge_get_document_content_and_rules', { pathOrTitle: 'spec.md' });
    assert.match(doc, /Ordering Feature/);
    assert.match(doc, /Rules/);
    assert.match(await tool('knowledge_get_document_content_and_rules', { pathOrTitle: 'docs/spec.md' }), /Ordering Feature/);

    // 23 — raw cypher
    assert.match(await tool('knowcode_execute_custom_cypher_query', { cypher: 'MATCH (s:Symbol) RETURN count(s) AS n' }), /"n":\s*[1-9]/);

    // 24 — contract to storage, from the repository's .proto and .sql
    const mapping = await tool('schema_map_contract_to_storage', { contractEntity: 'Order' });
    assert.doesNotMatch(mapping, /not found in graph/, 'the .proto contract must have been ingested');
    assert.match(mapping, /orders/, 'the .sql table must have been ingested');
    assert.match(mapping, /total/);

    // 25 — storage migration impact
    const migration = await tool('schema_analyze_storage_migration_impact', {
      storageContainer: 'orders',
      attribute: 'total',
      action: 'drop',
    });
    assert.match(migration, /orders/);
    assert.match(migration, /total/);
  } finally {
    await daemon.stop();
    rmSync(WS, { recursive: true, force: true });
  }
});
