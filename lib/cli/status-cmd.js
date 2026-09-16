import { resolve } from 'node:path';
import { KnowCodeRpcClient } from '../server/client-rpc.js';
export async function runStatusCommand(targetDir = '.', options = {}) {
    const workdir = resolve(targetDir);
    const client = new KnowCodeRpcClient({ workdir, port: options.port });
    const isAlive = await client.isDaemonAlive();
    if (!isAlive) {
        console.log(`[KnowCode] Daemon is NOT running for ${workdir}.`);
        console.log(`Tip: Start the daemon with: knowcode serve`);
        return;
    }
    const status = await client.getStatus();
    console.log('========================================');
    console.log('        KnowCode Graph & Knowledge      ');
    console.log('========================================');
    console.log(`Status:          ONLINE (PID: ${status.daemonPid}, Port: ${status.port})`);
    console.log(`Database:        ${status.dbPath}`);
    console.log(`Total Files:     ${status.totalFiles}`);
    console.log(`Total Symbols:   ${status.totalSymbols}`);
    console.log(`Total Calls:     ${status.totalCalls}`);
    console.log(`Total Docs:      ${status.totalDocFiles}`);
    console.log(`Doc Sections:    ${status.totalSections}`);
    console.log(`Arch Rules:      ${status.totalRules}`);
    console.log(`Last Indexed:    ${status.lastIndexedAt ?? 'N/A'}`);
    console.log('Languages:');
    for (const [lang, cnt] of Object.entries(status.languages)) {
        console.log(`  - ${lang}: ${cnt} files`);
    }
    console.log('========================================');
}
