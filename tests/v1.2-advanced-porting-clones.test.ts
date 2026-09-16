import test from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { FalkorDBManager } from '../lib/db/falkor-manager.js';
import { initGraphSchema } from '../lib/db/schema.js';
import { KnowCodeRepository } from '../lib/db/client.js';
import { normalizeFunctionBody, calculateDiceSimilarity } from '../lib/parser/clone-detector.js';

const TEST_DIR = '/tmp/knowcode-v12-test';

test('AST Token Normalizer & Clone Detector Unit Test', () => {
  const fn1 = `
    function processUser(user, active) {
      if (!active) return null;
      const id = user.getId();
      return saveRecord(id, user);
    }
  `;

  const fn2 = `
    function handleCustomer(customer, isValid) {
      if (!isValid) return null;
      const cid = customer.getId();
      return saveRecord(cid, customer);
    }
  `;

  const norm1 = normalizeFunctionBody(fn1);
  const norm2 = normalizeFunctionBody(fn2);

  // Both functions must have the exact same structural hash despite variable renaming
  assert.strictEqual(norm1.structuralHash, norm2.structuralHash);

  const dice = calculateDiceSimilarity(norm1.normalized, norm2.normalized);
  assert.strictEqual(dice, 1.0);
});

test('v1.2 Cross-Paradigm Blueprint, 3rd-Party Slice & Clone Hunter', async () => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }

  const mgr = new FalkorDBManager();
  const instance = await mgr.start({ dataDir: TEST_DIR, preferredPort: 48198 });
  const graph = instance.client.selectGraph('knowcode-v12');

  try {
    await initGraphSchema(graph);
    const repo = new KnowCodeRepository(graph);

    // 1. Ingest Java/OOP class with inheritance
    await repo.ingestCodeFile({
      path: 'src/UserManager.java',
      language: 'java',
      lineCount: 80,
      hash: 'user-manager-hash',
      size: 1500,
      isTest: false,
      symbols: [
        {
          id: 'src/UserManager.java:IService',
          name: 'IService',
          qname: 'IService',
          kind: 'interface',
          file: 'src/UserManager.java',
          startLine: 1,
          endLine: 5,
          signature: 'public interface IService',
          isExported: true,
        },
        {
          id: 'src/UserManager.java:UserManager',
          name: 'UserManager',
          qname: 'UserManager',
          kind: 'class',
          file: 'src/UserManager.java',
          startLine: 7,
          endLine: 40,
          signature: 'public class UserManager implements IService',
          isExported: true,
        },
      ],
      imports: [
        {
          sourceFile: 'src/UserManager.java',
          importedPath: 'com.google.common.cache.Cache',
          specifiers: ['Cache'],
        },
      ],
      calls: [
        {
          callerId: 'src/UserManager.java:UserManager',
          file: 'src/UserManager.java',
          line: 15,
          calleeName: 'get',
        },
        {
          callerId: 'src/UserManager.java:UserManager',
          file: 'src/UserManager.java',
          line: 20,
          calleeName: 'put',
        },
      ],
      heritage: [
        {
          subSymbolId: 'UserManager',
          superSymbolName: 'IService',
          kind: 'implements',
        },
      ],
    });
    await repo.ingestImports([
      {
        sourceFile: 'src/UserManager.java',
        importedPath: 'com.google.common.cache.Cache',
        specifiers: ['Cache'],
      },
    ]);
    await repo.ingestCalls([
      {
        callerId: 'src/UserManager.java:UserManager',
        file: 'src/UserManager.java',
        line: 15,
        calleeName: 'get',
      },
      {
        callerId: 'src/UserManager.java:UserManager',
        file: 'src/UserManager.java',
        line: 20,
        calleeName: 'put',
      },
    ]);
    await repo.ingestHeritage([
      {
        subSymbolId: 'UserManager',
        superSymbolName: 'IService',
        kind: 'implements',
      },
    ]);

    // 2. Ingest two cloned functions in different files with different variable names
    const cloneCode1 = `
      function fetchRecord(recordId, isEnabled) {
        if (!isEnabled) return null;
        return queryDb(recordId);
      }
    `;
    const cloneCode2 = `
      function loadEntity(entityKey, isAllowed) {
        if (!isAllowed) return null;
        return queryDb(entityKey);
      }
    `;

    const norm1 = normalizeFunctionBody(cloneCode1);
    const norm2 = normalizeFunctionBody(cloneCode2);

    await repo.ingestCodeFile({
      path: 'src/serviceA.ts',
      language: 'typescript',
      lineCount: 20,
      hash: 'service-a-hash',
      size: 400,
      isTest: false,
      symbols: [
        {
          id: 'src/serviceA.ts:fetchRecord',
          name: 'fetchRecord',
          qname: 'fetchRecord',
          kind: 'function',
          file: 'src/serviceA.ts',
          startLine: 1,
          endLine: 6,
          signature: 'function fetchRecord(recordId: string, isEnabled: boolean)',
          structuralHash: norm1.structuralHash,
          isExported: true,
        },
      ],
      imports: [],
      calls: [],
      heritage: [],
    });

    await repo.ingestCodeFile({
      path: 'src/serviceB.ts',
      language: 'typescript',
      lineCount: 20,
      hash: 'service-b-hash',
      size: 400,
      isTest: false,
      symbols: [
        {
          id: 'src/serviceB.ts:loadEntity',
          name: 'loadEntity',
          qname: 'loadEntity',
          kind: 'function',
          file: 'src/serviceB.ts',
          startLine: 1,
          endLine: 6,
          signature: 'function loadEntity(entityKey: string, isAllowed: boolean)',
          structuralHash: norm2.structuralHash,
          isExported: true,
        },
      ],
      imports: [],
      calls: [],
      heritage: [],
    });

    // TEST 1: Cross-Paradigm Blueprint (OOP UserManager -> Rust)
    const blueprint = await repo.generateCrossParadigmBlueprint('UserManager', 'rust');
    assert.strictEqual(blueprint.symbolName, 'UserManager');
    assert.strictEqual(blueprint.targetLanguage, 'rust');
    assert.ok(blueprint.structs.length >= 1);
    assert.ok(blueprint.traits.some((t) => t.name === 'IService'));
    assert.ok(blueprint.ownershipGuidelines.length >= 2);
    assert.ok(blueprint.idiomaticSkeleton.includes('pub struct UserManager'));

    // TEST 1B: Reverse Paradigm Blueprint (Rust/Functional -> Java OOP)
    const javaBlueprint = await repo.generateCrossParadigmBlueprint('UserManager', 'java');
    assert.strictEqual(javaBlueprint.targetLanguage, 'java');
    assert.ok(javaBlueprint.idiomaticSkeleton.includes('public class UserManager implements IService'));
    assert.ok(javaBlueprint.ownershipGuidelines.some((g) => g.includes('ENCAPSULATION')));

    // TEST 2: 3rd-Party Usage Slice (com.google.common.cache)
    const slice = await repo.extractThirdPartyUsageSlice('com.google.common.cache', 'rust');
    assert.strictEqual(slice.libraryPrefix, 'com.google.common.cache');
    assert.ok(slice.importedSymbols.includes('Cache'));
    assert.ok(slice.suggestedPolyfillSpec.estimatedLinesToImplement <= 60);

    // TEST 2B: 3rd-Party Target Ecosystem Package Recommendation (Guava -> Rust moka)
    assert.ok(slice.recommendedPackages && slice.recommendedPackages.length >= 1);
    const rec = slice.recommendedPackages[0];
    assert.strictEqual(rec.packageName, 'moka');
    assert.strictEqual(rec.ecosystem, 'crates.io');
    assert.ok(rec.installCommand.includes('cargo add moka'));
    assert.ok(rec.methodMappings.some((m) => m.sourceMethod === 'put' && m.targetMethod === 'insert'));

    // TEST 3: Duplicate Clone Detection (fetchRecord and loadEntity)
    const clones = await repo.findSimilarFunctions();
    assert.ok(clones.length >= 1);
    assert.strictEqual(clones[0].cloneType, 'Type-2 (Variable Renamed)');
    assert.strictEqual(clones[0].similarityPercent, 95);
  } finally {
    await mgr.stop();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }
});
