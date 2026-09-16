import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { KnowCodeDaemon } from '../lib/server/daemon.js';
import { KnowCodeRpcClient } from '../lib/server/client-rpc.js';

const TEST_WORKSPACE = resolve('/tmp/knowcode-daemon-test');

test('KnowCodeDaemon and RPC Client test', async () => {
  if (existsSync(TEST_WORKSPACE)) {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }
  mkdirSync(join(TEST_WORKSPACE, 'src'), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, 'docs'), { recursive: true });

  // Create sample code file
  writeFileSync(
    join(TEST_WORKSPACE, 'src/math.ts'),
    `
export function add(a: number, b: number): number {
  return a + b;
}

export function computeTotal(items: number[]): number {
  let total = 0;
  for (const n of items) {
    total = add(total, n);
  }
  return total;
}
    `
  );

  // Create sample doc file
  writeFileSync(
    join(TEST_WORKSPACE, 'docs/math.md'),
    `
# Math Utilities
The \`computeTotal\` function calculates the sum of all elements.
## Standards
- Numerical computations MUST NOT overflow.
    `
  );

  const daemonPort = 48190;
  const daemon = new KnowCodeDaemon({
    workdir: TEST_WORKSPACE,
    port: daemonPort,
  });

  try {
    const startRes = await daemon.start();
    assert.strictEqual(startRes.port, daemonPort);

    // Client connects
    const client = new KnowCodeRpcClient({ workdir: TEST_WORKSPACE, port: daemonPort });
    const isAlive = await client.isDaemonAlive();
    assert.strictEqual(isAlive, true);

    // Perform index
    const indexRes = await client.triggerIndex(TEST_WORKSPACE);
    assert.ok(indexRes.filesIndexed >= 2);
    assert.ok(indexRes.symbolsIndexed >= 2);

    // Check status
    const status = await client.getStatus();
    assert.strictEqual(status.daemonRunning, true);
    assert.strictEqual(status.totalFiles, 2);
    assert.strictEqual(status.totalCodeFiles, 1);
    assert.strictEqual(status.totalDocFiles, 1);
    assert.ok(status.totalSymbols >= 2);

    // Check RPC: explore
    const explore = await client.call('explore');
    assert.ok(explore.files.length >= 1);

    // Check RPC: callers
    const callers = await client.call('callers', { symbol: 'add' });
    assert.ok(callers.length >= 1);
    assert.strictEqual(callers[0].callerName, 'computeTotal');

    // Check RPC: blast_radius
    const blast = await client.call('blast_radius', { symbol: 'add', depth: 2 });
    assert.ok(blast);
    assert.strictEqual(blast.totalAffectedCallers, 1);

    // Check RPC: knowledge_search
    const kb = await client.call('knowledge_search', { query: 'Math' });
    assert.ok(kb.length >= 1);

    // Test Cypher query
    const cypherRes = await client.query('MATCH (s:Symbol {name: "add"}) RETURN s.name AS name');
    assert.strictEqual(cypherRes.data[0].name, 'add');
  } finally {
    // Shutdown daemon
    await daemon.stop();
    if (existsSync(TEST_WORKSPACE)) {
      rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    }
  }
});
