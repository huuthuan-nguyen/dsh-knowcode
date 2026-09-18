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
     * Link documentation sections to the code symbols they actually reference.
     *
     * Matching `sec.content CONTAINS sym.name` scanned prose for anything that looked
     * like an identifier, so a section saying "one line per phase" linked
     * `Tracer.line`, and ordinary words such as `start`, `call`, `clean`, `walk` and
     * `log` linked whatever symbols happened to share the name. Feature flows then
     * opened with entry points like `walk` and `clean`.
     *
     * `referencedSymbols` is computed by the document parser from real signals —
     * backticked identifiers, `name()` mentions and PascalCase names — and stored
     * comma-delimited, so containment tests whole names only.
     */
    linkDocsToSymbols(): Promise<number>;
}
