import type { Graph } from 'falkordb';
import type { ParsedCodeFile, ParsedDocFile, CodeSymbol, CodeCall, BlastRadiusResult, CycleDetectionResult, PortingContractResult, CallPathResult, SubtypeResult, UnusedSymbolResult, GitDiffImpactResult, CrossParadigmBlueprint, ThirdPartyUsageSlice, DuplicateCloneResult, FeatureCodeFlowResult, SymbolSpecFeaturesResult, ContractEntityDef, StorageContainerDef, ContractStorageMappingResult, StorageMigrationImpactResult, StorageEngine } from '../types.js';
export declare class KnowCodeRepository {
    private graph;
    constructor(graph: Graph);
    /**
     * Run raw Cypher query with optional parameters
     */
    query(cypher: string, params?: Record<string, any>): Promise<any>;
    /**
     * Delete all existing data for a code file (for clean incremental upserts)
     */
    deleteFile(filePath: string): Promise<void>;
    /**
     * Delete all existing data for a document (for clean incremental upserts)
     */
    deleteDoc(docPath: string): Promise<void>;
    /**
     * Ingest a single parsed code file and its symbols
     */
    ingestCodeFile(parsed: ParsedCodeFile): Promise<void>;
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
    ingestImports(imports: ParsedCodeFile['imports']): Promise<void>;
    /**
     * Ingest call relationships between symbols
     */
    ingestCalls(calls: CodeCall[]): Promise<void>;
    /**
     * Ingest class/interface heritage (extends / implements)
     */
    ingestHeritage(heritage: ParsedCodeFile['heritage']): Promise<void>;
    /**
     * Ingest a documentation file (Markdown/ADR/spec)
     */
    ingestDocFile(doc: ParsedDocFile): Promise<void>;
    /**
     * Codebase architectural exploration
     */
    explore(limit?: number): Promise<{
        files: Array<{
            path: string;
            language: string;
            lineCount: number;
        }>;
        topSymbols: Array<{
            name: string;
            kind: string;
            file: string;
            inDegree: number;
        }>;
        entryPoints: Array<{
            name: string;
            file: string;
            kind: string;
        }>;
    }>;
    /**
     * Find symbol details and definition
     */
    getSymbolDefinition(name: string, file?: string): Promise<CodeSymbol | null>;
    /**
     * Fuzzy/case-insensitive search for symbols by name pattern or substring
     */
    /**
     * Search symbols by name/qname substring.
     *
     * When `metrics` is supplied (only done while tracing is enabled) one extra
     * pre-LIMIT count query runs so the caller can report `raw_candidates`.
     */
    searchSymbols(pattern: string, kind?: string, limit?: number, metrics?: {
        rawCandidates?: number;
        candidates?: number;
    }): Promise<CodeSymbol[]>;
    /**
     * Get callers of a symbol
     */
    getCallers(symbolName: string): Promise<Array<{
        callerName: string;
        callerQName: string;
        callerKind: string;
        file: string;
        line: number;
    }>>;
    /**
     * Get callees of a symbol
     */
    getCallees(symbolName: string): Promise<Array<{
        calleeName: string;
        calleeQName: string;
        calleeKind: string;
        file: string;
    }>>;
    /**
     * Transitive Blast Radius (Impact Analysis)
     */
    getBlastRadius(symbolName: string, maxDepth?: number): Promise<BlastRadiusResult>;
    /**
     * Detect Circular Import / Call Dependencies
     */
    detectCycles(): Promise<CycleDetectionResult>;
    /**
     * Find affected tests for given source files
     */
    getAffectedTests(sourceFiles: string[]): Promise<string[]>;
    /**
     * Synthesize Porting Contract for cross-language migration
     */
    getPortingContract(symbolName: string): Promise<PortingContractResult | null>;
    /**
     * Search knowledge base
     */
    searchKnowledge(query: string, limit?: number): Promise<Array<{
        type: 'document' | 'section' | 'rule';
        title: string;
        snippet: string;
        path: string;
        priority?: string;
        linkedSymbols?: string[];
    }>>;
    /**
     * Get full document or concept
     */
    getKnowledgeDoc(pathOrTitle: string): Promise<{
        title: string;
        path: string;
        category: string;
        sections: Array<{
            title: string;
            content: string;
            level: number;
        }>;
        rules: Array<{
            title: string;
            content: string;
            priority: string;
        }>;
    } | null>;
    /**
     * Graph statistics
     */
    getStats(): Promise<{
        totalFiles: number;
        totalSymbols: number;
        totalCalls: number;
        totalDocs: number;
        totalSections: number;
        totalRules: number;
        languages: Record<string, number>;
    }>;
    /**
     * Find shortest call path between two symbols
     */
    findCallPath(fromSymbol: string, toSymbol: string): Promise<CallPathResult>;
    /**
     * Find subtypes and classes implementing/extending a symbol
     */
    findSubtypesAndImplementations(symbolName: string): Promise<SubtypeResult[]>;
    /**
     * Find unused unexported symbols with 0 incoming calls in workspace
     */
    findUnusedSymbols(limit?: number): Promise<UnusedSymbolResult[]>;
    /**
     * Analyze semantic impact of current git diff
     */
    analyzeGitDiffImpact(workdir: string, baseRef?: string): Promise<GitDiffImpactResult>;
    /**
     * Generate cross-paradigm porting blueprint (OOP to Functional/Rust/Go OR Functional to OOP Java/C#)
     */
    generateCrossParadigmBlueprint(symbolName: string, targetLanguage?: 'rust' | 'go' | 'java' | 'csharp'): Promise<CrossParadigmBlueprint>;
    /**
     * Extract 3rd-party library usage slice to facilitate slim re-implementation from scratch OR recommend target ecosystem packages
     */
    extractThirdPartyUsageSlice(libraryPrefix: string, targetLanguage?: string): Promise<ThirdPartyUsageSlice>;
    /**
     * Find duplicate or structurally similar functions (Type-1 & Type-2 clone detection)
     */
    findSimilarFunctions(options?: {
        threshold?: number;
        targetSymbol?: string;
        minLines?: number;
    }): Promise<DuplicateCloneResult[]>;
    /**
     * Find all code symbols and execution call-flow implementing a feature specified in *.md
     */
    findCodeFlowForFeature(query: string, flowDepth?: number): Promise<FeatureCodeFlowResult>;
    /**
     * Find which features, specs (*.md), and rules a function or class is used in
     */
    findSpecFeaturesForSymbol(symbolName: string, searchCallers?: boolean): Promise<SymbolSpecFeaturesResult>;
    /**
     * Ingest a contract entity (XML complexType, OpenAPI schema, or Protobuf message)
     */
    ingestContractEntity(entity: ContractEntityDef): Promise<void>;
    /**
     * Ingest a storage container (SQL Table, MongoDB Collection, ES Index, Redis Key, Vector Collection)
     */
    ingestStorageContainer(container: StorageContainerDef): Promise<void>;
    /**
     * Map a contract entity to a polyglot storage container (SQL, MongoDB, Redis, ES, Vector DB)
     */
    schemaMapContractToStorage(contractName: string, storageTarget?: string, engine?: StorageEngine): Promise<ContractStorageMappingResult>;
    /**
     * Analyze blast radius of modifying/dropping a storage attribute against external contracts and code DAOs
     */
    schemaAnalyzeStorageMigrationImpact(containerName: string, attributeName: string, action?: 'drop' | 'rename' | 'type_change'): Promise<StorageMigrationImpactResult>;
}
