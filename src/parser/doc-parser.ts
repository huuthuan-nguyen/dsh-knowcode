import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import type { ParsedDocFile, DocSection, ArchitectureRule } from '../types.js';

export class DocParser {
  /**
   * Check if file is a documentation file
   */
  public static isDocFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return ['.md', '.mdx', '.markdown', '.txt', '.adoc', '.rst'].includes(ext);
  }

  /**
   * Parse a documentation file into sections and rules
   */
  public static parseDoc(filePath: string, content?: string): ParsedDocFile | null {
    if (!DocParser.isDocFile(filePath)) return null;

    const source = content ?? readFileSync(filePath, 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    const lines = source.split('\n');

    let title = basename(filePath, extname(filePath));
    let category = 'Documentation';
    const lower = filePath.toLowerCase();
    if (lower.includes('adr') || lower.includes('decision')) {
      category = 'ADR';
    } else if (lower.includes('arch') || lower.includes('design')) {
      category = 'Architecture';
    } else if (lower.includes('guide') || lower.includes('rule') || lower.includes('standard')) {
      category = 'Guidelines';
    } else if (lower.includes('api') || lower.includes('spec')) {
      category = 'API Spec';
    }

    const sections: DocSection[] = [];
    const rules: ArchitectureRule[] = [];
    const referencedSymbolsSet = new Set<string>();

    let currentSection: {
      title: string;
      level: number;
      startLine: number;
      lines: string[];
    } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // Heading match: # Title or ## Subtitle
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2].replace(/[#*`_]/g, '').trim();

        if (level === 1 && title === basename(filePath, extname(filePath))) {
          title = headingText;
        }

        // Flush previous section
        if (currentSection) {
          const contentStr = currentSection.lines.join('\n').trim();
          const secSymbols = DocParser.extractReferencedSymbols(contentStr);
          for (const s of secSymbols) referencedSymbolsSet.add(s);

          sections.push({
            id: `${filePath}:${currentSection.startLine}`,
            documentPath: filePath,
            title: currentSection.title,
            content: contentStr,
            level: currentSection.level,
            startLine: currentSection.startLine,
            endLine: lineNum - 1,
            referencedSymbols: secSymbols,
          });
        }

        currentSection = {
          title: headingText,
          level,
          startLine: lineNum,
          lines: [],
        };
        continue;
      }

      if (currentSection) {
        currentSection.lines.push(line);
      } else if (trimmed.length > 0) {
        currentSection = {
          title: title,
          level: 1,
          startLine: lineNum,
          lines: [line],
        };
      }

      // Detect rules/conventions: MUST, SHOULD, NEVER, AVOID, [Rule: ...]
      if (
        trimmed.includes('MUST') ||
        trimmed.includes('SHOULD') ||
        trimmed.includes('AVOID') ||
        trimmed.includes('NEVER') ||
        trimmed.startsWith('RULE:') ||
        trimmed.startsWith('- [ ]') ||
        trimmed.startsWith('- **Rule')
      ) {
        let priority: 'must' | 'should' | 'avoid' = 'should';
        if (trimmed.includes('MUST') || trimmed.includes('NEVER')) priority = 'must';
        else if (trimmed.includes('AVOID') || trimmed.includes('SHOULD NOT')) priority = 'avoid';

        rules.push({
          id: `${filePath}:rule:${lineNum}`,
          title: currentSection?.title ?? title,
          content: trimmed,
          priority,
          sourceDoc: filePath,
        });
      }
    }

    // Flush last section
    if (currentSection) {
      const contentStr = currentSection.lines.join('\n').trim();
      const secSymbols = DocParser.extractReferencedSymbols(contentStr);
      for (const s of secSymbols) referencedSymbolsSet.add(s);

      sections.push({
        id: `${filePath}:${currentSection.startLine}`,
        documentPath: filePath,
        title: currentSection.title,
        content: contentStr,
        level: currentSection.level,
        startLine: currentSection.startLine,
        endLine: lines.length,
        referencedSymbols: secSymbols,
      });
    }

    return {
      path: filePath,
      title,
      category,
      hash,
      sections,
      rules,
      referencedSymbols: Array.from(referencedSymbolsSet),
    };
  }

  /**
   * Extract code symbols mentioned in markdown backticks or PascalCase/camelCase identifiers
   */
  public static extractReferencedSymbols(text: string): string[] {
    const symbols = new Set<string>();

    // 1. Markdown backticks: `UserService` or `getAuthToken()`
    const backtickMatches = text.matchAll(/`([A-Za-z0-9_$.]+)(?:\(\))?`/g);
    for (const m of backtickMatches) {
      const sym = m[1];
      if (sym.length > 2 && !['true', 'false', 'null', 'undefined', 'string', 'number', 'boolean'].includes(sym)) {
        symbols.add(sym);
      }
    }

    // 2. PascalCase code identifiers (e.g. AuthController, OrderProcessor, JwtValidator)
    const pascalMatches = text.matchAll(/\b([A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*)\b/g);
    for (const m of pascalMatches) {
      const sym = m[1];
      if (!['TypeScript', 'JavaScript', 'Python', 'Markdown', 'FalkorDB'].includes(sym)) {
        symbols.add(sym);
      }
    }

    // 3. camelCase method identifiers followed by (): e.g. processPayment() or verifyToken()
    const methodMatches = text.matchAll(/\b([a-z][a-zA-Z0-9]+)\(\)/g);
    for (const m of methodMatches) {
      const sym = m[1];
      if (sym.length > 3) {
        symbols.add(sym);
      }
    }

    return Array.from(symbols);
  }
}
