import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { KnowCodeDaemon } from '../lib/server/daemon.js';
import { KNOWCODE_OUTPUT_SCHEMA } from '../lib/index.js';
import { executeKnowCodeTool } from '../lib/tools/dispatcher.js';

const TEST_WS = resolve('/tmp/knowcode-output-contract');

/**
 * The harness validates every tool's returned value against its declared
 * `output.schema` (`packages/core/tools/src/index.ts` -> `createSuccessResult`)
 * and throws `ToolOutputError` / `INVALID_TOOL_OUTPUT` on any violation.
 *
 * `scripts`-side reproduction of the real failure this suite guards against:
 *
 *   tool "knowcode_check_index_health_and_stats" returned invalid output:
 *   "value.raw" is not a declared property (additionalProperties: false)
 *
 * The dispatcher used to attach a `raw` payload that no caller ever read.
 */
let validateJsonSchemaValue: ((schema: unknown, value: unknown, path?: string) => string[]) | undefined;

test('load the harness validator used for output checking', async () => {
  try {
    const harness: any = await import('@deepseek-ai/dsh-tools');
    validateJsonSchemaValue = harness.validateJsonSchemaValue;
  } catch {
    // Harness not linked (CI without the monorepo) — the structural checks below still run.
  }
  assert.ok(true);
});

/** Assert a value satisfies the declared output schema. */
function expectValidOutput(label: string, value: unknown): void {
  // Structural check that needs no harness dependency.
  assert.strictEqual(typeof value, 'object', `${label}: value must be an object`);
  assert.notStrictEqual(value, null, `${label}: value must not be null`);

  const record = value as Record<string, unknown>;
  const declared = Object.keys(KNOWCODE_OUTPUT_SCHEMA.properties);

  assert.deepStrictEqual(
    Object.keys(record).sort(),
    [...declared].sort(),
    `${label}: value keys must be exactly the schema's declared properties ` +
      `(the schema sets additionalProperties: false, so any extra key makes the ` +
      `harness throw INVALID_TOOL_OUTPUT)`
  );

  assert.strictEqual(record.kind, 'knowcode', `${label}: kind must be the const 'knowcode'`);
  assert.strictEqual(typeof record.action, 'string', `${label}: action must be a string`);
  assert.strictEqual(typeof record.content, 'string', `${label}: content must be a string`);

  // Authoritative check, identical to what the harness runs.
  if (validateJsonSchemaValue) {
    const violations = validateJsonSchemaValue(KNOWCODE_OUTPUT_SCHEMA, record, 'value');
    assert.deepStrictEqual(violations, [], `${label}: harness validator reported ${violations.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Schema <-> interface drift guard
// ---------------------------------------------------------------------------

test('KNOWNCODE_OUTPUT_SCHEMA declares exactly the ExecutionResult fields', () => {
  assert.strictEqual(KNOWCODE_OUTPUT_SCHEMA.type, 'object');
  assert.strictEqual(
    KNOWCODE_OUTPUT_SCHEMA.additionalProperties,
    false,
    'the schema must stay strict so undeclared fields fail loudly'
  );
  assert.deepStrictEqual(
    Object.keys(KNOWCODE_OUTPUT_SCHEMA.properties).sort(),
    ['action', 'content', 'kind'],
    'schema properties must match the ExecutionResult interface'
  );
  assert.deepStrictEqual(
    [...KNOWCODE_OUTPUT_SCHEMA.required].sort(),
    ['action', 'content', 'kind']
  );
});

// ---------------------------------------------------------------------------
// Offline branches (no daemon): must still produce schema-valid values
// ---------------------------------------------------------------------------

test('offline tool responses satisfy the output schema', async () => {
  const workdir = resolve('/tmp/knowcode-output-contract-offline');
  if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });

  try {
    // No daemon is listening on this port, so every branch returns a notice.
    for (const action of ['status', 'sync', 'explore', 'search_symbols']) {
      const value = await executeKnowCodeTool(action, { pattern: 'Foo' }, workdir, 48299);
      expectValidOutput(`offline ${action}`, value);
    }
  } finally {
    if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Live daemon: every return branch shape must satisfy the output schema
// ---------------------------------------------------------------------------

test('live tool responses satisfy the output schema', async () => {
  if (existsSync(TEST_WS)) rmSync(TEST_WS, { recursive: true, force: true });
  mkdirSync(join(TEST_WS, 'src'), { recursive: true });
  mkdirSync(join(TEST_WS, 'docs'), { recursive: true });

  writeFileSync(
    join(TEST_WS, 'src/math.ts'),
    `
export interface Adder { add(a: number, b: number): number }

export class Calculator implements Adder {
  add(a: number, b: number): number {
    return this.total(a, b);
  }
  private total(a: number, b: number): number {
    return a + b;
  }
}

export function computeTotal(items: number[]): number {
  const calc = new Calculator();
  let total = 0;
  for (const n of items) total = calc.add(total, n);
  return total;
}
`
  );

  writeFileSync(
    join(TEST_WS, 'docs/design.md'),
    `
# Calculator Design
The \`Calculator\` class implements \`Adder\`.
## Standards
- Computations MUST NOT overflow.
`
  );

  const port = 48290;
  const daemon = new KnowCodeDaemon({ workdir: TEST_WS, port });

  try {
    await daemon.start();
    await daemon.performFullIndex();

    // One entry per distinct return-branch shape in the dispatcher.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['status', {}],
      ['sync', {}],
      ['explore', { limit: 10 }],
      ['symbol_definition', { name: 'computeTotal' }],
      ['blast_radius', { symbol: 'total', depth: 2 }],
      ['callers', { symbol: 'total' }],
      ['callees', { symbol: 'computeTotal' }],
      ['detect_cycles', {}],
      ['affected_tests', { files: ['src/math.ts'] }],
      ['porting_contract', { symbol: 'Calculator' }],
      ['call_path', { fromSymbol: 'computeTotal', toSymbol: 'total' }],
      ['subtypes', { symbol: 'Adder' }],
      ['search_symbols', { pattern: 'calc' }],
      ['unused_symbols', { limit: 10 }],
      ['git_diff_impact', {}],
      ['cross_paradigm_blueprint', { symbol: 'Calculator', targetLanguage: 'rust' }],
      ['third_party_slice', { libraryPrefix: 'falkordb' }],
      ['similar_functions', { minLines: 3 }],
      ['spec_code_flow', { query: 'Calculator Design' }],
      ['symbol_spec_features', { symbol: 'Calculator' }],
      ['contract_storage_mapping', { contractEntity: 'Missing' }],
      ['storage_migration_impact', { storageContainer: 'users', attribute: 'email' }],
      ['knowledge_search', { query: 'Calculator' }],
      ['knowledge_doc', { pathOrTitle: 'design.md' }],
      ['cypher', { cypher: 'MATCH (s:Symbol) RETURN s.name LIMIT 3' }],
    ];

    for (const [action, args] of cases) {
      const value = await executeKnowCodeTool(action, args, TEST_WS, port);
      expectValidOutput(`live ${action}`, value);
    }

    // Unknown action hits the default branch.
    expectValidOutput('live unknown', await executeKnowCodeTool('definitely_not_an_action', {}, TEST_WS, port));
  } finally {
    await daemon.stop();
    if (existsSync(TEST_WS)) rmSync(TEST_WS, { recursive: true, force: true });
  }
});
