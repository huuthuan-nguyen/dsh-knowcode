import Parser from 'web-tree-sitter';
/**
 * Built-in core languages pre-loaded at startup for instantaneous response.
 */
export declare const CORE_LANGUAGES: readonly ["typescript", "tsx", "javascript", "python", "go", "rust", "c", "cpp", "java", "c_sharp", "ruby", "php", "solidity", "lua", "zig", "bash"];
export type CoreLanguage = (typeof CORE_LANGUAGES)[number];
export declare class TreeSitterEngine {
    private static initialized;
    private static initPromise;
    private static languages;
    private static parsers;
    private static customExtensions;
    private static loadPromises;
    /**
     * Normalize language names (e.g. csharp -> c_sharp, shell -> bash)
     */
    static normalizeLanguageName(name: string): string;
    /**
     * Search for a WASM file for the specified language across:
     * 1. Environment variable KNOWCODE_GRAMMARS_DIR
     * 2. Local workspace .knowcode/grammars/
     * 3. User home ~/.knowcode/grammars/
     * 4. Bundled tree-sitter-wasms/out/
     */
    static resolveWasmPath(lang: string): string | null;
    /**
     * Initialize Tree-sitter WebAssembly core and preload core languages.
     * Safe to call multiple times.
     */
    static init(): Promise<void>;
    /**
     * Scan custom directories and register custom grammars
     */
    private static scanCustomGrammarDirs;
    /**
     * Ensure a specific language grammar is loaded and ready for synchronous parsing.
     * Dynamically loads any language supported by Tree-sitter on demand.
     */
    static ensureLanguage(lang: string): Promise<boolean>;
    /**
     * Ensure multiple languages are loaded in batch.
     */
    static ensureLanguages(langs: Iterable<string>): Promise<void>;
    /**
     * Register a custom Tree-sitter grammar WASM dynamically (from path or memory buffer).
     * Allows plugins or users to bring ANY Tree-sitter language grammar.
     */
    static registerGrammar(lang: string, wasmPathOrBuffer: string | Uint8Array, extensions?: string[]): Promise<boolean>;
    /**
     * Associate a file extension with a language name.
     */
    static registerExtension(extension: string, language: string): void;
    static getCustomExtension(extension: string): string | undefined;
    static isReady(): boolean;
    static isLanguageLoaded(lang: string): boolean;
    static getLanguage(lang: string): Parser.Language | undefined;
    static getParser(lang: string): Parser | undefined;
    static getLoadedLanguages(): string[];
    /**
     * Synchronously parse source code using the loaded Tree-sitter grammar.
     * If the language is not yet loaded, returns null.
     */
    static parse(language: string, source: string, filePath?: string): Parser.Tree | null;
}
