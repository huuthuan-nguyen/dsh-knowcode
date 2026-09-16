import type { KnowCodeRepository } from '../db/client.js';
export declare class LinkEngine {
    private repo;
    constructor(repo: KnowCodeRepository);
    /**
     * Run cross-linking passes in FalkorDB
     */
    linkAll(): Promise<{
        linkedTests: number;
        linkedDocs: number;
    }>;
    /**
     * Link test files to tested files based on imports and naming
     */
    linkTestsToSources(): Promise<number>;
    /**
     * Link documentation sections to code symbols mentioned in text
     */
    linkDocsToSymbols(): Promise<number>;
}
