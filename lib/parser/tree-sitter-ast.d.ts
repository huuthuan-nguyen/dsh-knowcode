import type Parser from 'web-tree-sitter';
import type { CodeSymbol, CodeCall, FileImport, ParsedCodeFile } from '../types.js';
/**
 * Trim a gathered declaration to just its signature.
 * Cuts at the last `{` of the header.
 */
export declare function signatureFrom(text: string): string;
/**
 * Gather declaration header lines from start line up to the line opening the body.
 */
export declare function gatherHeader(lines: string[], startIdx: number, maxLookahead?: number): {
    text: string;
    endIdx: number;
};
export interface TreeSitterParseResult {
    symbols: CodeSymbol[];
    calls: CodeCall[];
    imports: FileImport[];
    heritage: ParsedCodeFile['heritage'];
}
export declare function parseWithTreeSitterAst(filePath: string, language: string, source: string, lines: string[], tree: Parser.Tree, resolveCandidates: (file: string, path: string) => string[]): TreeSitterParseResult;
