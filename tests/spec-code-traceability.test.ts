import test from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { FalkorDBManager } from '../lib/db/falkor-manager.js';
import { initGraphSchema } from '../lib/db/schema.js';
import { KnowCodeRepository } from '../lib/db/client.js';
import { DocParser } from '../lib/parser/doc-parser.js';

const TEST_DIR = '/tmp/knowcode-traceability-test';

test('Bidirectional Feature Spec <-> Code Flow Traceability in FalkorDB', async () => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }

  const mgr = new FalkorDBManager();
  const instance = await mgr.start({ dataDir: TEST_DIR, preferredPort: 48199 });
  const graph = instance.client.selectGraph('knowcode-traceability');

  try {
    await initGraphSchema(graph);
    const repo = new KnowCodeRepository(graph);

    // 1. Ingest Code Symbols
    await repo.ingestCodeFile({
      path: 'src/controllers/auth.ts',
      language: 'typescript',
      lineCount: 30,
      hash: 'auth-ctrl-hash',
      size: 600,
      isTest: false,
      symbols: [
        {
          id: 'src/controllers/auth.ts:AuthController.login',
          name: 'login',
          qname: 'AuthController.login',
          kind: 'method',
          file: 'src/controllers/auth.ts',
          startLine: 10,
          endLine: 25,
          signature: 'public async login(req: Request, res: Response)',
          isExported: true,
        },
      ],
      imports: [],
      calls: [],
      heritage: [],
    });

    await repo.ingestCodeFile({
      path: 'src/services/auth.ts',
      language: 'typescript',
      lineCount: 40,
      hash: 'auth-srv-hash',
      size: 800,
      isTest: false,
      symbols: [
        {
          id: 'src/services/auth.ts:AuthService.authenticate',
          name: 'authenticate',
          qname: 'AuthService.authenticate',
          kind: 'method',
          file: 'src/services/auth.ts',
          startLine: 12,
          endLine: 35,
          signature: 'public async authenticate(credentials: Credentials)',
          isExported: true,
        },
      ],
      imports: [],
      calls: [],
      heritage: [],
    });

    await repo.ingestCodeFile({
      path: 'src/security/hasher.ts',
      language: 'typescript',
      lineCount: 20,
      hash: 'hasher-hash',
      size: 400,
      isTest: false,
      symbols: [
        {
          id: 'src/security/hasher.ts:PasswordHasher.verify',
          name: 'verify',
          qname: 'PasswordHasher.verify',
          kind: 'method',
          file: 'src/security/hasher.ts',
          startLine: 5,
          endLine: 15,
          signature: 'public verify(password: string, hash: string): boolean',
          isExported: true,
        },
      ],
      imports: [],
      calls: [],
      heritage: [],
    });

    // 2. Ingest Call Relationships (Execution Flow)
    await repo.ingestCalls([
      {
        callerId: 'src/controllers/auth.ts:AuthController.login',
        file: 'src/controllers/auth.ts',
        line: 15,
        calleeName: 'authenticate',
      },
      {
        callerId: 'src/services/auth.ts:AuthService.authenticate',
        file: 'src/services/auth.ts',
        line: 20,
        calleeName: 'verify',
      },
    ]);

    // 3. Parse and Ingest Spec Document
    const specMarkdown = `
# Feature: User Authentication & JWT Flow

## 1. Login with Credentials
When a client submits credentials, the request enters \`AuthController.login\`.
The controller validates inputs and delegates to the authentication service.
`;
    const parsedDoc = DocParser.parseDoc('docs/specs/auth.md', specMarkdown)!;
    assert.ok(parsedDoc);
    await repo.ingestDocFile(parsedDoc);

    // ==========================================
    // TEST DIRECTION 1: Spec -> Code Flow
    // ==========================================
    const flowResult = await repo.findCodeFlowForFeature('User Authentication', 3);
    assert.strictEqual(flowResult.specFile, 'docs/specs/auth.md');
    assert.ok(flowResult.entrySymbols.some((s) => s.qname === 'AuthController.login'));

    // Verify downstream flow traversal caught authenticate and verify
    assert.ok(flowResult.executionFlow.some((n) => n.name === 'authenticate'));
    assert.ok(flowResult.executionFlow.some((n) => n.name === 'verify'));
    assert.ok(flowResult.mermaidDiagram.includes('login --> authenticate'));
    assert.ok(flowResult.mermaidDiagram.includes('authenticate --> verify'));

    // ==========================================
    // TEST DIRECTION 2: Code Symbol -> Spec Features
    // ==========================================
    // Querying leaf helper "verify": should trace back upstream to "AuthController.login" -> "User Authentication"
    const specFeatures = await repo.findSpecFeaturesForSymbol('verify', true);
    assert.strictEqual(specFeatures.symbolName, 'verify');
    assert.ok(specFeatures.indirectFeatures.length >= 1);
    const feature = specFeatures.indirectFeatures[0];
    assert.strictEqual(feature.specFile, 'docs/specs/auth.md');
    assert.ok(feature.featureName.includes('User Authentication') || feature.featureName.includes('Login with Credentials'));
  } finally {
    await mgr.stop();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }
});
