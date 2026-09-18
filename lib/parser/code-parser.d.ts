import type { ParsedCodeFile } from '../types.js';
export declare class CodeParser {
    /**
     * Determine language from file extension
     */
    static detectLanguage(filePath: string): string | null;
    /**
     * Check if file path represents a test file
     */
    static isTestFile(filePath: string): boolean;
    /**
     * Parse code file into symbols, imports, and calls
     */
    static parseFile(filePath: string, content?: string): ParsedCodeFile | null;
    /**
     * Blank out string and template-literal contents on one line.
     *
     * Call extraction used to run over raw source, so text inside query strings was
     * treated as code: a Cypher query containing `MATCH (s:Symbol)` produced a
     * "call" to `MATCH`, and this repository accumulated 600+ such phantom call
     * edges — enough to dominate `explore`'s hub-symbol ranking and pollute caller,
     * callee and blast-radius results with keywords.
     *
     * Interpolations inside a template literal are dropped along with the literal.
     * That under-reports calls written inside `${...}`, which is a far smaller cost
     * than inventing hundreds of edges to `MATCH`.
     *
     * @param line - the raw source line.
     * @param inTemplate - whether a multi-line template literal is already open.
     * @returns the code-only text, and the template-literal state after this line.
     */
    private static stripStringLiterals;
    /**
     * Whether a gathered declaration is genuinely `… = (params) => …`.
     *
     * The arrow pattern previously accepted any `const NAME = (` whose balanced
     * text merely *contained* `=>`, so
     * `const files = (res.data ?? []).map((row) => ({…}))` was indexed as a
     * function named `files`. The arrow must follow the parameter list itself.
     */
    private static isArrowDeclaration;
    /**
     * Trim a gathered declaration to just its signature.
     *
     * Cuts at the **last** `{` of the header, not the first: a default value
     * (`options: DispatchOptions = {}`) or an object return type
     * (`Promise<{ ok: boolean }>`) contains braces that are part of the signature,
     * and splitting on the first one truncated the signature mid-parameter.
     */
    private static signatureFrom;
    /**
     * Join a declaration's lines up to and including the line that closes its
     * parameter list.
     *
     * Declaration regexes used to require the whole `(...)` on one line, so any
     * function whose parameters wrapped — which is most real-world code, including
     * this plugin's own `executeKnowCodeTool` — was never indexed at all: it had no
     * symbol, so definition lookup, caller/callee tracing, blast radius and clone
     * detection all silently missed it.
     *
     * @param lines - all source lines.
     * @param startIdx - 0-based index of the declaration's first line.
     * @param maxLookahead - safety bound on how many lines to consume.
     * @returns the joined declaration text (single-spaced, trimmed).
     */
    private static gatherParens;
    /**
     * Join a declaration's lines up to the line that opens its body, for
     * declarations whose header (extends/implements clauses) may wrap.
     *
     * @returns the joined header, and the index of its last line so callers can
     *   avoid counting that line's braces twice.
     */
    private static gatherToBrace;
    /**
     * Parse TypeScript / JavaScript files
     */
    private static parseJsTs;
    /**
     * Parse Python files
     */
    private static parsePython;
    /**
     * Parse Go files
     */
    private static parseGo;
    /**
     * Parse Rust files
     */
    private static parseRust;
    /**
     * Generic fallback for C/C++/Java etc.
     */
    private static parseGeneric;
    /** Directory names that hold compiled output rather than authored source. */
    private static readonly BUILD_DIRS;
    /** Directory names that hold authored source. */
    private static readonly SOURCE_DIRS;
    /** Recognised module extensions, longest first so `.tsx` beats `.ts`. */
    private static readonly MODULE_EXTENSIONS;
    /**
     * Build every project-relative path a relative import could resolve to.
     *
     * The parser has no filesystem access, so it cannot pick the correct one, and
     * matching a single extension-less guess against the indexed `File` nodes
     * silently produced zero `:IMPORTS` edges. Callers match this whole list
     * against real file nodes, so extra candidates are harmless: a candidate that
     * matches nothing simply creates no edge.
     *
     * Candidates also cross the build-output boundary. TypeScript projects compile
     * `src/` to `lib/`, and their tests import the compiled output
     * (`import { x } from '../lib/x.js'`), while only `src/` is indexed. Without
     * the mapping those imports resolved to nothing, so no `TESTS_FOR` edge was
     * created and affected-test discovery silently under-reported.
     */
    private static resolveRelativeCandidates;
    /**
     * Accurately calculate the endLine for each symbol (functions, methods, classes)
     * so that structural hashing, git diff range mapping, and definition lookups
     * cover the full body of the code block rather than just the signature line.
     */
    private static computeEndLines;
}
