/**
 * Shared types for KnowCode CodeGraph & Knowledge Base
 */

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'module'
  | 'struct'
  | 'trait';

export interface CodeSymbol {
  id: string; // unique hash or qname:file:line
  name: string;
  qname: string; // fully qualified name (e.g. ClassName.methodName or module.fn)
  kind: SymbolKind;
  file: string; // relative path from project root
  startLine: number;
  endLine: number;
  signature: string;
  docstring?: string;
  visibility?: 'public' | 'private' | 'protected';
  isExported?: boolean;
  structuralHash?: string; // Normalized AST token sequence hash
}

export interface CodeCall {
  callerId: string;
  calleeName: string;
  calleeQName?: string;
  file: string;
  line: number;
}

export interface FileImport {
  sourceFile: string;
  importedPath: string;
  resolvedFile?: string;
  /**
   * Every plausible project-relative path this import could resolve to
   * (extension-less base, base + each known extension, base/index + extension).
   *
   * A parser has no filesystem access and no knowledge of which files exist, so
   * it cannot pick the right one. Resolution happens at ingest time by matching
   * these candidates against the indexed `File` nodes — matching only
   * `resolvedFile` silently produced zero `:IMPORTS` edges.
   */
  resolvedCandidates?: string[];
  specifiers: string[]; // imported symbol names or '*'
}

export interface ParsedCodeFile {
  /**
   * Local variables whose initialiser references an imported binding, e.g.
   * `const cache = CacheBuilder.newBuilder().build()`. Calls on such a variable are
   * that library's API even though the receiver is not the import itself, and
   * without type information this assignment is the only signal available.
   */
  libraryAliases?: string[];
  path: string; // relative to project root
  language: string;
  hash: string; // sha256 hash of content
  lineCount: number;
  size: number;
  isTest: boolean;
  /** Last modification time in epoch milliseconds, used for fast stale checks. */
  mtimeMs?: number;
  symbols: CodeSymbol[];
  calls: CodeCall[];
  imports: FileImport[];
  heritage: Array<{
    subSymbolId: string;
    superSymbolName: string;
    kind: 'extends' | 'implements';
  }>;
}

export interface DocSection {
  id: string;
  documentPath: string;
  title: string;
  content: string;
  level: number;
  startLine: number;
  endLine: number;
  referencedSymbols?: string[];
  referencedConcepts?: string[];
}

export interface ArchitectureRule {
  id: string;
  title: string;
  content: string;
  priority: 'must' | 'should' | 'avoid';
  targetPaths?: string[]; // glob patterns
  sourceDoc: string;
}

export interface ParsedDocFile {
  path: string;
  title: string;
  category: string;
  hash: string;
  sections: DocSection[];
  rules: ArchitectureRule[];
  referencedSymbols: string[];
}

export interface KnowCodeStats {
  daemonRunning: boolean;
  daemonPid?: number;
  port?: number;
  /**
   * Absolute workspace this daemon serves. Clients compare it with their own
   * workdir so a daemon belonging to another project can never answer for them.
   */
  workdir?: string;
  dbPath: string;
  totalFiles: number;
  totalCodeFiles: number;
  totalDocFiles: number;
  totalSymbols: number;
  totalCalls: number;
  totalSections: number;
  totalRules: number;
  lastIndexedAt?: string;
  languages: Record<string, number>;
}

export interface BlastRadiusResult {
  targetSymbol: string;
  targetFile: string;
  depth: number;
  totalAffectedCallers: number;
  affectedFiles: string[];
  callChain: Array<{
    depth: number;
    callerName: string;
    callerQName: string;
    callerFile: string;
    callerLine: number;
    calleeName: string;
  }>;
  affectedTests: string[];
  riskAssessment: {
    level: 'low' | 'medium' | 'high' | 'critical';
    score: number;
    reasons: string[];
  };
}

export interface CycleDetectionResult {
  hasCycles: boolean;
  cycleCount: number;
  cycles: Array<{
    nodes: string[];
    formatted: string;
  }>;
}

export interface PortingContractResult {
  symbolName: string;
  qname: string;
  kind: string;
  file: string;
  language: string;
  signature: string;
  docstring: string;
  exported: boolean;
  dependencies: {
    importedTypes: string[];
    callees: Array<{ name: string; qname?: string; file?: string }>;
  };
  typesAndMembers: Array<{
    name: string;
    kind: string;
    signature: string;
    docstring?: string;
  }>;
  relatedTests: string[];
  governingRules: Array<{ title: string; content: string }>;
  implementationSource?: string;
}

export interface CallPathNode {
  name: string;
  qname: string;
  kind: string;
  file: string;
  line: number;
}

export interface CallPathResult {
  found: boolean;
  fromSymbol: string;
  toSymbol: string;
  hops: number;
  path: CallPathNode[];
  formatted: string;
}

export interface SubtypeResult {
  name: string;
  qname: string;
  kind: string;
  file: string;
  startLine: number;
  signature: string;
  relationship: 'EXTENDS' | 'IMPLEMENTS';
}

export interface UnusedSymbolResult {
  name: string;
  qname: string;
  kind: string;
  file: string;
  startLine: number;
  isExported: boolean;
  reason: string;
}

export interface GitFileDiff {
  file: string;
  changeType: 'added' | 'modified' | 'deleted';
  changedLines: Array<{ start: number; end: number }>;
}

export interface GitDiffImpactResult {
  filesChanged: number;
  modifiedFiles: string[];
  impactedSymbols: Array<{
    name: string;
    qname: string;
    kind: string;
    file: string;
    line: number;
    changeType: 'modified' | 'added' | 'deleted';
  }>;
  totalTransitiveCallers: number;
  affectedTests: string[];
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
}

export interface CrossParadigmBlueprint {
  symbolName: string;
  sourceKind: string;
  sourceLanguage: string;
  targetLanguage: 'rust' | 'go' | 'java' | 'csharp';
  structs: Array<{
    name: string;
    fields: Array<{ name: string; type: string; optional: boolean; docstring?: string }>;
  }>;
  traits: Array<{
    name: string;
    methods: Array<{ name: string; signature: string; isMut: boolean }>;
  }>;
  errorEnums: Array<{
    name: string;
    variants: string[];
  }>;
  ownershipGuidelines: string[];
  idiomaticSkeleton: string;
}

export interface RecommendedPackage {
  ecosystem: string; // e.g. 'crates.io' | 'pkg.go.dev' | 'maven' | 'npm' | 'pypi'
  packageName: string;
  installCommand: string;
  description: string;
  methodMappings: Array<{ sourceMethod: string; targetMethod: string }>;
}

export interface ThirdPartyUsageSlice {
  libraryPrefix: string;
  totalCallSites: number;
  importedSymbols: string[];
  invokedMethods: Array<{
    name: string;
    qname: string;
    callCount: number;
    callerFiles: string[];
    exampleLine: number;
  }>;
  suggestedPolyfillSpec: {
    summary: string;
    minimalTypes: string[];
    minimalFunctions: string[];
    estimatedLinesToImplement: number;
  };
  recommendedPackages?: RecommendedPackage[];
}

export interface DuplicateCloneResult {
  sourceSymbol: { name: string; qname: string; file: string; line: number; signature: string };
  targetSymbol: { name: string; qname: string; file: string; line: number; signature: string };
  similarityPercent: number;
  cloneType: 'Type-1 (Exact)' | 'Type-2 (Variable Renamed)' | 'Type-3 (Near-Miss)';
  differingVariables: Array<{ sourceVar: string; targetVar: string }>;
  suggestedRefactoring: string;
}

export interface FeatureCodeFlowNode {
  name: string;
  qname: string;
  kind: string;
  file: string;
  line: number;
  depth: number;
  callerName?: string;
}

export interface FeatureCodeFlowResult {
  featureName: string;
  specFile: string;
  specSection: string;
  description: string;
  entrySymbols: Array<{ name: string; qname: string; kind: string; file: string; line: number }>;
  executionFlow: FeatureCodeFlowNode[];
  totalSymbolsInvolved: number;
  filesInvolved: string[];
  mermaidDiagram: string;
}

export interface SymbolSpecFeaturesResult {
  symbolName: string;
  symbolQName: string;
  file: string;
  line: number;
  directSpecs: Array<{
    specFile: string;
    sectionTitle: string;
    relation: 'documents' | 'governs';
    contentSnippet: string;
  }>;
  indirectFeatures: Array<{
    featureName: string;
    specFile: string;
    entryPoint: string;
    callPath: string[];
  }>;
  summary: string;
}

export type ContractFormat =
  | 'xml_xsd'
  | 'xml_wsdl'
  | 'openapi_json'
  | 'openapi_yaml'
  | 'json_schema'
  | 'grpc_proto'
  | 'graphql_sdl';

export type StorageEngine =
  | 'sql'
  | 'mongodb'
  | 'redis'
  | 'elasticsearch'
  | 'timeseries'
  | 'graph'
  | 'vector';

export interface ContractFieldDef {
  name: string;
  rawType: string;
  isRequired: boolean;
  isList: boolean;
  tagNumber?: number; // for protobuf
  namespace?: string; // for XML
}

export interface ContractEntityDef {
  name: string;
  format: ContractFormat;
  file: string;
  fields: ContractFieldDef[];
  description?: string;
}

export interface StorageAttributeDef {
  name: string;
  dataType: string;
  attributeRole: string; // 'primary_key' | 'column' | 'id' | 'field' | 'keyword' | 'text' | 'vector' | 'tag' | 'metric'
  isNullable: boolean;
  defaultValue?: string;
  vectorDimension?: number;
}

export interface StorageContainerDef {
  name: string;
  engine: StorageEngine;
  file: string;
  attributes: StorageAttributeDef[];
  description?: string;
}

export interface FieldStorageMapping {
  contractField: string;
  contractType: string;
  storageAttribute: string;
  storageType: string;
  storageEngine: StorageEngine;
  role: string;
  confidence: number;
  typeStatus: 'compatible' | 'discrepancy' | 'conversion_required';
  note?: string;
}

export interface ContractStorageMappingResult {
  contractEntity: string;
  contractFormat: string;
  contractFile: string;
  storageContainer: string;
  storageEngine: StorageEngine;
  storageFile: string;
  mappings: FieldStorageMapping[];
  unmappedContractFields: string[];
  unmappedStorageAttributes: string[];
  overallCompatibility: 'high' | 'medium' | 'low';
  summary: string;
}

export interface StorageMigrationImpactResult {
  containerName: string;
  attributeName: string;
  storageEngine: StorageEngine;
  action: 'drop' | 'rename' | 'type_change';
  impactedContracts: Array<{
    entityName: string;
    format: string;
    file: string;
    fieldName: string;
  }>;
  impactedCodeSymbols: Array<{
    name: string;
    qname: string;
    file: string;
    line: number;
  }>;
  affectedTests: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  recommendations: string[];
  summary: string;
}
