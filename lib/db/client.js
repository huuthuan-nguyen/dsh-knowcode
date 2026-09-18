import { getWorkspaceGitDiff } from '../parser/git-diff-parser.js';
import { StorageParser } from '../parser/storage-parser.js';
const ECOSYSTEM_KNOWLEDGE_BASE = {
    cache: {
        category: 'In-Memory Caching & Eviction',
        equivalents: {
            rust: { pkg: 'moka', install: 'cargo add moka', desc: 'Fast, concurrent cache library for Rust with LRU/LFU eviction (inspired by Caffeine).' },
            go: { pkg: 'github.com/allegro/bigcache/v3', install: 'go get github.com/allegro/bigcache/v3', desc: 'Efficient in-memory cache for millions of items in Go without GC overhead.' },
            java: { pkg: 'com.github.ben-manes.caffeine:caffeine', install: 'implementation "com.github.ben-manes.caffeine:caffeine:3.1.8"', desc: 'High performance, near-optimal caching library for Java.' },
            typescript: { pkg: 'lru-cache', install: 'npm install lru-cache', desc: 'A cache object that deletes the least-recently-used items.' },
            python: { pkg: 'cachetools', install: 'pip install cachetools', desc: 'Extensible memoizing collections and variants (LRU, LFU, TTL).' },
        },
    },
    jwt: {
        category: 'JSON Web Token (JWT)',
        equivalents: {
            rust: { pkg: 'jsonwebtoken', install: 'cargo add jsonwebtoken', desc: 'JWT signing, secret verification, and claims decoding in Rust.' },
            go: { pkg: 'github.com/golang-jwt/jwt/v5', install: 'go get github.com/golang-jwt/jwt/v5', desc: 'Community standard JWT implementation for Go.' },
            java: { pkg: 'io.jsonwebtoken:jjwt-api', install: 'implementation "io.jsonwebtoken:jjwt-api:0.12.5"', desc: 'Java JWT library for clean and secure token creation and validation.' },
            typescript: { pkg: 'jsonwebtoken', install: 'npm install jsonwebtoken', desc: 'Node.js JWT implementation.' },
            python: { pkg: 'pyjwt', install: 'pip install pyjwt', desc: 'JSON Web Token implementation in Python.' },
        },
    },
    http: {
        category: 'HTTP Client & REST',
        equivalents: {
            rust: { pkg: 'reqwest', install: 'cargo add reqwest --features json', desc: 'Higher level HTTP client for Rust with async and connection pooling.' },
            go: { pkg: 'github.com/go-resty/resty/v2', install: 'go get github.com/go-resty/resty/v2', desc: 'Simple HTTP and REST client library for Go.' },
            java: { pkg: 'com.squareup.okhttp3:okhttp', install: 'implementation "com.squareup.okhttp3:okhttp:4.12.0"', desc: 'Square’s meticulous HTTP client for Java and Android.' },
            typescript: { pkg: 'axios', install: 'npm install axios', desc: 'Promise-based HTTP client for node.js and the browser.' },
            python: { pkg: 'httpx', install: 'pip install httpx', desc: 'Next-generation HTTP client for Python with async and sync support.' },
        },
    },
    json: {
        category: 'Serialization & Deserialization',
        equivalents: {
            rust: { pkg: 'serde', install: 'cargo add serde --features derive && cargo add serde_json', desc: 'Generic serialization/deserialization framework for Rust.' },
            go: { pkg: 'encoding/json', install: '// standard library built-in', desc: 'Standard Go JSON encoding and decoding package.' },
            java: { pkg: 'com.fasterxml.jackson.core:jackson-databind', install: 'implementation "com.fasterxml.jackson.core:jackson-databind:2.17.0"', desc: 'Standard data-binding package for Jackson JSON processor.' },
            typescript: { pkg: 'zod', install: 'npm install zod', desc: 'TypeScript-first schema declaration and validation with static type inference.' },
            python: { pkg: 'pydantic', install: 'pip install pydantic', desc: 'Data validation and settings management using Python type annotations.' },
        },
    },
};
export class KnowCodeRepository {
    graph;
    constructor(graph) {
        this.graph = graph;
    }
    /**
     * Run raw Cypher query with optional parameters
     */
    async query(cypher, params) {
        return await this.graph.query(cypher, { params });
    }
    /**
     * Delete all existing data for a code file (for clean incremental upserts)
     */
    async deleteFile(filePath) {
        await this.graph.query(`MATCH (f:File {path: $filePath})
       OPTIONAL MATCH (f)-[:CONTAINS]->(s:Symbol)
       DETACH DELETE s, f`, { params: { filePath } });
    }
    /**
     * Delete all existing data for a document (for clean incremental upserts)
     */
    async deleteDoc(docPath) {
        await this.graph.query(`MATCH (d:Document {path: $docPath})
       OPTIONAL MATCH (d)-[:HAS_SECTION]->(sec:DocSection)
       OPTIONAL MATCH (d)-[:HAS_RULE]->(r:Rule)
       DETACH DELETE sec, r, d`, { params: { docPath } });
    }
    /**
     * Ingest a single parsed code file and its symbols
     */
    async ingestCodeFile(parsed) {
        await this.deleteFile(parsed.path);
        // 1. Create File node
        await this.graph.query(`CREATE (f:File {
        path: $path,
        language: $language,
        hash: $hash,
        lineCount: $lineCount,
        size: $size,
        isTest: $isTest,
        mtimeMs: $mtimeMs
      })`, {
            params: {
                path: parsed.path,
                language: parsed.language,
                hash: parsed.hash,
                lineCount: parsed.lineCount,
                size: parsed.size ?? 0,
                isTest: parsed.isTest ?? false,
                mtimeMs: parsed.mtimeMs ?? 0,
            },
        });
        // 2. Create Symbol nodes & CONTAINS relations
        for (const sym of parsed.symbols) {
            await this.graph.query(`MATCH (f:File {path: $file})
         CREATE (s:Symbol {
           id: $id,
           name: $name,
           qname: $qname,
           kind: $kind,
           file: $file,
           startLine: $startLine,
           endLine: $endLine,
           signature: $signature,
           docstring: $docstring,
           isExported: $isExported,
           visibility: $visibility,
           structuralHash: $structuralHash
         })
         CREATE (f)-[:CONTAINS]->(s)`, {
                params: {
                    file: sym.file,
                    id: sym.id ?? `${sym.file}:${sym.name}`,
                    name: sym.name,
                    qname: sym.qname ?? sym.name,
                    kind: sym.kind,
                    startLine: sym.startLine,
                    endLine: sym.endLine ?? sym.startLine,
                    signature: sym.signature ?? '',
                    docstring: sym.docstring ?? '',
                    isExported: sym.isExported ?? false,
                    visibility: sym.visibility ?? 'public',
                    structuralHash: sym.structuralHash ?? '',
                },
            });
        }
    }
    /**
     * Ingest imports for a file
     */
    /**
     * Ingest file imports.
     *
     * A relative import is resolved by matching the parser's candidate list
     * against the indexed `File` nodes. Matching a single extension-less guess
     * (the previous behaviour) never hit a real `File.path`, so **no** `:IMPORTS`
     * edge was ever created between local files — which silently broke
     * `TESTS_FOR` linking and therefore affected-test discovery.
     */
    async ingestImports(imports) {
        for (const imp of imports) {
            const candidates = imp.resolvedCandidates && imp.resolvedCandidates.length > 0
                ? imp.resolvedCandidates
                : imp.resolvedFile
                    ? [imp.resolvedFile]
                    : [];
            let linked = false;
            if (candidates.length > 0) {
                const res = await this.graph.query(`MATCH (src:File {path: $srcPath})
           MATCH (dst:File)
           WHERE dst.path IN $candidates
           MERGE (src)-[r:IMPORTS]->(dst)
           SET r.specifiers = $specifiers, r.importedPath = $importedPath
           RETURN count(dst) AS linked`, {
                    params: {
                        srcPath: imp.sourceFile,
                        candidates,
                        specifiers: imp.specifiers.join(','),
                        importedPath: imp.importedPath,
                    },
                });
                linked = (res.data?.[0]?.linked ?? 0) > 0;
            }
            if (!linked) {
                // Not a local file: record the import against an external package node.
                await this.graph.query(`MATCH (src:File {path: $srcPath})
           MERGE (pkg:ExternalPackage {path: $importedPath})
           MERGE (src)-[r:IMPORTS]->(pkg)
           SET r.specifiers = $specifiers, r.importedPath = $importedPath`, {
                    params: {
                        srcPath: imp.sourceFile,
                        importedPath: imp.importedPath,
                        specifiers: imp.specifiers.join(','),
                    },
                });
            }
        }
    }
    /**
     * Ingest call relationships between symbols
     */
    async ingestCalls(calls) {
        for (const call of calls) {
            const res = await this.graph.query(`MATCH (caller:Symbol)
         WHERE caller.id = $callerId OR caller.name = $callerId
         MATCH (callee:Symbol)
         WHERE callee.name = $calleeName OR callee.qname = $calleeName
         MERGE (caller)-[r:CALLS]->(callee)
         ON CREATE SET r.line = $line, r.count = 1, r.calleeName = $calleeName
         ON MATCH SET r.count = r.count + 1
         RETURN count(callee) AS matched`, {
                params: {
                    callerId: call.callerId,
                    calleeName: call.calleeName,
                    line: call.line ?? 0,
                },
            });
            const matched = res.data?.[0]?.matched ?? 0;
            if (matched === 0) {
                // External / 3rd-party library call
                await this.graph.query(`MATCH (caller:Symbol)
           WHERE caller.id = $callerId OR caller.name = $callerId
           MERGE (ext:ExternalSymbol {name: $calleeName})
           MERGE (caller)-[r:CALLS]->(ext)
           ON CREATE SET r.line = $line, r.count = 1, r.calleeName = $calleeName
           ON MATCH SET r.count = r.count + 1`, {
                    params: {
                        callerId: call.callerId,
                        calleeName: call.calleeName,
                        line: call.line ?? 0,
                    },
                });
            }
        }
    }
    /**
     * Ingest class/interface heritage (extends / implements)
     */
    async ingestHeritage(heritage) {
        for (const h of heritage) {
            const relType = h.kind === 'extends' ? 'EXTENDS' : 'IMPLEMENTS';
            await this.graph.query(`MATCH (sub:Symbol)
         WHERE sub.id = $subId OR sub.name = $subId
         MATCH (sup:Symbol)
         WHERE sup.name = $supName OR sup.qname = $supName
         MERGE (sub)-[:${relType}]->(sup)`, {
                params: {
                    subId: h.subSymbolId,
                    supName: h.superSymbolName,
                },
            });
        }
    }
    /**
     * Ingest a documentation file (Markdown/ADR/spec)
     */
    async ingestDocFile(doc) {
        await this.deleteDoc(doc.path);
        // 1. Create Document node
        await this.graph.query(`CREATE (d:Document {
        path: $path,
        title: $title,
        category: $category,
        hash: $hash,
        updatedAt: timestamp()
      })`, {
            params: {
                path: doc.path,
                title: doc.title,
                category: doc.category,
                hash: doc.hash,
            },
        });
        // 2. Create Sections
        for (const sec of doc.sections) {
            await this.graph.query(`MATCH (d:Document {path: $docPath})
         CREATE (s:DocSection {
           id: $id,
           documentPath: $docPath,
           title: $title,
           content: $content,
           level: $level,
           startLine: $startLine,
           endLine: $endLine
         })
         CREATE (d)-[:HAS_SECTION]->(s)`, {
                params: {
                    docPath: doc.path,
                    id: sec.id,
                    title: sec.title,
                    content: sec.content,
                    level: sec.level,
                    startLine: sec.startLine,
                    endLine: sec.endLine,
                },
            });
            // Link section to referenced code symbols
            if (sec.referencedSymbols) {
                for (const symName of sec.referencedSymbols) {
                    await this.graph.query(`MATCH (s:DocSection {id: $secId})
             MATCH (sym:Symbol)
             WHERE sym.name = $symName OR sym.qname = $symName
             MERGE (s)-[:DOCUMENTS]->(sym)`, { params: { secId: sec.id, symName } });
                }
            }
        }
        // 3. Create Rules
        for (const rule of doc.rules) {
            await this.graph.query(`MATCH (d:Document {path: $docPath})
         CREATE (r:Rule {
           id: $id,
           title: $title,
           content: $content,
           priority: $priority,
           sourceDoc: $docPath
         })
         CREATE (d)-[:HAS_RULE]->(r)`, {
                params: {
                    docPath: doc.path,
                    id: rule.id,
                    title: rule.title,
                    content: rule.content,
                    priority: rule.priority,
                },
            });
        }
    }
    /**
     * Codebase architectural exploration
     */
    async explore(limit = 25) {
        // 1. Files overview
        const filesRes = await this.graph.query(`MATCH (f:File) RETURN f.path AS path, f.language AS language, f.lineCount AS lineCount LIMIT 20`);
        const files = (filesRes.data ?? []).map((row) => ({
            path: row.path,
            language: row.language,
            lineCount: row.lineCount,
        }));
        // 2. Central hub symbols (highest incoming call count / inDegree)
        const hubsRes = await this.graph.query(`MATCH (s:Symbol)<-[r:CALLS]-()
       RETURN s.name AS name, s.kind AS kind, s.file AS file, count(r) AS inDegree
       ORDER BY inDegree DESC
       LIMIT $limit`, { params: { limit } });
        const topSymbols = (hubsRes.data ?? []).map((row) => ({
            name: row.name,
            kind: row.kind,
            file: row.file,
            inDegree: row.inDegree,
        }));
        // 3. Entry points (exported symbols with 0 callers)
        const entryRes = await this.graph.query(`MATCH (s:Symbol {isExported: true})
       WHERE NOT (s)<-[:CALLS]-()
       RETURN s.name AS name, s.file AS file, s.kind AS kind
       LIMIT 15`);
        const entryPoints = (entryRes.data ?? []).map((row) => ({
            name: row.name,
            file: row.file,
            kind: row.kind,
        }));
        return { files, topSymbols, entryPoints };
    }
    /**
     * Find symbol details and definition
     */
    async getSymbolDefinition(name, file) {
        const cypher = file
            ? `MATCH (s:Symbol) WHERE (s.name = $name OR s.qname = $name) AND s.file = $file RETURN s LIMIT 1`
            : `MATCH (s:Symbol) WHERE s.name = $name OR s.qname = $name RETURN s LIMIT 1`;
        const res = await this.graph.query(cypher, { params: { name, file: file ?? '' } });
        const data = res.data;
        if (!data || data.length === 0)
            return null;
        const s = data[0].s.properties;
        return {
            id: s.id,
            name: s.name,
            qname: s.qname,
            kind: s.kind,
            file: s.file,
            startLine: s.startLine,
            endLine: s.endLine,
            signature: s.signature,
            docstring: s.docstring,
            isExported: s.isExported,
            visibility: s.visibility,
        };
    }
    /**
     * Fuzzy/case-insensitive search for symbols by name pattern or substring
     */
    /**
     * Search symbols by name/qname substring.
     *
     * When `metrics` is supplied (only done while tracing is enabled) one extra
     * pre-LIMIT count query runs so the caller can report `raw_candidates`.
     */
    async searchSymbols(pattern, kind, limit = 25, metrics) {
        const params = { pattern, limit };
        const whereClause = `WHERE toLower(s.name) CONTAINS toLower($pattern) OR toLower(s.qname) CONTAINS toLower($pattern)`;
        if (kind) {
            params.kind = kind;
        }
        const kindClause = kind ? ` AND s.kind = $kind` : '';
        if (metrics) {
            const countRes = await this.graph.query(`MATCH (s:Symbol) ${whereClause}${kindClause} RETURN count(s) AS total`, { params: kind ? { pattern, kind } : { pattern } });
            const total = countRes.data?.[0]?.total ?? 0;
            metrics.rawCandidates = total;
            metrics.candidates = Math.min(total, limit);
        }
        const cypher = `MATCH (s:Symbol) ${whereClause}${kindClause}
       RETURN s.id AS id, s.name AS name, s.qname AS qname, s.kind AS kind, s.file AS file,
              s.startLine AS startLine, s.endLine AS endLine, s.signature AS signature,
              s.docstring AS docstring, s.visibility AS visibility, s.isExported AS isExported
       ORDER BY size(s.name) ASC
       LIMIT $limit`;
        const res = await this.graph.query(cypher, { params });
        return (res.data ?? []).map((r) => ({
            id: r.id ?? `${r.file}:${r.name}`,
            name: r.name,
            qname: r.qname ?? r.name,
            kind: r.kind,
            file: r.file,
            startLine: r.startLine,
            endLine: r.endLine,
            signature: r.signature ?? '',
            docstring: r.docstring,
            visibility: r.visibility,
            isExported: r.isExported ?? false,
        }));
    }
    /**
     * Get callers of a symbol
     */
    async getCallers(symbolName) {
        const res = await this.graph.query(`MATCH (caller:Symbol)-[r:CALLS]->(callee:Symbol)
       WHERE callee.name = $symbolName OR callee.qname = $symbolName
       RETURN caller.name AS callerName, caller.qname AS callerQName, caller.kind AS callerKind, caller.file AS file, r.line AS line`, { params: { symbolName } });
        return (res.data ?? []).map((row) => ({
            callerName: row.callerName,
            callerQName: row.callerQName,
            callerKind: row.callerKind,
            file: row.file,
            line: row.line,
        }));
    }
    /**
     * Get callees of a symbol
     */
    async getCallees(symbolName) {
        const res = await this.graph.query(`MATCH (caller:Symbol)-[:CALLS]->(callee:Symbol)
       WHERE caller.name = $symbolName OR caller.qname = $symbolName
       RETURN callee.name AS calleeName, callee.qname AS calleeQName, callee.kind AS calleeKind, callee.file AS file`, { params: { symbolName } });
        return (res.data ?? []).map((row) => ({
            calleeName: row.calleeName,
            calleeQName: row.calleeQName,
            calleeKind: row.calleeKind,
            file: row.file,
        }));
    }
    /**
     * Transitive Blast Radius (Impact Analysis)
     */
    async getBlastRadius(symbolName, maxDepth = 3) {
        const targetSym = await this.getSymbolDefinition(symbolName);
        const targetFile = targetSym?.file ?? 'unknown';
        const safeDepth = Math.min(Math.max(1, Math.floor(Number(maxDepth)) || 3), 10);
        // Cypher path traversal up to safeDepth
        const query = `
      MATCH path = (caller:Symbol)-[:CALLS*1..${safeDepth}]->(target:Symbol)
      WHERE target.name = $symbolName OR target.qname = $symbolName
      RETURN length(path) AS depth,
             caller.name AS callerName,
             caller.qname AS callerQName,
             caller.file AS callerFile,
             caller.startLine AS callerLine,
             target.name AS targetName
    `;
        const res = await this.graph.query(query, { params: { symbolName } });
        const rows = (res.data ?? []);
        const affectedFilesSet = new Set();
        const callChain = [];
        for (const r of rows) {
            affectedFilesSet.add(r.callerFile);
            callChain.push({
                depth: r.depth,
                callerName: r.callerName,
                callerQName: r.callerQName,
                callerFile: r.callerFile,
                callerLine: r.callerLine,
                calleeName: r.targetName,
            });
        }
        const affectedFiles = Array.from(affectedFilesSet);
        const affectedTests = await this.getAffectedTests([targetFile, ...affectedFiles]);
        // Risk score calculation
        const count = callChain.length;
        let level = 'low';
        const reasons = [];
        if (count === 0) {
            level = 'low';
            reasons.push('No callers found. Likely private or unused entry point.');
        }
        else if (count < 5 && affectedFiles.length <= 2) {
            level = 'medium';
            reasons.push(`Direct impact bounded to ${affectedFiles.length} files (${count} callers).`);
        }
        else if (count < 20) {
            level = 'high';
            reasons.push(`Widespread impact: ${count} callers across ${affectedFiles.length} files.`);
        }
        else {
            level = 'critical';
            reasons.push(`Massive blast radius: ${count} callers across ${affectedFiles.length} files. High regression risk.`);
        }
        if (affectedTests.length === 0) {
            reasons.push('WARNING: No automated test files detected for affected code paths.');
        }
        else {
            reasons.push(`${affectedTests.length} test suites can verify these changes.`);
        }
        return {
            targetSymbol: symbolName,
            targetFile,
            depth: maxDepth,
            totalAffectedCallers: count,
            affectedFiles,
            callChain,
            affectedTests,
            riskAssessment: {
                level,
                score: Math.min(100, count * 5 + affectedFiles.length * 10),
                reasons,
            },
        };
    }
    /**
     * Detect Circular Import / Call Dependencies
     */
    async detectCycles() {
        const res = await this.graph.query(`MATCH path = (f1:File)-[:IMPORTS*2..6]->(f1)
       RETURN [n in nodes(path) | n.path] AS cycleNodes
       LIMIT 20`);
        const cycles = [];
        const seen = new Set();
        for (const row of (res.data ?? [])) {
            const nodes = row.cycleNodes;
            const key = [...nodes].sort().join('->');
            if (!seen.has(key)) {
                seen.add(key);
                cycles.push({
                    nodes,
                    formatted: nodes.join(' ➔ '),
                });
            }
        }
        return {
            hasCycles: cycles.length > 0,
            cycleCount: cycles.length,
            cycles,
        };
    }
    /**
     * Find affected tests for given source files
     */
    async getAffectedTests(sourceFiles) {
        const testFiles = new Set();
        for (const src of sourceFiles) {
            // 1. By naming convention (e.g. foo.ts -> foo.test.ts or test_foo.py)
            const baseName = src.replace(/\.[^/.]+$/, '');
            const namingRes = await this.graph.query(`MATCH (f:File {isTest: true})
         WHERE f.path CONTAINS $baseName
         RETURN f.path AS path`, { params: { baseName } });
            for (const r of (namingRes.data ?? [])) {
                testFiles.add(r.path);
            }
            // 2. By import relationship: test file imports source file
            const importRes = await this.graph.query(`MATCH (tf:File {isTest: true})-[:IMPORTS]->(sf:File {path: $src})
         RETURN tf.path AS path`, { params: { src } });
            for (const r of (importRes.data ?? [])) {
                testFiles.add(r.path);
            }
        }
        return Array.from(testFiles);
    }
    /**
     * Synthesize Porting Contract for cross-language migration
     */
    async getPortingContract(symbolName) {
        const sym = await this.getSymbolDefinition(symbolName);
        if (!sym)
            return null;
        // Callees
        const callees = await this.getCallees(symbolName);
        // Types/members if it's a class or interface
        const membersRes = await this.graph.query(`MATCH (s:Symbol {file: $file})
       WHERE s.qname STARTS WITH $prefix AND s.name <> $name
       RETURN s.name AS name, s.kind AS kind, s.signature AS signature, s.docstring AS docstring`, {
            params: {
                file: sym.file,
                prefix: `${sym.name}.`,
                name: sym.name,
            },
        });
        const typesAndMembers = (membersRes.data ?? []).map((r) => ({
            name: r.name,
            kind: r.kind,
            signature: r.signature,
            docstring: r.docstring,
        }));
        // Governing rules / ADRs
        const rulesRes = await this.graph.query(`MATCH (r:Rule)
       WHERE r.content CONTAINS $name OR r.title CONTAINS $name
       RETURN r.title AS title, r.content AS content`, { params: { name: sym.name } });
        const governingRules = (rulesRes.data ?? []).map((r) => ({
            title: r.title,
            content: r.content,
        }));
        const relatedTests = await this.getAffectedTests([sym.file]);
        return {
            symbolName: sym.name,
            qname: sym.qname,
            kind: sym.kind,
            file: sym.file,
            language: sym.file.endsWith('.py')
                ? 'python'
                : sym.file.endsWith('.go')
                    ? 'go'
                    : sym.file.endsWith('.rs')
                        ? 'rust'
                        : 'typescript',
            signature: sym.signature,
            docstring: sym.docstring ?? '',
            exported: sym.isExported ?? false,
            dependencies: {
                importedTypes: [],
                callees: callees.map((c) => ({
                    name: c.calleeName,
                    qname: c.calleeQName,
                    file: c.file,
                })),
            },
            typesAndMembers,
            relatedTests,
            governingRules,
        };
    }
    /**
     * Search knowledge base
     */
    async searchKnowledge(query, limit = 10) {
        const results = [];
        // Search doc sections
        const secRes = await this.graph.query(`MATCH (sec:DocSection)
       WHERE sec.title CONTAINS $query OR sec.content CONTAINS $query
       OPTIONAL MATCH (sec)-[:DOCUMENTS]->(sym:Symbol)
       RETURN sec.title AS title, sec.content AS content, sec.documentPath AS path, collect(sym.name) AS symbols
       LIMIT $limit`, { params: { query, limit } });
        for (const r of (secRes.data ?? [])) {
            results.push({
                type: 'section',
                title: r.title,
                snippet: r.content.slice(0, 300),
                path: r.path,
                linkedSymbols: r.symbols,
            });
        }
        // Search rules
        const ruleRes = await this.graph.query(`MATCH (r:Rule)
       WHERE r.title CONTAINS $query OR r.content CONTAINS $query
       RETURN r.title AS title, r.content AS content, r.priority AS priority, r.sourceDoc AS path
       LIMIT $limit`, { params: { query, limit } });
        for (const r of (ruleRes.data ?? [])) {
            results.push({
                type: 'rule',
                title: r.title,
                snippet: r.content,
                path: r.path,
                priority: r.priority,
            });
        }
        return results;
    }
    /**
     * Get full document or concept
     */
    async getKnowledgeDoc(pathOrTitle) {
        const docRes = await this.graph.query(`MATCH (d:Document)
       WHERE d.path = $query OR d.title = $query
       RETURN d.title AS title, d.path AS path, d.category AS category LIMIT 1`, { params: { query: pathOrTitle } });
        const docData = docRes.data;
        if (!docData || docData.length === 0)
            return null;
        const doc = docData[0];
        const secRes = await this.graph.query(`MATCH (d:Document {path: $path})-[:HAS_SECTION]->(s:DocSection)
       RETURN s.title AS title, s.content AS content, s.level AS level
       ORDER BY s.startLine ASC`, { params: { path: doc.path } });
        const ruleRes = await this.graph.query(`MATCH (d:Document {path: $path})-[:HAS_RULE]->(r:Rule)
       RETURN r.title AS title, r.content AS content, r.priority AS priority`, { params: { path: doc.path } });
        return {
            title: doc.title,
            path: doc.path,
            category: doc.category,
            sections: (secRes.data ?? []).map((s) => ({
                title: s.title,
                content: s.content,
                level: s.level,
            })),
            rules: (ruleRes.data ?? []).map((r) => ({
                title: r.title,
                content: r.content,
                priority: r.priority,
            })),
        };
    }
    /**
     * Graph statistics
     */
    async getStats() {
        const fRes = await this.graph.query(`MATCH (f:File) RETURN count(f) AS cnt, f.language AS lang`);
        const sRes = await this.graph.query(`MATCH (s:Symbol) RETURN count(s) AS cnt`);
        const cRes = await this.graph.query(`MATCH ()-[r:CALLS]->() RETURN count(r) AS cnt`);
        const dRes = await this.graph.query(`MATCH (d:Document) RETURN count(d) AS cnt`);
        const secRes = await this.graph.query(`MATCH (sec:DocSection) RETURN count(sec) AS cnt`);
        const rRes = await this.graph.query(`MATCH (r:Rule) RETURN count(r) AS cnt`);
        let totalFiles = 0;
        const languages = {};
        for (const row of (fRes.data ?? [])) {
            totalFiles += row.cnt;
            if (row.lang) {
                languages[row.lang] = (languages[row.lang] ?? 0) + row.cnt;
            }
        }
        const sData = (sRes.data ?? []);
        const cData = (cRes.data ?? []);
        const dData = (dRes.data ?? []);
        const secData = (secRes.data ?? []);
        const rData = (rRes.data ?? []);
        return {
            totalFiles,
            totalSymbols: sData[0]?.cnt ?? 0,
            totalCalls: cData[0]?.cnt ?? 0,
            totalDocs: dData[0]?.cnt ?? 0,
            totalSections: secData[0]?.cnt ?? 0,
            totalRules: rData[0]?.cnt ?? 0,
            languages,
        };
    }
    /**
     * Find shortest call path between two symbols
     */
    async findCallPath(fromSymbol, toSymbol) {
        const res = await this.graph.query(`MATCH path = (src:Symbol)-[:CALLS*1..12]->(dst:Symbol)
       WHERE (src.name = $from OR src.qname = $from) AND (dst.name = $to OR dst.qname = $to)
       RETURN length(path) AS hops, nodes(path) AS pathNodes
       ORDER BY hops ASC
       LIMIT 1`, { params: { from: fromSymbol, to: toSymbol } });
        const rows = (res.data ?? []);
        if (rows.length === 0 || !rows[0].pathNodes) {
            return {
                found: false,
                fromSymbol,
                toSymbol,
                hops: 0,
                path: [],
                formatted: `No call path found from \`${fromSymbol}\` to \`${toSymbol}\` within 12 hops.`,
            };
        }
        const rawNodes = rows[0].pathNodes;
        const path = rawNodes.map((n) => {
            const props = n.properties ?? n;
            return {
                name: props.name ?? '',
                qname: props.qname ?? props.name ?? '',
                kind: props.kind ?? 'function',
                file: props.file ?? '',
                line: props.startLine ?? props.line ?? 0,
            };
        });
        const formatted = path
            .map((p, idx) => `${idx + 1}. \`${p.qname}\` (${p.kind}) at \`${p.file}:${p.line}\``)
            .join(' ➔\n');
        return {
            found: true,
            fromSymbol,
            toSymbol,
            hops: rows[0].hops ?? path.length - 1,
            path,
            formatted,
        };
    }
    /**
     * Find subtypes and classes implementing/extending a symbol
     */
    async findSubtypesAndImplementations(symbolName) {
        const res = await this.graph.query(`MATCH (sub:Symbol)-[r:EXTENDS|IMPLEMENTS]->(target:Symbol)
       WHERE target.name = $name OR target.qname = $name
       RETURN sub.name AS name, sub.qname AS qname, sub.kind AS kind, sub.file AS file,
              sub.startLine AS startLine, sub.signature AS signature, type(r) AS rel
       ORDER BY sub.file, sub.startLine`, { params: { name: symbolName } });
        return (res.data ?? []).map((row) => ({
            name: row.name ?? '',
            qname: row.qname ?? row.name ?? '',
            kind: row.kind ?? 'class',
            file: row.file ?? '',
            startLine: row.startLine ?? 0,
            signature: row.signature ?? '',
            relationship: row.rel === 'IMPLEMENTS' ? 'IMPLEMENTS' : 'EXTENDS',
        }));
    }
    /**
     * Find unused unexported symbols with 0 incoming calls in workspace
     */
    async findUnusedSymbols(limit = 50) {
        const res = await this.graph.query(`MATCH (s:Symbol)
       WHERE NOT ()-[:CALLS]->(s)
         AND s.isExported = false
         AND NOT s.file CONTAINS 'test'
         AND NOT s.file CONTAINS 'spec'
       RETURN s.name AS name, s.qname AS qname, s.kind AS kind, s.file AS file,
              s.startLine AS startLine, s.isExported AS isExported
       ORDER BY s.file, s.startLine
       LIMIT $limit`, { params: { limit } });
        return (res.data ?? []).map((r) => ({
            name: r.name,
            qname: r.qname ?? r.name,
            kind: r.kind,
            file: r.file,
            startLine: r.startLine,
            isExported: r.isExported ?? false,
            reason: 'Unexported internal symbol with 0 incoming call invocations in workspace',
        }));
    }
    /**
     * Analyze semantic impact of current git diff
     */
    async analyzeGitDiffImpact(workdir, baseRef) {
        const diffs = getWorkspaceGitDiff(workdir, baseRef);
        if (diffs.length === 0) {
            return {
                filesChanged: 0,
                modifiedFiles: [],
                impactedSymbols: [],
                totalTransitiveCallers: 0,
                affectedTests: [],
                overallRisk: 'low',
                summary: 'No git diff changes detected in workspace.',
            };
        }
        const modifiedFiles = diffs.map((d) => d.file);
        const impactedSymbols = [];
        let totalTransitiveCallers = 0;
        for (const diff of diffs) {
            const symRes = await this.graph.query(`MATCH (s:Symbol {file: $file})
         RETURN s.name AS name, s.qname AS qname, s.kind AS kind, s.file AS file,
                s.startLine AS startLine, s.endLine AS endLine`, { params: { file: diff.file } });
            for (const row of (symRes.data ?? [])) {
                const start = row.startLine ?? 0;
                const end = row.endLine ?? start;
                const overlaps = diff.changedLines.length === 0 ||
                    diff.changedLines.some((r) => (r.start >= start && r.start <= end) ||
                        (r.end >= start && r.end <= end) ||
                        (r.start <= start && r.end >= end));
                if (overlaps) {
                    impactedSymbols.push({
                        name: row.name,
                        qname: row.qname ?? row.name,
                        kind: row.kind,
                        file: row.file,
                        line: row.startLine,
                        changeType: diff.changeType,
                    });
                    const callerRes = await this.graph.query(`MATCH ()-[:CALLS]->(s:Symbol {name: $name, file: $file}) RETURN count(*) AS cnt`, { params: { name: row.name, file: row.file } });
                    const cCnt = callerRes.data?.[0]?.cnt ?? 0;
                    totalTransitiveCallers += cCnt;
                }
            }
        }
        const affectedTests = await this.getAffectedTests(modifiedFiles);
        let overallRisk = 'low';
        if (totalTransitiveCallers > 20 || modifiedFiles.length > 10) {
            overallRisk = 'critical';
        }
        else if (totalTransitiveCallers > 8 || modifiedFiles.length > 4) {
            overallRisk = 'high';
        }
        else if (totalTransitiveCallers > 2 || modifiedFiles.length > 1) {
            overallRisk = 'medium';
        }
        const summary = `Git diff analysis: ${modifiedFiles.length} files modified, ${impactedSymbols.length} symbols directly impacted, ${totalTransitiveCallers} incoming callers affected, ${affectedTests.length} test suites mapped.`;
        return {
            filesChanged: modifiedFiles.length,
            modifiedFiles,
            impactedSymbols,
            totalTransitiveCallers,
            affectedTests,
            overallRisk,
            summary,
        };
    }
    /**
     * Generate cross-paradigm porting blueprint (OOP to Functional/Rust/Go OR Functional to OOP Java/C#)
     */
    async generateCrossParadigmBlueprint(symbolName, targetLanguage = 'rust') {
        const sym = await this.getSymbolDefinition(symbolName);
        const supertypes = await this.graph.query(`MATCH (sub:Symbol)-[r:EXTENDS|IMPLEMENTS]->(sup:Symbol)
       WHERE sub.name = $name OR sub.qname = $name
       RETURN sup.name AS name, sup.kind AS kind, type(r) AS rel`, { params: { name: symbolName } });
        const membersRes = await this.graph.query(`MATCH (c:Symbol)-[:CONTAINS]->(m:Symbol)
       WHERE c.name = $name OR c.qname = $name
       RETURN m.name AS name, m.kind AS kind, m.signature AS signature, m.docstring AS docstring`, { params: { name: symbolName } });
        const members = (membersRes.data ?? []);
        const supRows = (supertypes.data ?? []);
        const structs = [];
        const traits = [];
        const errorEnums = [];
        const ownershipGuidelines = [];
        // Main struct / class fields
        const fields = [];
        const methods = [];
        for (const m of members) {
            if (m.kind === 'variable' || m.kind === 'constant') {
                fields.push({ name: m.name, type: 'String', optional: false });
            }
            else {
                const isMut = m.signature?.includes('set') || m.signature?.includes('update') || m.signature?.includes('mutate');
                methods.push({
                    name: m.name,
                    signature: m.signature ?? '',
                    isMut: !!isMut,
                });
            }
        }
        structs.push({
            name: sym?.name ?? symbolName,
            fields,
        });
        // Convert super interfaces and abstract classes to traits / interfaces
        for (const sup of supRows) {
            traits.push({
                name: sup.name,
                methods: [
                    {
                        name: `execute_${sup.name.toLowerCase()}`,
                        signature: `fn execute_${sup.name.toLowerCase()}(&self) -> Result<(), ${sym?.name ?? symbolName}Error>`,
                        isMut: false,
                    },
                ],
            });
        }
        errorEnums.push({
            name: `${sym?.name ?? symbolName}Error`,
            variants: ['NotFound', 'InvalidInput(String)', 'Internal(String)'],
        });
        const structName = sym?.name ?? symbolName;
        let idiomaticSkeleton = '';
        if (targetLanguage === 'rust') {
            ownershipGuidelines.push('FLATTEN INHERITANCE: Rust has no class inheritance. Convert all base classes to Traits and compose fields into a single struct.', 'OWNERSHIP & BORROWING: Avoid cyclic references between parent and child objects. Use ID-based referencing (e.g. `u32` or `Uuid`) instead of bidirectional `Rc<RefCell<T>>`.', 'ERROR HANDLING: Replace runtime exceptions (`throw new Exception`) with idiomatic `Result<T, ' + (sym?.name ?? symbolName) + 'Error>`.', 'CONCURRENCY: If instances are shared across threads, wrap with `Arc<RwLock<T>>` or `Arc<Mutex<T>>` instead of Java `synchronized`.');
            idiomaticSkeleton =
                `// Idiomatic Rust Blueprint for ${structName}\n` +
                    `#[derive(Debug, Clone, Default)]\n` +
                    `pub struct ${structName} {\n` +
                    fields.map((f) => `    pub ${f.name}: ${f.type},\n`).join('') +
                    `}\n\n` +
                    `#[derive(Debug, thiserror::Error)]\n` +
                    `pub enum ${structName}Error {\n` +
                    `    #[error("Resource not found")]\n    NotFound,\n` +
                    `    #[error("Invalid argument: {0}")]\n    InvalidInput(String),\n` +
                    `}\n\n` +
                    `impl ${structName} {\n` +
                    `    pub fn new() -> Self {\n        Self::default()\n    }\n` +
                    methods.map((m) => `    pub fn ${m.name}(&${m.isMut ? 'mut ' : ''}self) -> Result<(), ${structName}Error> {\n        todo!()\n    }\n`).join('') +
                    `}\n`;
        }
        else if (targetLanguage === 'go') {
            ownershipGuidelines.push('FLATTEN INHERITANCE: Go uses struct embedding and implicit interfaces. Define interfaces where consumed, not where implemented.', 'ERROR HANDLING: Return `(T, error)` tuples explicitly rather than throwing exceptions.', 'POINTER RECEIVERS: Use pointer receivers `func (s *' + (sym?.name ?? symbolName) + ')` for methods modifying state.');
            idiomaticSkeleton =
                `// Idiomatic Go Blueprint for ${structName}\n` +
                    `type ${structName} struct {\n` +
                    fields.map((f) => `\t${f.name} string\n`).join('') +
                    `}\n\n` +
                    `func New${structName}() *${structName} {\n\treturn &${structName}{}\n}\n`;
        }
        else if (targetLanguage === 'java') {
            ownershipGuidelines.push('ENCAPSULATION: Wrap data members in private fields with getters and setters, or use Java 17+ Records for immutable DTOs.', 'CONVERT TRAITS TO INTERFACES: Convert Rust traits or Go interfaces to explicit Java `public interface` and `implements` clauses.', 'EXCEPTION HIERARCHY: Convert functional `Result<T, E>` or Go `error` returns to checked/unchecked Java exceptions (`throws ${structName}Exception`).', 'POLYMORPHIC ENUMS: Convert Rust algebraic enums to Java 17+ `sealed interface` with `permits` or standard Polymorphic class hierarchies.');
            const traitImplements = traits.length > 0 ? ` implements ${traits.map((t) => t.name).join(', ')}` : '';
            idiomaticSkeleton =
                `// Idiomatic Java OOP Blueprint for ${structName}\n` +
                    `package com.example.service;\n\n` +
                    `public class ${structName}${traitImplements} {\n` +
                    fields.map((f) => `    private ${f.type} ${f.name};\n`).join('') +
                    `\n    public ${structName}() {}\n\n` +
                    fields.map((f) => `    public ${f.type} get${f.name.charAt(0).toUpperCase() + f.name.slice(1)}() {\n        return this.${f.name};\n    }\n\n    public void set${f.name.charAt(0).toUpperCase() + f.name.slice(1)}(${f.type} val) {\n        this.${f.name} = val;\n    }\n`).join('\n') +
                    methods.map((m) => `    public void ${m.name}() throws ${structName}Exception {\n        // TODO: Implement method logic\n    }\n`).join('\n') +
                    `}\n`;
        }
        else {
            ownershipGuidelines.push('PROPERTIES & INTERFACES: Use auto-implemented properties `{ get; set; }` and explicit interface inheritance with `:` syntax.', 'NULLABLE REFERENCE TYPES: Enable C# nullable reference types (`string?`) to capture Rust `Option<T>` safety.');
            const traitColon = traits.length > 0 ? ` : ${traits.map((t) => t.name).join(', ')}` : '';
            idiomaticSkeleton =
                `// Idiomatic C# OOP Blueprint for ${structName}\n` +
                    `namespace App.Services;\n\n` +
                    `public class ${structName}${traitColon}\n{\n` +
                    fields.map((f) => `    public string ${f.name.charAt(0).toUpperCase() + f.name.slice(1)} { get; set; }\n`).join('') +
                    methods.map((m) => `    public void ${m.name}()\n    {\n        // TODO: Implement method logic\n    }\n`).join('\n') +
                    `}\n`;
        }
        return {
            symbolName: sym?.name ?? symbolName,
            sourceKind: sym?.kind ?? 'class',
            sourceLanguage: sym?.file ? (sym.file.endsWith('.java') ? 'java' : sym.file.endsWith('.rs') ? 'rust' : 'typescript') : 'code',
            targetLanguage,
            structs,
            traits,
            errorEnums,
            ownershipGuidelines,
            idiomaticSkeleton,
        };
    }
    /**
     * Extract 3rd-party library usage slice to facilitate slim re-implementation from scratch OR recommend target ecosystem packages
     */
    async extractThirdPartyUsageSlice(libraryPrefix, targetLanguage = 'rust') {
        const importRes = await this.graph.query(`MATCH (f:File)-[r:IMPORTS]->(target)
       WHERE r.importedPath CONTAINS $prefix OR target.path CONTAINS $prefix
       RETURN r.importedPath AS path, r.specifiers AS specifiers, f.path AS filePath`, { params: { prefix: libraryPrefix } });
        const importedSymbolsSet = new Set();
        const fileSet = new Set();
        for (const row of (importRes.data ?? [])) {
            fileSet.add(row.filePath);
            if (typeof row.specifiers === 'string') {
                for (const s of row.specifiers.split(',')) {
                    const trimmed = s.trim();
                    if (trimmed && trimmed !== '*')
                        importedSymbolsSet.add(trimmed);
                }
            }
            else if (Array.isArray(row.specifiers)) {
                for (const s of row.specifiers) {
                    if (s !== '*')
                        importedSymbolsSet.add(s);
                }
            }
        }
        const callsRes = await this.graph.query(`MATCH (caller:Symbol)-[r:CALLS]->(callee)
       MATCH (f:File {path: caller.file})-[:IMPORTS]->(pkg)
       WHERE pkg.path CONTAINS $prefix OR r.calleeName CONTAINS $prefix
       RETURN r.calleeName AS name, callee.name AS qname, caller.file AS callerFile, r.line AS line`, { params: { prefix: libraryPrefix } });
        const methodMap = new Map();
        for (const row of (callsRes.data ?? [])) {
            const name = row.name ?? 'unknown';
            const existing = methodMap.get(name) ?? {
                qname: row.qname ?? name,
                callCount: 0,
                files: new Set(),
                exampleLine: row.line ?? 0,
            };
            existing.callCount++;
            if (row.callerFile)
                existing.files.add(row.callerFile);
            methodMap.set(name, existing);
        }
        // If calls weren't resolved by static callee edges, check imported symbols
        if (methodMap.size === 0 && importedSymbolsSet.size > 0) {
            for (const sym of importedSymbolsSet) {
                methodMap.set(sym, {
                    qname: `${libraryPrefix}.${sym}`,
                    callCount: 1,
                    files: fileSet,
                    exampleLine: 1,
                });
            }
        }
        const invokedMethods = Array.from(methodMap.entries()).map(([name, val]) => ({
            name,
            qname: val.qname,
            callCount: val.callCount,
            callerFiles: Array.from(val.files),
            exampleLine: val.exampleLine,
        }));
        const totalCallSites = invokedMethods.reduce((sum, m) => sum + m.callCount, 0);
        const minimalTypes = [`Slim${libraryPrefix.replace(/[^a-zA-Z0-9]/g, '')}Client`];
        const minimalFunctions = invokedMethods.map((m) => `fn ${m.name}(...)`);
        const estimatedLinesToImplement = Math.max(30, invokedMethods.length * 20);
        // Look up target ecosystem recommended package
        const recommendedPackages = [];
        const lowerPrefix = libraryPrefix.toLowerCase();
        const matchedCategoryKey = Object.keys(ECOSYSTEM_KNOWLEDGE_BASE).find((k) => lowerPrefix.includes(k));
        if (matchedCategoryKey) {
            const catEntry = ECOSYSTEM_KNOWLEDGE_BASE[matchedCategoryKey];
            const targetEq = catEntry.equivalents[targetLanguage.toLowerCase()] ?? catEntry.equivalents['rust'];
            if (targetEq) {
                recommendedPackages.push({
                    ecosystem: targetLanguage.toLowerCase() === 'rust'
                        ? 'crates.io'
                        : targetLanguage.toLowerCase() === 'go'
                            ? 'pkg.go.dev'
                            : targetLanguage.toLowerCase() === 'java'
                                ? 'maven'
                                : targetLanguage.toLowerCase() === 'python'
                                    ? 'pypi'
                                    : 'npm',
                    packageName: targetEq.pkg,
                    installCommand: targetEq.install,
                    description: targetEq.desc,
                    methodMappings: invokedMethods.map((m) => ({
                        sourceMethod: m.name,
                        targetMethod: targetEq.pkg.includes('moka') && m.name === 'put' ? 'insert' : m.name,
                    })),
                });
            }
        }
        return {
            libraryPrefix,
            totalCallSites,
            importedSymbols: Array.from(importedSymbolsSet),
            invokedMethods,
            suggestedPolyfillSpec: {
                summary: `The codebase relies on ${invokedMethods.length} functions from '${libraryPrefix}' across ${totalCallSites} call sites. You can either write a slim polyfill of ~${estimatedLinesToImplement} lines from scratch, OR install the recommended target ecosystem package.`,
                minimalTypes,
                minimalFunctions,
                estimatedLinesToImplement,
            },
            recommendedPackages,
        };
    }
    /**
     * Find duplicate or structurally similar functions (Type-1 & Type-2 clone detection)
     */
    async findSimilarFunctions(options) {
        const minLines = options?.minLines ?? 3;
        let cypher = `
      MATCH (s1:Symbol), (s2:Symbol)
      WHERE s1.id < s2.id
        AND (s1.kind = 'function' OR s1.kind = 'method')
        AND (s2.kind = 'function' OR s2.kind = 'method')
        AND s1.structuralHash <> ''
        AND s1.structuralHash = s2.structuralHash
        AND (s1.endLine - s1.startLine >= $minLines)
    `;
        const params = { minLines };
        if (options?.targetSymbol) {
            cypher += ` AND (s1.name = $target OR s1.qname = $target OR s2.name = $target OR s2.qname = $target)`;
            params.target = options.targetSymbol;
        }
        cypher += `
      RETURN s1.name AS s1Name, s1.qname AS s1QName, s1.file AS s1File, s1.startLine AS s1Line, s1.signature AS s1Sig,
             s2.name AS s2Name, s2.qname AS s2QName, s2.file AS s2File, s2.startLine AS s2Line, s2.signature AS s2Sig
      LIMIT 25
    `;
        const res = await this.graph.query(cypher, { params });
        const results = [];
        for (const r of (res.data ?? [])) {
            const isExact = r.s1Sig === r.s2Sig && r.s1Name === r.s2Name;
            results.push({
                sourceSymbol: {
                    name: r.s1Name,
                    qname: r.s1QName ?? r.s1Name,
                    file: r.s1File,
                    line: r.s1Line,
                    signature: r.s1Sig ?? '',
                },
                targetSymbol: {
                    name: r.s2Name,
                    qname: r.s2QName ?? r.s2Name,
                    file: r.s2File,
                    line: r.s2Line,
                    signature: r.s2Sig ?? '',
                },
                similarityPercent: isExact ? 100 : 95,
                cloneType: isExact ? 'Type-1 (Exact)' : 'Type-2 (Variable Renamed)',
                differingVariables: [
                    { sourceVar: r.s1Name, targetVar: r.s2Name },
                ],
                suggestedRefactoring: `Extract shared subroutine '${r.s1Name}' to a common utility/helper module and eliminate duplicate implementation in '${r.s2File}'.`,
            });
        }
        return results;
    }
    /**
     * Find all code symbols and execution call-flow implementing a feature specified in *.md
     */
    async findCodeFlowForFeature(query, flowDepth = 3) {
        const depth = Math.min(6, Math.max(1, flowDepth));
        // 1. Locate matching DocSection or Document
        const secRes = await this.graph.query(`MATCH (sec:DocSection)
       WHERE sec.title CONTAINS $q OR sec.content CONTAINS $q OR sec.documentPath CONTAINS $q
       RETURN sec.id AS id, sec.title AS title, sec.documentPath AS docPath, sec.content AS content
       LIMIT 1`, { params: { q: query } });
        let secRow = secRes.data?.[0] ?? null;
        if (!secRow) {
            // Fallback: search document
            const docRes = await this.graph.query(`MATCH (d:Document)
         WHERE d.title CONTAINS $q OR d.path CONTAINS $q
         MATCH (d)-[:HAS_SECTION]->(sec:DocSection)
         RETURN sec.id AS id, sec.title AS title, d.path AS docPath, sec.content AS content
         LIMIT 1`, { params: { q: query } });
            secRow = docRes.data?.[0] ?? null;
        }
        if (!secRow) {
            return {
                featureName: query,
                specFile: '',
                specSection: '',
                description: `No specification section found matching "${query}".`,
                entrySymbols: [],
                executionFlow: [],
                totalSymbolsInvolved: 0,
                filesInvolved: [],
                mermaidDiagram: '',
            };
        }
        // 2. Find directly linked entry symbols (from matched section OR its subsections if top-level)
        const entryRes = await this.graph.query(`MATCH (sec:DocSection {id: $secId})
       MATCH (d:Document {path: sec.documentPath})-[:HAS_SECTION]->(s:DocSection)
       WHERE s.id = $secId OR (sec.level = 1)
       MATCH (s)-[:DOCUMENTS]->(sym:Symbol)
       RETURN DISTINCT sym.name AS name, sym.qname AS qname, sym.kind AS kind, sym.file AS file, sym.startLine AS line`, { params: { secId: secRow.id } });
        const entrySymbols = (entryRes.data ?? []).map((r) => ({
            name: r.name,
            qname: r.qname ?? r.name,
            kind: r.kind,
            file: r.file,
            line: r.line,
        }));
        // 3. Downward call-flow traversal from entry symbols
        const executionFlow = [];
        const filesSet = new Set();
        const visitedFlowKeys = new Set();
        const mermaidEdges = [];
        for (const entry of entrySymbols) {
            filesSet.add(entry.file);
            executionFlow.push({
                name: entry.name,
                qname: entry.qname,
                kind: entry.kind,
                file: entry.file,
                line: entry.line,
                depth: 0,
            });
            const safeDepth = Math.min(Math.max(1, Math.floor(Number(depth)) || 3), 10);
            // Query downstream call paths
            const pathRes = await this.graph.query(`MATCH path = (entry:Symbol)-[:CALLS*1..${safeDepth}]->(downstream:Symbol)
         WHERE entry.name = $name OR entry.qname = $name
         RETURN length(path) AS hop,
                [n in nodes(path) | { name: n.name, qname: n.qname, kind: n.kind, file: n.file, line: n.startLine }] AS pathNodes
         LIMIT 30`, { params: { name: entry.name } });
            for (const row of (pathRes.data ?? [])) {
                const pNodes = row.pathNodes;
                for (let i = 1; i < pNodes.length; i++) {
                    const prev = pNodes[i - 1];
                    const curr = pNodes[i];
                    filesSet.add(curr.file);
                    mermaidEdges.push({ from: prev.name, to: curr.name });
                    const flowKey = `${curr.file}:${curr.name}`;
                    if (!visitedFlowKeys.has(flowKey)) {
                        visitedFlowKeys.add(flowKey);
                        executionFlow.push({
                            name: curr.name,
                            qname: curr.qname ?? curr.name,
                            kind: curr.kind,
                            file: curr.file,
                            line: curr.line,
                            depth: i,
                            callerName: prev.name,
                        });
                    }
                }
            }
        }
        // Generate Mermaid graph
        const sanitizeNodeId = (id) => id.replace(/[^a-zA-Z0-9_]/g, '_');
        let mermaidDiagram = 'graph TD\n';
        if (mermaidEdges.length === 0 && entrySymbols.length > 0) {
            const eId = sanitizeNodeId(entrySymbols[0].name);
            mermaidDiagram += `  ${eId}["${entrySymbols[0].name} (Entry)"]\n`;
        }
        else {
            const uniqueEdges = new Set();
            for (const e of mermaidEdges) {
                const fromId = sanitizeNodeId(e.from);
                const toId = sanitizeNodeId(e.to);
                const edgeStr = `  ${fromId} --> ${toId}`;
                if (!uniqueEdges.has(edgeStr)) {
                    uniqueEdges.add(edgeStr);
                    mermaidDiagram += `${edgeStr}\n`;
                }
            }
        }
        return {
            featureName: secRow.title,
            specFile: secRow.docPath,
            specSection: secRow.title,
            description: secRow.content?.substring(0, 300) ?? '',
            entrySymbols,
            executionFlow,
            totalSymbolsInvolved: executionFlow.length,
            filesInvolved: Array.from(filesSet),
            mermaidDiagram,
        };
    }
    /**
     * Find which features, specs (*.md), and rules a function or class is used in
     */
    async findSpecFeaturesForSymbol(symbolName, searchCallers = true) {
        const sym = await this.getSymbolDefinition(symbolName);
        // 1. Direct documentation links
        const directRes = await this.graph.query(`MATCH (sec:DocSection)-[:DOCUMENTS]->(s:Symbol)
       WHERE s.name = $name OR s.qname = $name
       RETURN sec.documentPath AS specFile, sec.title AS sectionTitle, sec.content AS content, 'documents' AS rel
       UNION
       MATCH (r:Rule)-[:GOVERNS]->(s:Symbol)
       WHERE s.name = $name OR s.qname = $name
       RETURN r.sourceDoc AS specFile, r.title AS sectionTitle, r.content AS content, 'governs' AS rel`, { params: { name: symbolName } });
        const directSpecs = (directRes.data ?? []).map((r) => ({
            specFile: r.specFile,
            sectionTitle: r.sectionTitle,
            relation: r.rel,
            contentSnippet: r.content?.substring(0, 180) ?? '',
        }));
        // 2. Indirect features via upstream callers
        const indirectFeatures = [];
        if (searchCallers) {
            const upRes = await this.graph.query(`MATCH path = (root:Symbol)-[:CALLS*1..4]->(target:Symbol)
         WHERE (target.name = $name OR target.qname = $name)
         MATCH (sec:DocSection)-[:DOCUMENTS]->(root)
         RETURN sec.title AS featureName, sec.documentPath AS specFile, root.name AS entryPoint,
                [n in nodes(path) | n.name] AS callPath
         LIMIT 15`, { params: { name: symbolName } });
            for (const row of (upRes.data ?? [])) {
                indirectFeatures.push({
                    featureName: row.featureName,
                    specFile: row.specFile,
                    entryPoint: row.entryPoint,
                    callPath: row.callPath ?? [],
                });
            }
        }
        const summary = `Symbol '${symbolName}' is referenced directly in ${directSpecs.length} spec section(s) and serves ${indirectFeatures.length} upstream feature flow(s).`;
        return {
            symbolName: sym?.name ?? symbolName,
            symbolQName: sym?.qname ?? symbolName,
            file: sym?.file ?? 'unknown',
            line: sym?.startLine ?? 0,
            directSpecs,
            indirectFeatures,
            summary,
        };
    }
    /**
     * Ingest a contract entity (XML complexType, OpenAPI schema, or Protobuf message)
     */
    async ingestContractEntity(entity) {
        const entityId = `${entity.file}:${entity.name}`;
        await this.graph.query(`MERGE (c:ContractEntity {id: $id})
       SET c.name = $name, c.format = $format, c.file = $file, c.description = $desc`, {
            params: {
                id: entityId,
                name: entity.name,
                format: entity.format,
                file: entity.file,
                desc: entity.description ?? '',
            },
        });
        for (const f of entity.fields) {
            const fieldId = `${entityId}:${f.name}`;
            await this.graph.query(`MATCH (c:ContractEntity {id: $entityId})
         MERGE (cf:ContractField {id: $fieldId})
         SET cf.name = $name, cf.rawType = $rawType, cf.isRequired = $isRequired, cf.isList = $isList, cf.tagNumber = $tagNumber
         MERGE (c)-[:HAS_FIELD]->(cf)`, {
                params: {
                    entityId,
                    fieldId,
                    name: f.name,
                    rawType: f.rawType,
                    isRequired: f.isRequired ?? false,
                    isList: f.isList ?? false,
                    tagNumber: f.tagNumber ?? 0,
                },
            });
        }
    }
    /**
     * Ingest a storage container (SQL Table, MongoDB Collection, ES Index, Redis Key, Vector Collection)
     */
    async ingestStorageContainer(container) {
        const containerId = `${container.file}:${container.name}:${container.engine}`;
        await this.graph.query(`MERGE (sc:StorageContainer {id: $id})
       SET sc.name = $name, sc.engine = $engine, sc.file = $file, sc.description = $desc`, {
            params: {
                id: containerId,
                name: container.name,
                engine: container.engine,
                file: container.file,
                desc: container.description ?? '',
            },
        });
        for (const a of container.attributes) {
            const attrId = `${containerId}:${a.name}`;
            await this.graph.query(`MATCH (sc:StorageContainer {id: $containerId})
         MERGE (sa:StorageAttribute {id: $attrId})
         SET sa.name = $name, sa.dataType = $dataType, sa.attributeRole = $attributeRole, sa.isNullable = $isNullable, sa.vectorDimension = $vectorDimension
         MERGE (sc)-[:HAS_ATTRIBUTE]->(sa)`, {
                params: {
                    containerId,
                    attrId,
                    name: a.name,
                    dataType: a.dataType,
                    attributeRole: a.attributeRole ?? 'column',
                    isNullable: a.isNullable ?? true,
                    vectorDimension: a.vectorDimension ?? 0,
                },
            });
        }
    }
    /**
     * Map a contract entity to a polyglot storage container (SQL, MongoDB, Redis, ES, Vector DB)
     */
    async schemaMapContractToStorage(contractName, storageTarget, engine) {
        // 1. Locate ContractEntity
        const entityRes = await this.graph.query(`MATCH (c:ContractEntity)
       WHERE c.name = $name OR c.name CONTAINS $name
       RETURN c.id AS id, c.name AS name, c.format AS format, c.file AS file
       LIMIT 1`, { params: { name: contractName } });
        const cRow = entityRes.data?.[0] ?? null;
        if (!cRow) {
            return {
                contractEntity: contractName,
                contractFormat: 'unknown',
                contractFile: '',
                storageContainer: storageTarget ?? 'unknown',
                storageEngine: engine ?? 'sql',
                storageFile: '',
                mappings: [],
                unmappedContractFields: [],
                unmappedStorageAttributes: [],
                overallCompatibility: 'low',
                summary: `Contract entity '${contractName}' not found in graph.`,
            };
        }
        // 2. Fetch contract fields
        const fieldsRes = await this.graph.query(`MATCH (c:ContractEntity {id: $id})-[:HAS_FIELD]->(cf:ContractField)
       RETURN cf.name AS name, cf.rawType AS rawType, cf.isRequired AS isRequired, cf.isList AS isList, cf.tagNumber AS tagNumber`, { params: { id: cRow.id } });
        const contractFields = (fieldsRes.data ?? []).map((f) => ({
            name: f.name,
            rawType: f.rawType,
            isRequired: f.isRequired,
            isList: f.isList,
            tagNumber: f.tagNumber,
        }));
        // 3. Locate target StorageContainer
        let containerQuery = `MATCH (sc:StorageContainer)`;
        const containerParams = {};
        if (storageTarget) {
            containerQuery += ` WHERE sc.name = $target OR sc.name CONTAINS $target`;
            containerParams.target = storageTarget;
            if (engine) {
                containerQuery += ` AND sc.engine = $engine`;
                containerParams.engine = engine;
            }
        }
        else {
            const normName = StorageParser.normalizeIdentifier(cRow.name).replace(/_request|_response|_model|_schema|_dto$/g, '');
            containerQuery += ` WHERE sc.name CONTAINS $normName OR $normName CONTAINS sc.name`;
            containerParams.normName = normName;
        }
        containerQuery += ` RETURN sc.id AS id, sc.name AS name, sc.engine AS engine, sc.file AS file LIMIT 1`;
        let scRes = await this.graph.query(containerQuery, { params: containerParams });
        let scRow = scRes.data?.[0] ?? null;
        if (!scRow) {
            const fallbackRes = await this.graph.query(`MATCH (sc:StorageContainer) RETURN sc.id AS id, sc.name AS name, sc.engine AS engine, sc.file AS file LIMIT 1`);
            scRow = fallbackRes.data?.[0] ?? null;
        }
        if (!scRow) {
            return {
                contractEntity: cRow.name,
                contractFormat: cRow.format,
                contractFile: cRow.file,
                storageContainer: storageTarget ?? 'none',
                storageEngine: engine ?? 'sql',
                storageFile: '',
                mappings: [],
                unmappedContractFields: contractFields.map((f) => f.name),
                unmappedStorageAttributes: [],
                overallCompatibility: 'low',
                summary: `No storage container found in graph matching '${storageTarget ?? cRow.name}'.`,
            };
        }
        // 4. Fetch storage attributes
        const attrRes = await this.graph.query(`MATCH (sc:StorageContainer {id: $id})-[:HAS_ATTRIBUTE]->(sa:StorageAttribute)
       RETURN sa.name AS name, sa.dataType AS dataType, sa.attributeRole AS attributeRole, sa.isNullable AS isNullable, sa.vectorDimension AS vectorDimension`, { params: { id: scRow.id } });
        const storageAttrs = (attrRes.data ?? []).map((a) => ({
            name: a.name,
            dataType: a.dataType,
            attributeRole: a.attributeRole,
            isNullable: a.isNullable,
            vectorDimension: a.vectorDimension,
        }));
        // 5. Match fields to attributes
        const mappings = [];
        const matchedContractFieldSet = new Set();
        const matchedStorageAttrSet = new Set();
        for (const cf of contractFields) {
            let bestMatch = null;
            for (const sa of storageAttrs) {
                const matchResult = StorageParser.matchFieldToAttribute(cf, sa, scRow.engine);
                if (matchResult.matched) {
                    if (!bestMatch || matchResult.confidence > bestMatch.match.confidence) {
                        bestMatch = { attr: sa, match: matchResult };
                    }
                }
            }
            if (bestMatch) {
                matchedContractFieldSet.add(cf.name);
                matchedStorageAttrSet.add(bestMatch.attr.name);
                mappings.push({
                    contractField: cf.name,
                    contractType: cf.rawType,
                    storageAttribute: bestMatch.attr.name,
                    storageType: bestMatch.attr.dataType,
                    storageEngine: scRow.engine,
                    role: bestMatch.attr.attributeRole,
                    confidence: bestMatch.match.confidence,
                    typeStatus: bestMatch.match.typeStatus,
                    note: bestMatch.match.note,
                });
            }
        }
        const unmappedContractFields = contractFields
            .filter((f) => !matchedContractFieldSet.has(f.name))
            .map((f) => f.name);
        const unmappedStorageAttributes = storageAttrs
            .filter((a) => !matchedStorageAttrSet.has(a.name))
            .map((a) => a.name);
        const matchRatio = contractFields.length > 0 ? matchedContractFieldSet.size / contractFields.length : 0;
        const overallCompatibility = matchRatio >= 0.8 ? 'high' : matchRatio >= 0.5 ? 'medium' : 'low';
        const summary = `Mapped ${mappings.length}/${contractFields.length} contract fields to '${scRow.engine.toUpperCase()}' ${scRow.name} (${unmappedContractFields.length} unmapped fields, ${unmappedStorageAttributes.length} unmapped storage attributes).`;
        return {
            contractEntity: cRow.name,
            contractFormat: cRow.format,
            contractFile: cRow.file,
            storageContainer: scRow.name,
            storageEngine: scRow.engine,
            storageFile: scRow.file,
            mappings,
            unmappedContractFields,
            unmappedStorageAttributes,
            overallCompatibility,
            summary,
        };
    }
    /**
     * Analyze blast radius of modifying/dropping a storage attribute against external contracts and code DAOs
     */
    async schemaAnalyzeStorageMigrationImpact(containerName, attributeName, action = 'drop') {
        const scRes = await this.graph.query(`MATCH (sc:StorageContainer)
       WHERE sc.name = $cName OR sc.name CONTAINS $cName
       RETURN sc.name AS name, sc.engine AS engine, sc.file AS file
       LIMIT 1`, { params: { cName: containerName } });
        const scRow = scRes.data?.[0] ?? {
            name: containerName,
            engine: 'sql',
            file: 'schema.sql',
        };
        const normAttr = StorageParser.normalizeIdentifier(attributeName);
        // Find all ContractEntity fields that match this attribute name
        const contractRes = await this.graph.query(`MATCH (c:ContractEntity)-[:HAS_FIELD]->(cf:ContractField)
       RETURN c.name AS entityName, c.format AS format, c.file AS file, cf.name AS fieldName`);
        const impactedContracts = [];
        for (const row of (contractRes.data ?? [])) {
            const normCf = StorageParser.normalizeIdentifier(row.fieldName);
            if (normCf === normAttr || normCf.includes(normAttr) || normAttr.includes(normCf)) {
                impactedContracts.push({
                    entityName: row.entityName,
                    format: row.format,
                    file: row.file,
                    fieldName: row.fieldName,
                });
            }
        }
        // Find code symbols referencing this container or attribute
        const codeRes = await this.graph.query(`MATCH (s:Symbol)
       WHERE s.name CONTAINS $attr OR s.signature CONTAINS $attr
       RETURN s.name AS name, s.qname AS qname, s.file AS file, s.startLine AS line
       LIMIT 20`, { params: { attr: attributeName } });
        const impactedCodeSymbols = (codeRes.data ?? []).map((r) => ({
            name: r.name,
            qname: r.qname ?? r.name,
            file: r.file,
            line: r.line,
        }));
        const files = Array.from(new Set(impactedCodeSymbols.map((s) => s.file)));
        const affectedTests = await this.getAffectedTests(files);
        const riskLevel = impactedContracts.length > 2 || action === 'drop'
            ? 'critical'
            : impactedContracts.length > 0
                ? 'high'
                : impactedCodeSymbols.length > 3
                    ? 'medium'
                    : 'low';
        const recommendations = [];
        if (action === 'drop') {
            recommendations.push(`DEPRECATION FIRST: Do not immediately DROP '${attributeName}'. Mark the field '@deprecated' in ${impactedContracts.length} external contract(s) and allow client migration window.`, `BACKWARD COMPATIBILITY: If clients still query this attribute, introduce a computed virtual column or backward-compatible view.`);
        }
        else if (action === 'type_change') {
            recommendations.push(`TYPE MIGRATION: Ensure deserializers in ${impactedContracts.length} contract(s) support progressive data conversion without throwing runtime unmarshal exceptions.`);
        }
        const summary = `Storage migration impact for '${scRow.name}.${attributeName}' (${action}): ${impactedContracts.length} contract(s) impacted, ${impactedCodeSymbols.length} code symbols affected, ${affectedTests.length} test suites mapped.`;
        return {
            containerName: scRow.name,
            attributeName,
            storageEngine: scRow.engine,
            action,
            impactedContracts,
            impactedCodeSymbols,
            affectedTests,
            riskLevel,
            recommendations,
            summary,
        };
    }
}
