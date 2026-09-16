import { resolve } from 'node:path';
import { KnowCodeRpcClient } from '../server/client-rpc.js';
import { KnowCodeDaemon } from '../server/daemon.js';
export async function runIndexCommand(targetDir = '.', options = {}) {
    const workdir = resolve(targetDir);
    const client = new KnowCodeRpcClient({ workdir, port: options.port, dataDir: options.dataDir });
    const isAlive = await client.isDaemonAlive();
    if (isAlive) {
        console.log(`[KnowCode] Connected to active daemon on port ${client.getActivePort()}. Triggering re-index...`);
        const res = await client.triggerIndex(workdir);
        console.log(`[KnowCode] Index complete: ${res.filesIndexed} files, ${res.symbolsIndexed} symbols in ${res.timeMs}ms.`);
        return;
    }
    console.log(`[KnowCode] Daemon not running. Performing direct indexing for: ${workdir}`);
    const daemon = new KnowCodeDaemon({
        workdir,
        port: options.port,
        dataDir: options.dataDir,
        onLog: (msg) => console.log(msg),
    });
    try {
        await daemon.start({ withWatcher: false });
        const res = await daemon.performFullIndex(workdir);
        console.log(`[KnowCode] Successfully indexed ${res.filesIndexed} files and ${res.symbolsIndexed} symbols in ${res.timeMs}ms.`);
    }
    finally {
        await daemon.stop();
    }
}
