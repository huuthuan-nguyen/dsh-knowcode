import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { FalkorDB } from 'falkordb';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export class FalkorDBManager {
    instance = null;
    /**
     * Find an available TCP port starting from startPort
     */
    static async findOpenPort(startPort = 6380) {
        for (let port = startPort; port < startPort + 100; port++) {
            const isAvailable = await new Promise((res) => {
                const server = net.createServer();
                server.unref();
                server.on('error', () => res(false));
                server.listen(port, '127.0.0.1', () => {
                    server.close(() => res(true));
                });
            });
            if (isAvailable)
                return port;
        }
        return startPort;
    }
    /**
     * Locate embedded binaries for the current platform
     */
    static resolveBinaries() {
        const platform = process.platform;
        const arch = process.arch;
        let platformKey = '';
        if (platform === 'darwin' && arch === 'arm64') {
            platformKey = 'darwin-arm64';
        }
        else if (platform === 'darwin' && arch === 'x64') {
            platformKey = 'darwin-x64';
        }
        else if (platform === 'linux' && arch === 'x64') {
            platformKey = 'linux-x64';
        }
        else if (platform === 'linux' && arch === 'arm64') {
            platformKey = 'linux-arm64';
        }
        if (!platformKey) {
            return null;
        }
        // Try finding bin directory relative to current package
        const packageRoot = resolve(__dirname, '..', '..');
        const binDir = join(packageRoot, 'bin', platformKey);
        const redisServerPath = join(binDir, 'redis-server');
        const modulePath = join(binDir, 'falkordb.so');
        if (existsSync(redisServerPath) && existsSync(modulePath)) {
            return { redisServerPath, modulePath };
        }
        return null;
    }
    /**
     * Start or connect to FalkorDB
     */
    async start(options) {
        if (this.instance) {
            return this.instance;
        }
        // 1. If external URL is provided, connect to it directly
        if (options.customUrl && options.customUrl.trim().length > 0) {
            const client = await FalkorDB.connect({ url: options.customUrl });
            this.instance = {
                port: 0,
                client,
                dbPath: options.dataDir,
                isEmbedded: false,
            };
            return this.instance;
        }
        // 2. Start embedded instance
        const binaries = FalkorDBManager.resolveBinaries();
        if (!binaries) {
            if (process.platform === 'win32') {
                throw new Error(`[KnowCode] Embedded FalkorDB binaries are not supported natively on Windows (Redis 7.2+ and GraphBLAS require a POSIX environment).\n` +
                    `Recommended solutions for Windows users:\n` +
                    `  1. Run inside WSL2 (Ubuntu on Windows) - fully supported with embedded Linux binaries!\n` +
                    `  2. Run FalkorDB in Docker: 'docker run -d -p 6379:6379 falkordb/falkordb:latest' and set customUrl/falkordbUrl to 'redis://127.0.0.1:6379'\n` +
                    `  3. Connect to a remote FalkorDB instance via FALKORDB_URL.`);
            }
            throw new Error(`[KnowCode] Embedded FalkorDB binaries not found for platform: ${process.platform}-${process.arch}.\n` +
                `Please provide an external falkordbUrl (e.g. redis://127.0.0.1:6379 via Docker or Cloud) or place binaries in bin/${process.platform}-${process.arch}/.`);
        }
        const resolvedDataDir = resolve(options.dataDir);
        if (!existsSync(resolvedDataDir)) {
            mkdirSync(resolvedDataDir, { recursive: true });
        }
        const port = await FalkorDBManager.findOpenPort(options.preferredPort ?? 6385);
        // Prepare Redis configuration
        const confPath = join(resolvedDataDir, 'redis-embedded.conf');
        const confContent = [
            `port ${port}`,
            `bind 127.0.0.1`,
            `dir "${resolvedDataDir}"`,
            `dbfilename "falkordb.rdb"`,
            `save 60 1`,
            `appendonly no`,
            `protected-mode yes`,
            `loglevel notice`,
            `loadmodule "${binaries.modulePath}"`,
        ].join('\n');
        writeFileSync(confPath, confContent, 'utf8');
        // Setup environment variables (DYLD_INSERT_LIBRARIES needed on macOS)
        const env = { ...process.env };
        if (process.platform === 'darwin') {
            env.DYLD_INSERT_LIBRARIES =
                '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation:/System/Library/Frameworks/Security.framework/Security';
        }
        const child = spawn(binaries.redisServerPath, [confPath], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });
        // Wait for server to become ready
        await new Promise((res, rej) => {
            let isReady = false;
            const timeout = setTimeout(() => {
                if (!isReady) {
                    child.kill('SIGKILL');
                    rej(new Error('Embedded FalkorDB startup timed out after 10s'));
                }
            }, 10000);
            child.stdout?.on('data', (data) => {
                const str = data.toString();
                if (str.includes('Ready to accept connections') || str.includes('server is ready')) {
                    isReady = true;
                    clearTimeout(timeout);
                    res();
                }
            });
            child.stderr?.on('data', (data) => {
                const str = data.toString();
                if (str.includes('server aborting') || str.includes('Fatal error')) {
                    isReady = true;
                    clearTimeout(timeout);
                    rej(new Error(`Embedded FalkorDB fatal error: ${str}`));
                }
            });
            child.on('error', (err) => {
                clearTimeout(timeout);
                rej(err);
            });
            child.on('exit', (code) => {
                if (!isReady) {
                    clearTimeout(timeout);
                    rej(new Error(`Embedded FalkorDB exited prematurely with code ${code}`));
                }
            });
        });
        // Connect official FalkorDB client
        const client = await FalkorDB.connect({
            socket: { host: '127.0.0.1', port },
        });
        this.instance = {
            port,
            process: child,
            client,
            dbPath: resolvedDataDir,
            isEmbedded: true,
        };
        // Auto-cleanup on process exit
        const cleanup = () => {
            this.stop().catch(() => { });
        };
        process.on('exit', cleanup);
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        return this.instance;
    }
    /**
     * Stop the running instance
     */
    async stop() {
        if (!this.instance)
            return;
        const { client, process: child } = this.instance;
        this.instance = null;
        try {
            if (client) {
                await client.close();
            }
        }
        catch {
            // ignore
        }
        if (child && !child.killed) {
            await new Promise((res) => {
                const timer = setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch { }
                    res();
                }, 1000);
                child.once('exit', () => {
                    clearTimeout(timer);
                    res();
                });
                child.kill('SIGTERM');
            });
        }
    }
    getInstance() {
        return this.instance;
    }
}
