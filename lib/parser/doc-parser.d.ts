import type { ParsedDocFile } from '../types.js';
export declare class DocParser {
    /**
     * Check if file is a documentation file
     */
    static isDocFile(filePath: string): boolean;
    /**
     * Parse a documentation file into sections and rules
     */
    static parseDoc(filePath: string, content?: string): ParsedDocFile | null;
    /**
     * Extract code symbols mentioned in markdown backticks or PascalCase/camelCase identifiers
     */
    static extractReferencedSymbols(text: string): string[];
}
