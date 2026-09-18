import { resolve } from 'node:path';
import { KnowCodeRpcClient } from '../server/client-rpc.js';

export async function runQueryCommand(cypher: string, targetDir: string = '.', options: { port?: number } = {}): Promise<void> {
  const workdir = resolve(targetDir);
  const client = new KnowCodeRpcClient({ workdir, port: options.port });

  const isAlive = await client.isDaemonAlive();
  if (!isAlive) {
    console.error(`[KnowCode] Daemon is not running. Run 'knowcode serve' first.`);
    process.exit(1);
  }

  try {
    const res = await client.query(cypher);
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[KnowCode Query Error]: ${message}`);
    process.exit(1);
  }
}
