import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import type { ParsedCodeFile, CodeSymbol, CodeCall, FileImport, SymbolKind } from '../types.js';
import { normalizeFunctionBody } from './clone-detector.js';

export class CodeParser {
  /**
   * Determine language from file extension
   */
  public static detectLanguage(filePath: string): string | null {
    const ext = extname(filePath).toLowerCase();
    switch (ext) {
      case '.ts':
      case '.tsx':
      case '.mts':
      case '.cts':
        return 'typescript';
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
        return 'javascript';
      case '.py':
        return 'python';
      case '.go':
        return 'go';
      case '.rs':
        return 'rust';
      case '.java':
        return 'java';
      case '.c':
      case '.h':
        return 'c';
      case '.cpp':
      case '.hpp':
      case '.cc':
      case '.cxx':
        return 'cpp';
      default:
        return null;
    }
  }

  /**
   * Check if file path represents a test file
   */
  public static isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase().replace(/\\/g, '/');
    return (
      lower.includes('.test.') ||
      lower.includes('.spec.') ||
      lower.includes('_test.') ||
      lower.startsWith('test_') ||
      lower.startsWith('tests/') ||
      lower.startsWith('test/') ||
      lower.includes('/tests/') ||
      lower.includes('/__tests__/') ||
      lower.includes('/test/')
    );
  }

  /**
   * Parse code file into symbols, imports, and calls
   */
  public static parseFile(filePath: string, content?: string): ParsedCodeFile | null {
    const lang = CodeParser.detectLanguage(filePath);
    if (!lang) return null;

    const source = content ?? readFileSync(filePath, 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    const lines = source.split('\n');
    const lineCount = lines.length;
    const size = Buffer.byteLength(source, 'utf8');
    const isTest = CodeParser.isTestFile(filePath);

    const symbols: CodeSymbol[] = [];
    const calls: CodeCall[] = [];
    const imports: FileImport[] = [];
    const heritage: ParsedCodeFile['heritage'] = [];

    // Parse according to language
    if (lang === 'typescript' || lang === 'javascript') {
      CodeParser.parseJsTs(filePath, lines, symbols, calls, imports, heritage);
    } else if (lang === 'python') {
      CodeParser.parsePython(filePath, lines, symbols, calls, imports, heritage);
    } else if (lang === 'go') {
      CodeParser.parseGo(filePath, lines, symbols, calls, imports);
    } else if (lang === 'rust') {
      CodeParser.parseRust(filePath, lines, symbols, calls, imports);
    } else {
      CodeParser.parseGeneric(filePath, lines, symbols, calls);
    }

    // Compute structural AST hash for functions and methods for duplicate clone detection
    for (const sym of symbols) {
      if (sym.kind === 'function' || sym.kind === 'method') {
        const bodyLines = lines.slice(Math.max(0, sym.startLine - 1), sym.endLine);
        if (bodyLines.length > 0) {
          const { structuralHash } = normalizeFunctionBody(bodyLines.join('\n'));
          sym.structuralHash = structuralHash;
        }
      }
    }

    return {
      path: filePath,
      language: lang,
      hash,
      lineCount,
      size,
      isTest,
      symbols,
      calls,
      imports,
      heritage,
    };
  }

  /**
   * Parse TypeScript / JavaScript files
   */
  private static parseJsTs(
    file: string,
    lines: string[],
    symbols: CodeSymbol[],
    calls: CodeCall[],
    imports: FileImport[],
    heritage: ParsedCodeFile['heritage']
  ): void {
    let currentClass: string | null = null;
    let classBraceDepth = 0;
    let currentDoc: string[] = [];
    let inDoc = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // Collect docstring
      if (trimmed.startsWith('/**')) {
        currentDoc = [trimmed];
        inDoc = !trimmed.endsWith('*/');
        continue;
      } else if (inDoc) {
        currentDoc.push(trimmed);
        if (trimmed.endsWith('*/')) {
          inDoc = false;
        }
        continue;
      }

      const docstring = currentDoc.length > 0 ? currentDoc.join('\n') : undefined;

      // Imports: import { a, b } from './foo';
      const importMatch = trimmed.match(/^import\s+(?:type\s+)?(?:(\w+)|\{([^}]+)\}|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const defaultImp = importMatch[1];
        const namedImps = importMatch[2];
        const namespaceImp = importMatch[3];
        const importPath = importMatch[4];

        const specifiers: string[] = [];
        if (defaultImp) specifiers.push(defaultImp);
        if (namespaceImp) specifiers.push(namespaceImp);
        if (namedImps) {
          specifiers.push(...namedImps.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
        }

        const resolved = CodeParser.resolveRelativePath(file, importPath);
        imports.push({
          sourceFile: file,
          importedPath: importPath,
          resolvedFile: resolved,
          specifiers,
        });
      }

      // Exported or plain class: [export] class Foo [extends Bar] [implements Baz]
      const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+))?/);
      if (classMatch) {
        const name = classMatch[1];
        const extendsClass = classMatch[2];
        const implementsInterfaces = classMatch[3];
        currentClass = name;
        classBraceDepth = 0;
        const openCount = (line.match(/{/g) || []).length;
        const closeCount = (line.match(/}/g) || []).length;
        classBraceDepth += openCount - closeCount;

        const symId = `${file}:${name}:${lineNum}`;
        symbols.push({
          id: symId,
          name,
          qname: name,
          kind: 'class',
          file,
          startLine: lineNum,
          endLine: lineNum, // will be updated if end found
          signature: trimmed.split('{')[0].trim(),
          docstring,
          isExported: trimmed.startsWith('export'),
        });

        if (extendsClass) {
          heritage.push({ subSymbolId: symId, superSymbolName: extendsClass, kind: 'extends' });
        }
        if (implementsInterfaces) {
          for (const iface of implementsInterfaces.split(',')) {
            heritage.push({ subSymbolId: symId, superSymbolName: iface.trim(), kind: 'implements' });
          }
        }
        currentDoc = [];
        continue;
      }

      // Interface: [export] interface Foo [extends Bar]
      const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w\s,]+))?/);
      if (ifaceMatch) {
        const name = ifaceMatch[1];
        const extendsIface = ifaceMatch[2];
        const symId = `${file}:${name}:${lineNum}`;
        symbols.push({
          id: symId,
          name,
          qname: name,
          kind: 'interface',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed.split('{')[0].trim(),
          docstring,
          isExported: trimmed.startsWith('export'),
        });
        if (extendsIface) {
          for (const ext of extendsIface.split(',')) {
            heritage.push({ subSymbolId: symId, superSymbolName: ext.trim(), kind: 'extends' });
          }
        }
        currentDoc = [];
        continue;
      }

      // Type alias: [export] type Foo = ...
      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
      if (typeMatch) {
        const name = typeMatch[1];
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          qname: name,
          kind: 'type',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed,
          docstring,
          isExported: trimmed.startsWith('export'),
        });
        currentDoc = [];
        continue;
      }

      // Method inside class: [public|private|protected]? [async] methodName(...)
      if (currentClass) {
        const methodMatch = trimmed.match(/^(?:(public|private|protected)\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)/);
        if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('switch')) {
          const vis = (methodMatch[1] as any) ?? 'public';
          const name = methodMatch[2];
          const qname = `${currentClass}.${name}`;
          symbols.push({
            id: `${file}:${qname}:${lineNum}`,
            name,
            qname,
            kind: 'method',
            file,
            startLine: lineNum,
            endLine: lineNum,
            signature: trimmed.split('{')[0].trim(),
            docstring,
            visibility: vis,
          });
          currentDoc = [];

          const openCount = (line.match(/{/g) || []).length;
          const closeCount = (line.match(/}/g) || []).length;
          classBraceDepth += openCount - closeCount;
          continue;
        }

        // Track class brace depth
        const openCount = (line.match(/{/g) || []).length;
        const closeCount = (line.match(/}/g) || []).length;
        classBraceDepth += openCount - closeCount;
        if (classBraceDepth <= 0) {
          currentClass = null;
          classBraceDepth = 0;
        }
      }

      // Function: [export] [async] function foo(...)
      const fnMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const name = fnMatch[1];
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          qname: name,
          kind: 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed.split('{')[0].trim(),
          docstring,
          isExported: trimmed.startsWith('export'),
        });
        currentDoc = [];
        continue;
      }

      // Arrow function / const: [export] const foo = (async)? (...) =>
      const arrowMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?=>/);
      if (arrowMatch) {
        const name = arrowMatch[1];
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          qname: name,
          kind: 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed.split('=>')[0].trim() + ' =>',
          docstring,
          isExported: trimmed.startsWith('export'),
        });
        currentDoc = [];
        continue;
      }

      // Call extraction: foo.bar(...) or baz(...)
      const callMatches = line.matchAll(/(?:(\w+)\.)?(\w+)\s*\(/g);
      for (const m of callMatches) {
        const obj = m[1];
        const fn = m[2];
        // Ignore keywords
        if (['if', 'for', 'while', 'switch', 'catch', 'import', 'require', 'return'].includes(fn)) {
          continue;
        }
        // Find current enclosing symbol
        const enclosing = symbols[symbols.length - 1];
        if (enclosing) {
          calls.push({
            callerId: enclosing.id,
            calleeName: fn,
            calleeQName: obj ? `${obj}.${fn}` : fn,
            file,
            line: lineNum,
          });
        }
      }

      if (currentDoc.length > 0 && !trimmed.startsWith('*')) {
        currentDoc = [];
      }
    }
  }

  /**
   * Parse Python files
   */
  private static parsePython(
    file: string,
    lines: string[],
    symbols: CodeSymbol[],
    calls: CodeCall[],
    imports: FileImport[],
    heritage: ParsedCodeFile['heritage']
  ): void {
    let currentClass: string | null = null;
    let currentDoc: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // Imports: from foo import bar, baz OR import foo
      const fromImport = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)/);
      if (fromImport) {
        const mod = fromImport[1];
        const specifiers = fromImport[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
        imports.push({
          sourceFile: file,
          importedPath: mod,
          specifiers,
        });
      }

      // Class: class Foo(Bar, Baz):
      const classMatch = trimmed.match(/^class\s+(\w+)(?:\(([^)]+)\))?:/);
      if (classMatch) {
        const name = classMatch[1];
        const baseClasses = classMatch[2];
        currentClass = name;
        const symId = `${file}:${name}:${lineNum}`;
        symbols.push({
          id: symId,
          name,
          qname: name,
          kind: 'class',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed,
          isExported: !name.startsWith('_'),
        });
        if (baseClasses) {
          for (const b of baseClasses.split(',')) {
            heritage.push({ subSymbolId: symId, superSymbolName: b.trim(), kind: 'extends' });
          }
        }
        continue;
      }

      // Function or method: def foo(bar, baz):
      const defMatch = trimmed.match(/^def\s+(\w+)\s*\(([^)]*)\)/);
      if (defMatch) {
        const name = defMatch[1];
        const isMethod = line.startsWith('    ') || line.startsWith('\t');
        const qname = isMethod && currentClass ? `${currentClass}.${name}` : name;
        symbols.push({
          id: `${file}:${qname}:${lineNum}`,
          name,
          qname,
          kind: isMethod ? 'method' : 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed,
          visibility: name.startsWith('_') ? 'private' : 'public',
          isExported: !name.startsWith('_'),
        });
        continue;
      }

      // Calls: bar(...)
      const callMatches = line.matchAll(/(?:(\w+)\.)?(\w+)\s*\(/g);
      for (const m of callMatches) {
        const obj = m[1];
        const fn = m[2];
        if (['if', 'for', 'while', 'with', 'def', 'class', 'return', 'except'].includes(fn)) continue;
        const enclosing = symbols[symbols.length - 1];
        if (enclosing) {
          calls.push({
            callerId: enclosing.id,
            calleeName: fn,
            calleeQName: obj ? `${obj}.${fn}` : fn,
            file,
            line: lineNum,
          });
        }
      }
    }
  }

  /**
   * Parse Go files
   */
  private static parseGo(
    file: string,
    lines: string[],
    symbols: CodeSymbol[],
    calls: CodeCall[],
    imports: FileImport[]
  ): void {
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // Struct/Interface: type Foo struct/interface
      const typeMatch = trimmed.match(/^type\s+(\w+)\s+(struct|interface)/);
      if (typeMatch) {
        const name = typeMatch[1];
        const kind = typeMatch[2] === 'struct' ? 'struct' : 'interface';
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          qname: name,
          kind: kind as SymbolKind,
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed,
          isExported: name[0] === name[0].toUpperCase(),
        });
        continue;
      }

      // Function or method: func (r *Receiver) Foo(...) or func Foo(...)
      const funcMatch = trimmed.match(/^func\s+(?:\((?:[*\w\s]+)?\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        const receiver = funcMatch[1];
        const name = funcMatch[2];
        const qname = receiver ? `${receiver}.${name}` : name;
        symbols.push({
          id: `${file}:${qname}:${lineNum}`,
          name,
          qname,
          kind: receiver ? 'method' : 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed,
          isExported: name[0] === name[0].toUpperCase(),
        });
        continue;
      }

      // Calls:
      const callMatches = line.matchAll(/(?:(\w+)\.)?(\w+)\s*\(/g);
      for (const m of callMatches) {
        const obj = m[1];
        const fn = m[2];
        if (['if', 'for', 'switch', 'select', 'func', 'return'].includes(fn)) continue;
        const enclosing = symbols[symbols.length - 1];
        if (enclosing) {
          calls.push({
            callerId: enclosing.id,
            calleeName: fn,
            calleeQName: obj ? `${obj}.${fn}` : fn,
            file,
            line: lineNum,
          });
        }
      }
    }
  }

  /**
   * Parse Rust files
   */
  private static parseRust(
    file: string,
    lines: string[],
    symbols: CodeSymbol[],
    calls: CodeCall[],
    imports: FileImport[]
  ): void {
    let currentImpl: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // struct or enum: [pub] struct/enum Foo
      const structMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(struct|enum|trait)\s+(\w+)/);
      if (structMatch) {
        const kind = structMatch[1];
        const name = structMatch[2];
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          qname: name,
          kind: (kind === 'trait' ? 'trait' : 'struct') as SymbolKind,
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed.split('{')[0].trim(),
          isExported: trimmed.startsWith('pub'),
        });
        continue;
      }

      // impl Foo or impl Bar for Foo
      const implMatch = trimmed.match(/^impl(?:\s+<[^>]+>)?\s+(?:(\w+)\s+for\s+)?(\w+)/);
      if (implMatch) {
        currentImpl = implMatch[2];
        continue;
      }

      // fn: [pub] [async] fn foo(...)
      const fnMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const name = fnMatch[1];
        const qname = currentImpl ? `${currentImpl}::${name}` : name;
        symbols.push({
          id: `${file}:${qname}:${lineNum}`,
          name,
          qname,
          kind: currentImpl ? 'method' : 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed.split('{')[0].trim(),
          isExported: trimmed.startsWith('pub'),
        });
        continue;
      }

      if (trimmed === '}' && currentImpl) {
        currentImpl = null;
      }

      // Calls:
      const callMatches = line.matchAll(/(?:(\w+)(?:::|\.))?(\w+)\s*\(/g);
      for (const m of callMatches) {
        const obj = m[1];
        const fn = m[2];
        if (['if', 'while', 'match', 'for', 'return', 'fn', 'let'].includes(fn)) continue;
        const enclosing = symbols[symbols.length - 1];
        if (enclosing) {
          calls.push({
            callerId: enclosing.id,
            calleeName: fn,
            calleeQName: obj ? `${obj}::${fn}` : fn,
            file,
            line: lineNum,
          });
        }
      }
    }
  }

  /**
   * Generic fallback for C/C++/Java etc.
   */
  private static parseGeneric(
    file: string,
    lines: string[],
    symbols: CodeSymbol[],
    calls: CodeCall[]
  ): void {
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // Function/method pattern: returnType methodName(args) {
      const fnMatch = trimmed.match(/^(?:(?:public|private|protected|static|inline|virtual)\s+)*[\w<>:*&]+\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*\{?/);
      if (fnMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while')) {
        const name = fnMatch[1];
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          qname: name,
          kind: 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: trimmed.split('{')[0].trim(),
        });
      }
    }
  }

  /**
   * Resolve relative import path to project-relative file
   */
  private static resolveRelativePath(currentFile: string, importPath: string): string | undefined {
    if (!importPath.startsWith('.')) return undefined;

    const dir = dirname(currentFile);
    const resolvedBase = join(dir, importPath).replace(/\\/g, '/');

    // Candidate extensions
    const candidates = [
      resolvedBase,
      `${resolvedBase}.ts`,
      `${resolvedBase}.tsx`,
      `${resolvedBase}.js`,
      `${resolvedBase}.jsx`,
      `${resolvedBase}/index.ts`,
      `${resolvedBase}/index.js`,
    ];

    for (const c of candidates) {
      return c; // We return the best normalized guess
    }
    return undefined;
  }
}
