import { resolve } from 'node:path';
import { KnowCodeDaemon } from '../server/daemon.js';
export async function runServeCommand(targetDir = '.', options = {}) {
    const workdir = resolve(targetDir);
    const daemon = new KnowCodeDaemon({
        workdir,
        port: options.port,
        dataDir: options.dataDir,
        onLog: (msg) => console.log(msg),
    });
    console.log(`[KnowCode] Starting daemon & file watcher in ${workdir}...`);
    const info = await daemon.start();
    console.log(`[KnowCode] Daemon online! (PID: ${info.pid}, Port: ${info.port})`);
    console.log(`[KnowCode] Performing initial index...`);
    await daemon.performFullIndex();
    console.log(`[KnowCode] Ready and watching for file changes. Press Ctrl+C to stop.`);
    // Keep process alive until interrupted
    await new Promise(() => { });
}
