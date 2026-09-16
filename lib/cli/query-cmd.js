import { resolve } from 'node:path';
import { KnowCodeRpcClient } from '../server/client-rpc.js';
export async function runQueryCommand(cypher, targetDir = '.', options = {}) {
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
    }
    catch (err) {
        console.error(`[KnowCode Query Error]: ${err.message}`);
        process.exit(1);
    }
}
