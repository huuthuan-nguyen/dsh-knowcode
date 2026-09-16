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
    /**
     * Resolve relative import path to project-relative file
     */
    private static resolveRelativePath;
}
