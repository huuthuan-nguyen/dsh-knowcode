import type { BlastRadiusResult, CycleDetectionResult, PortingContractResult, CodeSymbol, KnowCodeStats, CallPathResult, SubtypeResult, UnusedSymbolResult, GitDiffImpactResult, CrossParadigmBlueprint, ThirdPartyUsageSlice, DuplicateCloneResult, FeatureCodeFlowResult, SymbolSpecFeaturesResult, ContractStorageMappingResult, StorageMigrationImpactResult } from './types.js';
export declare function renderExplore(data: {
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
}): string;
export declare function renderBlastRadius(data: BlastRadiusResult): string;
export declare function renderCallers(symbol: string, callers: Array<{
    callerName: string;
    callerQName: string;
    callerKind: string;
    file: string;
    line: number;
}>): string;
export declare function renderCallees(symbol: string, callees: Array<{
    calleeName: string;
    calleeQName: string;
    calleeKind: string;
    file: string;
}>): string;
export declare function renderCycles(data: CycleDetectionResult): string;
export declare function renderSymbolDefinition(sym: CodeSymbol | null, name: string): string;
export declare function renderPortingContract(data: PortingContractResult | null, symbol: string): string;
export declare function renderStatus(stats: KnowCodeStats): string;
export declare function renderCallPath(data: CallPathResult): string;
export declare function renderSubtypes(symbol: string, subtypes: SubtypeResult[]): string;
export declare function renderSymbolSearchResults(pattern: string, symbols: CodeSymbol[]): string;
export declare function renderUnusedSymbols(symbols: UnusedSymbolResult[]): string;
export declare function renderGitDiffImpact(data: GitDiffImpactResult): string;
export declare function renderCrossParadigmBlueprint(data: CrossParadigmBlueprint): string;
export declare function renderThirdPartyUsageSlice(data: ThirdPartyUsageSlice): string;
export declare function renderDuplicateClones(clones: DuplicateCloneResult[]): string;
export declare function renderFeatureCodeFlow(data: FeatureCodeFlowResult): string;
export declare function renderSymbolSpecFeatures(data: SymbolSpecFeaturesResult): string;
export declare function renderContractStorageMapping(data: ContractStorageMappingResult): string;
export declare function renderStorageMigrationImpact(data: StorageMigrationImpactResult): string;
