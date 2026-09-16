import test from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FalkorDBManager } from '../lib/db/falkor-manager.js';
import { initGraphSchema } from '../lib/db/schema.js';
import { KnowCodeRepository } from '../lib/db/client.js';
import { CodeParser } from '../lib/parser/code-parser.js';
import { DocParser } from '../lib/parser/doc-parser.js';
import { LinkEngine } from '../lib/parser/link-engine.js';

const TEST_DIR = resolve('/tmp/knowcode-test-db');

test('FalkorDB embedded engine lifecycle and graph operations', async (t) => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }

  const manager = new FalkorDBManager();
  const instance = await manager.start({
    dataDir: TEST_DIR,
    preferredPort: 6395,
  });

  assert.ok(instance);
  assert.ok(instance.port > 0);
  assert.strictEqual(instance.isEmbedded, true);

  const graph = instance.client.selectGraph('knowcode_test');
  await initGraphSchema(graph);
  const repo = new KnowCodeRepository(graph);

  // 1. Ingest code file A (Service)
  const codeA = `
export class AuthService {
  public validateToken(token: string): boolean {
    return token.length > 5;
  }
}
  `;
  const parsedA = CodeParser.parseFile('src/auth.ts', codeA);
  assert.ok(parsedA);
  await repo.ingestCodeFile(parsedA);

  // 2. Ingest code file B (Controller calling Service)
  const codeB = `
import { AuthService } from './auth';

export class AuthController {
  private service = new AuthService();

  public handleLogin(token: string): boolean {
    return this.service.validateToken(token);
  }
}
  `;
  const parsedB = CodeParser.parseFile('src/controller.ts', codeB);
  assert.ok(parsedB);
  await repo.ingestCodeFile(parsedB);
  await repo.ingestImports(parsedB.imports);
  await repo.ingestCalls(parsedB.calls);

  // 3. Ingest Test file
  const codeTest = `
import { AuthController } from './controller';

describe('AuthController', () => {
  it('handles login', () => {
    const c = new AuthController();
    c.handleLogin('abc');
  });
});
  `;
  const parsedTest = CodeParser.parseFile('src/controller.test.ts', codeTest);
  assert.ok(parsedTest);
  await repo.ingestCodeFile(parsedTest);
  await repo.ingestImports(parsedTest.imports);
  await repo.ingestCalls(parsedTest.calls);

  // 4. Ingest Doc file
  const doc = `
# Authentication Guide
All login tokens must be validated with \`validateToken\`.
## Rules
- Passwords MUST be hashed.
  `;
  const parsedDoc = DocParser.parseDoc('docs/auth.md', doc);
  assert.ok(parsedDoc);
  await repo.ingestDocFile(parsedDoc);

  // 5. Link Engine
  const linker = new LinkEngine(repo);
  const linkStats = await linker.linkAll();
  assert.ok(linkStats.linkedDocs >= 1);

  // 6. Test Query: getSymbolDefinition
  const sym = await repo.getSymbolDefinition('validateToken');
  assert.ok(sym);
  assert.strictEqual(sym.name, 'validateToken');
  assert.strictEqual(sym.file, 'src/auth.ts');

  // 7. Test Query: getCallers
  const callers = await repo.getCallers('validateToken');
  assert.ok(callers.length >= 1);
  assert.strictEqual(callers[0].callerName, 'handleLogin');

  // 8. Test Query: getBlastRadius
  const blast = await repo.getBlastRadius('validateToken', 3);
  assert.ok(blast);
  assert.strictEqual(blast.targetSymbol, 'validateToken');
  assert.ok(blast.affectedFiles.includes('src/controller.ts'));
  assert.ok(blast.affectedTests.includes('src/controller.test.ts'));

  // 9. Test Query: getPortingContract
  const contract = await repo.getPortingContract('AuthService');
  assert.ok(contract);
  assert.strictEqual(contract.symbolName, 'AuthService');
  assert.strictEqual(contract.language, 'typescript');

  // 10. Test Query: searchKnowledge
  const kbResults = await repo.searchKnowledge('Authentication');
  assert.ok(kbResults.length >= 1);

  // 11. Test Stats
  const stats = await repo.getStats();
  assert.strictEqual(stats.totalFiles, 3);
  assert.strictEqual(stats.totalDocs, 1);
  assert.ok(stats.totalSymbols >= 3);

  // Clean shutdown
  await graph.delete();
  await manager.stop();
  rmSync(TEST_DIR, { recursive: true, force: true });
});
