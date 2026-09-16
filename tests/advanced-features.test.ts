import test from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { FalkorDBManager } from '../lib/db/falkor-manager.js';
import { initGraphSchema } from '../lib/db/schema.js';
import { KnowCodeRepository } from '../lib/db/client.js';
import { parseUnifiedDiff } from '../lib/parser/git-diff-parser.js';

const TEST_DIR = '/tmp/knowcode-v11-test';

test('Git Unified Diff Parser test', () => {
  const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index abc..def 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,4 +10,6 @@
 function validateToken() {
+  console.log("validating");
+  checkExpiry();
 }
diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,5 @@
+export function brandNew() {
+  return 42;
+}
`;

  const parsed = parseUnifiedDiff(sampleDiff);
  assert.strictEqual(parsed.length, 2);

  assert.strictEqual(parsed[0].file, 'src/auth.ts');
  assert.strictEqual(parsed[0].changeType, 'modified');
  assert.strictEqual(parsed[0].changedLines[0].start, 10);
  assert.strictEqual(parsed[0].changedLines[0].end, 15);

  assert.strictEqual(parsed[1].file, 'src/new-file.ts');
  assert.strictEqual(parsed[1].changeType, 'added');
  assert.strictEqual(parsed[1].changedLines[0].start, 1);
  assert.strictEqual(parsed[1].changedLines[0].end, 5);
});

test('Advanced Features: Call Path, Subtypes, Symbol Search, Dead Code in FalkorDB', async () => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }

  const mgr = new FalkorDBManager();
  const instance = await mgr.start({ dataDir: TEST_DIR, preferredPort: 48195 });
  const graph = instance.client.selectGraph('knowcode-v11');

  try {
    await initGraphSchema(graph);
    const repo = new KnowCodeRepository(graph);

    const chainCalls = [
      {
        callerId: 'src/chain.ts:stepA',
        file: 'src/chain.ts',
        line: 5,
        calleeName: 'stepB',
      },
      {
        callerId: 'src/chain.ts:stepB',
        file: 'src/chain.ts',
        line: 15,
        calleeName: 'stepC',
      },
    ];

    // 1. Ingest files and symbols with multi-hop call path: A -> B -> C
    await repo.ingestCodeFile({
      path: 'src/chain.ts',
      language: 'typescript',
      lineCount: 50,
      hash: 'chain-hash',
      symbols: [
        {
          name: 'stepA',
          qname: 'stepA',
          kind: 'function',
          file: 'src/chain.ts',
          startLine: 1,
          endLine: 10,
          signature: 'function stepA(): void',
          isExported: true,
        },
        {
          name: 'stepB',
          qname: 'stepB',
          kind: 'function',
          file: 'src/chain.ts',
          startLine: 12,
          endLine: 20,
          signature: 'function stepB(): void',
          isExported: true,
        },
        {
          name: 'stepC',
          qname: 'stepC',
          kind: 'function',
          file: 'src/chain.ts',
          startLine: 22,
          endLine: 30,
          signature: 'function stepC(): void',
          isExported: true,
        },
        {
          name: 'deadHelper',
          qname: 'deadHelper',
          kind: 'function',
          file: 'src/chain.ts',
          startLine: 32,
          endLine: 40,
          signature: 'function deadHelper(): void',
          isExported: false, // unexported and no callers
        },
      ],
      imports: [],
      calls: chainCalls,
      heritage: [],
    });
    await repo.ingestCalls(chainCalls);

    const repoHeritage = [
      {
        subSymbolId: 'SqlRepo',
        superSymbolName: 'IRepository',
        kind: 'implements' as const,
      },
    ];

    // 2. Ingest class inheritance: SqlRepo IMPLEMENTS IRepository
    await repo.ingestCodeFile({
      path: 'src/repo.ts',
      language: 'typescript',
      lineCount: 40,
      hash: 'repo-hash',
      symbols: [
        {
          name: 'IRepository',
          qname: 'IRepository',
          kind: 'interface',
          file: 'src/repo.ts',
          startLine: 1,
          endLine: 10,
          signature: 'interface IRepository { find(): void }',
          isExported: true,
        },
        {
          name: 'SqlRepo',
          qname: 'SqlRepo',
          kind: 'class',
          file: 'src/repo.ts',
          startLine: 12,
          endLine: 30,
          signature: 'class SqlRepo implements IRepository',
          isExported: true,
        },
      ],
      imports: [],
      calls: [],
      heritage: repoHeritage,
    });
    await repo.ingestHeritage(repoHeritage);

    // Test 1: findCallPath (shortestPath from stepA to stepC)
    const callPath = await repo.findCallPath('stepA', 'stepC');
    assert.strictEqual(callPath.found, true);
    assert.strictEqual(callPath.hops, 2);
    assert.strictEqual(callPath.path[0].name, 'stepA');
    assert.strictEqual(callPath.path[1].name, 'stepB');
    assert.strictEqual(callPath.path[2].name, 'stepC');

    // Test 2: findSubtypesAndImplementations (SqlRepo implements IRepository)
    const subtypes = await repo.findSubtypesAndImplementations('IRepository');
    assert.strictEqual(subtypes.length, 1);
    assert.strictEqual(subtypes[0].name, 'SqlRepo');
    assert.strictEqual(subtypes[0].relationship, 'IMPLEMENTS');

    // Test 3: searchSymbols by pattern (substring 'step')
    const searchRes = await repo.searchSymbols('step');
    assert.strictEqual(searchRes.length, 3);
    const names = searchRes.map((s) => s.name);
    assert.ok(names.includes('stepA'));
    assert.ok(names.includes('stepB'));
    assert.ok(names.includes('stepC'));

    // Test 4: findUnusedSymbols (deadHelper should be flagged)
    const unused = await repo.findUnusedSymbols();
    assert.ok(unused.some((u) => u.name === 'deadHelper'));
  } finally {
    await mgr.stop();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }
});
