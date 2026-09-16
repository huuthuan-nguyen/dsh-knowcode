import http from 'node:http';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fg from 'fast-glob';
import { FalkorDBManager } from '../db/falkor-manager.js';
import { initGraphSchema } from '../db/schema.js';
import { KnowCodeRepository } from '../db/client.js';
import { CodeParser } from '../parser/code-parser.js';
import { DocParser } from '../parser/doc-parser.js';
import { LinkEngine } from '../parser/link-engine.js';
import { CodeWatcher } from './watcher.js';
export class KnowCodeDaemon {
    options;
    server = null;
    falkorManager;
    falkorInstance = null;
    repo = null;
    watcher = null;
    isIndexing = false;
    lastIndexedAt = null;
    constructor(options) {
        this.options = options;
        this.falkorManager = new FalkorDBManager();
    }
    async start(startOpts) {
        const workdir = resolve(this.options.workdir);
        const dataDir = join(workdir, this.options.dataDir ?? '.knowcode');
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }
        this.log(`Starting FalkorDB embedded database in ${dataDir}...`);
        this.falkorInstance = await this.falkorManager.start({
            dataDir,
            customUrl: this.options.falkordbUrl,
            preferredPort: (this.options.port ?? 48123) + 10,
        });
        const graph = this.falkorInstance.client.selectGraph('knowcode');
        await initGraphSchema(graph);
        this.repo = new KnowCodeRepository(graph);
        // Start background watcher if requested (default true)
        if (startOpts?.withWatcher !== false) {
            this.watcher = new CodeWatcher({
                workdir,
                repo: this.repo,
                onUpdate: (evt, path) => this.log(`[Watcher] ${evt}: ${path}`),
            });
            this.watcher.start();
            this.log('File watcher active on workspace.');
        }
        // Start HTTP daemon server
        const daemonPort = this.options.port ?? 48123;
        this.server = http.createServer(async (req, res) => {
            try {
                await this.handleRequest(req, res);
            }
            catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err?.message ?? String(err) }));
            }
        });
        await new Promise((resolvePromise, rejectPromise) => {
            this.server.listen(daemonPort, '127.0.0.1', () => resolvePromise());
            this.server.on('error', rejectPromise);
        });
        // Write daemon info file
        const daemonInfoPath = join(dataDir, 'daemon.json');
        writeFileSync(daemonInfoPath, JSON.stringify({
            pid: process.pid,
            port: daemonPort,
            workdir,
            startedAt: new Date().toISOString(),
        }, null, 2));
        this.log(`KnowCode daemon server listening on http://127.0.0.1:${daemonPort}`);
        // Clean exit handlers
        const shutdown = () => this.stop().catch(() => { });
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
        return { port: daemonPort, pid: process.pid };
    }
    async stop() {
        this.log('Stopping KnowCode daemon...');
        if (this.watcher) {
            await this.watcher.stop();
            this.watcher = null;
        }
        if (this.server) {
            await new Promise((res) => this.server.close(() => res()));
            this.server = null;
        }
        if (this.falkorManager) {
            await this.falkorManager.stop();
            this.falkorInstance = null;
        }
        const dataDir = join(this.options.workdir, this.options.dataDir ?? '.knowcode');
        const daemonInfoPath = join(dataDir, 'daemon.json');
        if (existsSync(daemonInfoPath)) {
            try {
                unlinkSync(daemonInfoPath);
            }
            catch { }
        }
        this.log('KnowCode daemon stopped cleanly.');
    }
    /**
     * Perform full indexing pass on the workspace
     */
    async performFullIndex(targetPath) {
        if (this.isIndexing) {
            throw new Error('Indexing already in progress.');
        }
        this.isIndexing = true;
        const startTime = Date.now();
        try {
            const rootDir = resolve(targetPath ?? this.options.workdir);
            this.log(`Beginning indexing scan of ${rootDir}...`);
            const filePatterns = [
                '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,cpp,h,hpp,md,mdx,markdown,txt}',
            ];
            const entries = await fg(filePatterns, {
                cwd: rootDir,
                ignore: [
                    '**/node_modules/**',
                    '**/.git/**',
                    '**/.knowcode/**',
                    '**/dist/**',
                    '**/lib/**',
                    '**/build/**',
                    '**/.next/**',
                    '**/coverage/**',
                ],
                dot: false,
            });
            this.log(`Found ${entries.length} candidate files.`);
            let codeCount = 0;
            let docCount = 0;
            let totalSymbols = 0;
            const allImports = [];
            const allCalls = [];
            const allHeritage = [];
            for (const relPath of entries) {
                const absPath = join(rootDir, relPath);
                let content = '';
                try {
                    content = readFileSync(absPath, 'utf8');
                }
                catch {
                    continue;
                }
                // Check if code file
                const parsedCode = CodeParser.parseFile(relPath, content);
                if (parsedCode) {
                    await this.repo.ingestCodeFile(parsedCode);
                    codeCount++;
                    totalSymbols += parsedCode.symbols.length;
                    allImports.push(...parsedCode.imports);
                    allCalls.push(...parsedCode.calls);
                    allHeritage.push(...parsedCode.heritage);
                    continue;
                }
                // Check if doc file
                const parsedDoc = DocParser.parseDoc(relPath, content);
                if (parsedDoc) {
                    await this.repo.ingestDocFile(parsedDoc);
                    docCount++;
                    continue;
                }
            }
            // Ingest cross-file relationships
            this.log(`Ingesting relationships: ${allImports.length} imports, ${allCalls.length} calls...`);
            await this.repo.ingestImports(allImports);
            await this.repo.ingestCalls(allCalls);
            await this.repo.ingestHeritage(allHeritage);
            // Run link engine passes
            const linker = new LinkEngine(this.repo);
            await linker.linkAll();
            this.lastIndexedAt = new Date().toISOString();
            const elapsed = Date.now() - startTime;
            this.log(`Indexing complete in ${elapsed}ms: ${codeCount} code files, ${docCount} docs, ${totalSymbols} symbols.`);
            return {
                filesIndexed: codeCount + docCount,
                symbolsIndexed: totalSymbols,
                docsIndexed: docCount,
                timeMs: elapsed,
            };
        }
        finally {
            this.isIndexing = false;
        }
    }
    async handleRequest(req, res) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const method = req.method?.toUpperCase();
        // Helper for JSON reply
        const sendJson = (data, status = 200) => {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(data));
        };
        // Helper to read body
        const readBody = async () => {
            return new Promise((resolveBody, rejectBody) => {
                let body = '';
                req.on('data', (chunk) => (body += chunk));
                req.on('end', () => {
                    try {
                        resolveBody(body ? JSON.parse(body) : {});
                    }
                    catch (e) {
                        rejectBody(e);
                    }
                });
                req.on('error', rejectBody);
            });
        };
        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end();
            return;
        }
        if (url.pathname === '/status' && method === 'GET') {
            const dbStats = await this.repo?.getStats();
            const stats = {
                daemonRunning: true,
                daemonPid: process.pid,
                port: this.server?.address()?.port,
                dbPath: this.falkorInstance?.dbPath ?? '',
                totalFiles: (dbStats?.totalFiles ?? 0) + (dbStats?.totalDocs ?? 0),
                totalCodeFiles: dbStats?.totalFiles ?? 0,
                totalDocFiles: dbStats?.totalDocs ?? 0,
                totalSymbols: dbStats?.totalSymbols ?? 0,
                totalCalls: dbStats?.totalCalls ?? 0,
                totalSections: dbStats?.totalSections ?? 0,
                totalRules: dbStats?.totalRules ?? 0,
                lastIndexedAt: this.lastIndexedAt ?? undefined,
                languages: dbStats?.languages ?? {},
            };
            sendJson(stats);
            return;
        }
        if (url.pathname === '/index' && method === 'POST') {
            const body = await readBody();
            const result = await this.performFullIndex(body.path);
            sendJson(result);
            return;
        }
        if (url.pathname === '/query' && method === 'POST') {
            const body = await readBody();
            if (!body.cypher) {
                sendJson({ error: 'Missing cypher parameter' }, 400);
                return;
            }
            const queryRes = await this.repo?.query(body.cypher, body.params);
            sendJson(queryRes);
            return;
        }
        if (url.pathname === '/rpc' && method === 'POST') {
            const body = await readBody();
            const { action, params = {} } = body;
            const result = await this.dispatchRpc(action, params);
            sendJson(result);
            return;
        }
        if (url.pathname === '/shutdown' && method === 'POST') {
            sendJson({ status: 'shutting down' });
            setTimeout(() => this.stop(), 200);
            return;
        }
        sendJson({ error: 'Endpoint not found' }, 404);
    }
    async dispatchRpc(action, params) {
        if (!this.repo)
            throw new Error('Repository not initialized');
        switch (action) {
            case 'explore':
                return await this.repo.explore(params.limit ?? 25);
            case 'symbol_definition':
                return await this.repo.getSymbolDefinition(params.name, params.file);
            case 'call_path':
                return await this.repo.findCallPath(params.fromSymbol, params.toSymbol);
            case 'subtypes':
                return await this.repo.findSubtypesAndImplementations(params.symbol);
            case 'search_symbols':
                return await this.repo.searchSymbols(params.pattern ?? params.query, params.kind, params.limit ?? 25);
            case 'unused_symbols':
                return await this.repo.findUnusedSymbols(params.limit ?? 50);
            case 'git_diff_impact':
                return await this.repo.analyzeGitDiffImpact(this.options.workdir, params.baseRef);
            case 'callers':
                return await this.repo.getCallers(params.symbol);
            case 'callees':
                return await this.repo.getCallees(params.symbol);
            case 'blast_radius':
                return await this.repo.getBlastRadius(params.symbol, params.depth ?? 3);
            case 'detect_cycles':
                return await this.repo.detectCycles();
            case 'affected_tests':
                return await this.repo.getAffectedTests(params.files ?? []);
            case 'porting_contract':
                return await this.repo.getPortingContract(params.symbol);
            case 'cross_paradigm_blueprint':
                return await this.repo.generateCrossParadigmBlueprint(params.symbol, params.targetLanguage ?? 'rust');
            case 'third_party_slice':
                return await this.repo.extractThirdPartyUsageSlice(params.libraryPrefix, params.targetLanguage ?? 'rust');
            case 'similar_functions':
                return await this.repo.findSimilarFunctions({
                    threshold: params.threshold,
                    targetSymbol: params.symbol,
                    minLines: params.minLines,
                });
            case 'spec_code_flow':
                return await this.repo.findCodeFlowForFeature(params.query, params.flowDepth ?? 3);
            case 'symbol_spec_features':
                return await this.repo.findSpecFeaturesForSymbol(params.symbol, params.searchCallers ?? true);
            case 'contract_storage_mapping':
                return await this.repo.schemaMapContractToStorage(params.contractEntity, params.storageTarget, params.storageEngine);
            case 'storage_migration_impact':
                return await this.repo.schemaAnalyzeStorageMigrationImpact(params.storageContainer, params.attribute, params.action ?? 'drop');
            case 'knowledge_search':
                return await this.repo.searchKnowledge(params.query, params.limit ?? 10);
            case 'knowledge_doc':
                return await this.repo.getKnowledgeDoc(params.pathOrTitle);
            default:
                throw new Error(`Unknown RPC action: ${action}`);
        }
    }
    log(msg) {
        if (this.options.onLog) {
            this.options.onLog(msg);
        }
        else {
            console.log(`[KnowCode] ${msg}`);
        }
    }
}
