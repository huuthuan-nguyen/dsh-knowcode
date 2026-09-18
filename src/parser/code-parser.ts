import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import type { ParsedCodeFile, CodeSymbol, CodeCall, FileImport, SymbolKind } from '../types.js';
import { normalizeFunctionBody } from './clone-detector.js';

/** `foo.bar(` / `baz(` / `Type::method(` — one regex reused by every parser. */
const CALL_PATTERN = /(?:(\w+)\.)?(\w+)\s*\(/g;

/** `foo.bar(` / `baz(` / `Type::method(` for Rust paths. */
const CALL_PATTERN_RUST = /(?:(\w+)(?:::|\.))?(\w+)\s*\(/g;

/**
 * Control-flow and declaration keywords that look like `name(` at the start of a
 * line but are never declarations or calls.
 *
 * The in-class method pattern accepts any `identifier(`, so without this a
 * `while (…)` inside a method was indexed as a method named `while`. Matched by
 * exact name — a `startsWith` test would also discard a genuine method called
 * `iffy` or `format`.
 */
const NON_DECLARATION_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'catch',
  'finally',
  'try',
  'return',
  'throw',
  'await',
  'yield',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'super',
  'this',
  'break',
  'continue',
  'function',
  'class',
  'interface',
  'type',
  'const',
  'let',
  'var',
  'import',
  'export',
  'of',
  'in',
]);

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

    // Accurately compute endLine for all symbols (functions, methods, classes)
    CodeParser.computeEndLines(lines, symbols, lang);

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
      libraryAliases: CodeParser.findLibraryAliases(lines, imports),
    };
  }

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
  private static stripStringLiterals(
    line: string,
    inTemplate: boolean,
    inBlockComment = false
  ): { code: string; inTemplate: boolean; inBlockComment: boolean } {
    let code = '';
    let i = 0;
    let mode: 'none' | 'single' | 'double' | 'template' | 'block' = inBlockComment
      ? 'block'
      : inTemplate
      ? 'template'
      : 'none';

    while (i < line.length) {
      const ch = line[i];

      if (mode === 'none') {
        // Comments are not code either: a `//` note reading "Comma-delimited (and
        // wrapped)…" was extracted as a call to `delimited`, and similar prose gave
        // every dependency list a sprinkling of words like `convention` and `points`.
        if (ch === '/' && line[i + 1] === '/') break;
        if (ch === '/' && line[i + 1] === '*') {
          mode = 'block';
          i += 2;
          continue;
        }

        // A regex literal is not code either, and its braces are usually unbalanced
        // on purpose: `/[^{\n]*\{([\s\S]*?)\}/` opens two and closes one, which
        // pushed the class-body depth to 2 for the rest of the file and hid every
        // later method — `StorageParser.parseSqlDdl` had no symbol at all.
        //
        // A `/` starts a regex unless it follows something that can end an
        // expression, in which case it is division.
        if (ch === '/') {
          const previous = code.replace(/\s+$/, '').slice(-1);
          const startsRegex = previous === '' || '=(,:[!&|?{};+-*%<>~^'.includes(previous);
          if (startsRegex) {
            i++;
            let inClass = false;
            while (i < line.length) {
              const c = line[i];
              if (c === '\\') {
                i += 2;
                continue;
              }
              if (c === '[') inClass = true;
              else if (c === ']') inClass = false;
              else if (c === '/' && !inClass) {
                i++;
                break;
              }
              i++;
            }
            continue;
          }
        }
        if (ch === '"') mode = 'double';
        else if (ch === "'") mode = 'single';
        else if (ch === '`') mode = 'template';
        else code += ch;
        i++;
        continue;
      }

      if (mode === 'block') {
        if (ch === '*' && line[i + 1] === '/') {
          mode = 'none';
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // Inside a literal: consume it, but keep character offsets aligned.
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (
        (mode === 'double' && ch === '"') ||
        (mode === 'single' && ch === "'") ||
        (mode === 'template' && ch === '`')
      ) {
        mode = 'none';
      }
      i++;
    }

    return {
      code,
      inTemplate: mode === 'template',
      inBlockComment: mode === 'block',
    };
  }

  /**
   * The part of a declaration line that follows its header.
   *
   * A single-line declaration — `export function f() { return g(); }` — used to have
   * its calls skipped entirely, because the declaration branch consumed the line. The
   * header is stripped so the declaration's own name is not then read as a call to
   * itself.
   */
  private static codeAfterHeader(code: string): string {
    const brace = code.indexOf('{');
    if (brace >= 0) return code.slice(brace);
    const arrow = code.indexOf('=>');
    if (arrow >= 0) return code.slice(arrow + 2);
    return '';
  }

  /**
   * Record every call-looking invocation in `text`.
   *
   * Shared by the whole-line pass and by declarations, which must also scan their own
   * line: a call written on the same line as the enclosing declaration is still a call.
   */
  private static collectCalls(
    text: string,
    callerId: string,
    file: string,
    lineNum: number,
    calls: CodeCall[]
  ): void {
    if (text.length === 0) return;

    for (const m of text.matchAll(CALL_PATTERN)) {
      const obj = m[1];
      const fn = m[2];
      if (NON_DECLARATION_KEYWORDS.has(fn)) continue;
      if (fn === 'require' || fn === 'import') continue;
      calls.push({
        callerId,
        calleeName: fn,
        calleeQName: obj ? `${obj}.${fn}` : fn,
        file,
        line: lineNum,
      });
    }
  }

  /**
   * Whether a gathered declaration is genuinely `… = (params) => …`.
   *
   * The arrow pattern previously accepted any `const NAME = (` whose balanced
   * text merely *contained* `=>`, so
   * `const files = (res.data ?? []).map((row) => ({…}))` was indexed as a
   * function named `files`. The arrow must follow the parameter list itself.
   */
  private static isArrowDeclaration(text: string): boolean {
    const eq = text.indexOf('=');
    if (eq < 0) return false;

    let i = eq + 1;
    const skipSpace = () => {
      while (i < text.length && /\s/.test(text[i])) i++;
    };

    skipSpace();
    if (text.startsWith('async', i)) i += 'async'.length;
    skipSpace();
    if (text[i] !== '(') return false;

    // Walk to the paren that closes the parameter list.
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    if (depth !== 0) return false;

    skipSpace();
    if (text.startsWith('=>', i)) return true;

    // An optional return type may sit between `)` and `=>`.
    if (text[i] === ':') {
      const arrow = text.indexOf('=>', i);
      if (arrow < 0) return false;
      // Reject when another paren group opens first — that means this is a call.
      const paren = text.indexOf('(', i);
      return paren < 0 || arrow < paren;
    }

    return false;
  }

  /**
   * Trim a gathered declaration to just its signature.
   *
   * Cuts at the **last** `{` of the header, not the first: a default value
   * (`options: DispatchOptions = {}`) or an object return type
   * (`Promise<{ ok: boolean }>`) contains braces that are part of the signature,
   * and splitting on the first one truncated the signature mid-parameter.
   */
  private static signatureFrom(text: string): string {
    const brace = text.lastIndexOf('{');
    return (brace >= 0 ? text.slice(0, brace) : text).trim();
  }
  /**
   * Names of locals assigned from an expression that mentions an imported binding.
   *
   * `const cache = CacheBuilder.newBuilder().build()` followed by `cache.put(...)` is
   * plainly library usage, but the receiver is `cache`, not the import. Without type
   * inference this assignment is the only available signal, and without it a slice
   * reported only the handful of calls made directly on the binding.
   */
  private static findLibraryAliases(lines: string[], imports: FileImport[]): string[] {
    const assignment = /(?:^|[^=!<>])\b([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;]*)/;
    const entries: string[] = [];
    const seen = new Set<string>();

    // Per import: an alias must be attributed to the module it came from, or a slice
    // for one library would accept locals derived from any other import in the file.
    for (const imp of imports) {
      const bindings = imp.specifiers.filter((spec) => spec && spec !== '*');
      if (bindings.length === 0) continue;

      const patterns = bindings.map((b) => new RegExp(`\\b${b}\\b`));

      for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

        const match = line.match(assignment);
        if (!match) continue;

        const target = match[1];
        const rhs = match[2];
        if (bindings.includes(target)) continue;
        if (!patterns.some((re) => re.test(rhs))) continue;

        // `alias|module` — the module keeps the alias attributable to one library.
        const key = `${target}|${imp.importedPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(key);
      }
    }

    return entries;
  }

  /**
   * Gather a declaration header: the parameter list plus any wrapped return type,
   * ending at the brace that opens the body.
   *
   * `gatherParens` stops at the parameter list's closing paren, so a return type
   * that wraps onto following lines was lost entirely — every such signature was
   * stored as `…): Promise<` with the type erased. The body brace is the first `{`
   * seen at paren depth 0 **and** angle depth 0, which is what separates it from a
   * `Promise<{ … }>` return type.
   *
   * @returns the joined header, and the index of its last line.
   */
  private static gatherHeader(
    lines: string[],
    startIdx: number,
    maxLookahead = 40
  ): { text: string; endIdx: number } {
    const parts: string[] = [];
    let paren = 0;
    let angle = 0;
    let endIdx = startIdx;

    for (let i = startIdx; i < lines.length && i - startIdx <= maxLookahead; i++) {
      const raw = lines[i] ?? '';
      const code = raw.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');

      let bodyBrace = false;
      for (const ch of code) {
        if (ch === '(') paren++;
        else if (ch === ')') paren = Math.max(0, paren - 1);
        else if (ch === '<') angle++;
        else if (ch === '>') angle = Math.max(0, angle - 1);
        else if (ch === '{' && paren === 0 && angle === 0) bodyBrace = true;
      }

      parts.push(raw.trim());
      endIdx = i;

      // An arrow body, or the brace that opens the body.
      if (bodyBrace) break;
      if (paren === 0 && angle === 0 && /=>\s*$/.test(code)) break;
    }

    return { text: parts.join(' '), endIdx };
  }

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
  private static gatherParens(
    lines: string[],
    startIdx: number,
    maxLookahead = 40
  ): { text: string; endIdx: number } {
    const parts: string[] = [];
    let depth = 0;
    let sawOpen = false;
    let endIdx = startIdx;

    for (let i = startIdx; i < lines.length && i - startIdx <= maxLookahead; i++) {
      const raw = lines[i] ?? '';
      // Ignore comments when balancing brackets.
      const code = raw.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const ch of code) {
        if (ch === '(') {
          depth++;
          sawOpen = true;
        } else if (ch === ')') {
          depth--;
        }
      }
      parts.push(raw.trim());
      endIdx = i;

      // Stop as soon as the parameter list balances. When the line has no `(` at
      // all (a brace-only declaration such as `class Foo {`), the header is that
      // single line — continuing would swallow the first line of the body.
      if (!sawOpen) break;
      if (depth <= 0) break;
    }

    return { text: parts.join(' '), endIdx };
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
    /** Last line of the current class header; its braces are already counted. */
    let classHeaderEndIdx = -1;
    let currentDoc: string[] = [];
    let inDoc = false;
    /** Tracks an open multi-line template literal across iterations. */
    let inTemplate = false;
    /** Tracks an open block comment across iterations. */
    let inBlockComment = false;
    /** Interface whose body is being read; its members are indexed as signatures. */
    let currentInterface: string | null = null;
    let interfaceBraceDepth = 0;
    let interfaceHeaderEndIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      const wasInTemplate = inTemplate;
      const stripped = CodeParser.stripStringLiterals(line, inTemplate, inBlockComment);
      inTemplate = stripped.inTemplate;
      inBlockComment = stripped.inBlockComment;
      const codeOnly = stripped.code.trim();

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
      // The module path is itself a string literal, so the raw line is required —
      // but a line inside a template literal is fixture text, not an import.
      const importMatch = wasInTemplate
        ? null
        : trimmed.match(/^import\s+(?:type\s+)?(?:(\w+)|\{([^}]+)\}|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/);
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

        const candidates = CodeParser.resolveRelativeCandidates(file, importPath);
        imports.push({
          sourceFile: file,
          importedPath: importPath,
          resolvedFile: candidates[0],
          resolvedCandidates: candidates,
          specifiers,
        });
      }

      // Exported or plain class: [export] class Foo [extends Bar] [implements Baz]
      //
      // Gated on the string-stripped line so a class declaration embedded in a
      // template literal (a test fixture holding sample code, or any generated
      // source string) is not indexed as if it were real. Heritage may wrap onto
      // following lines, so the details come from the joined header.
      const classHeaderInfo = CodeParser.gatherHeader(lines, i);
      const classHeader = classHeaderInfo.text;
      const classGate = codeOnly.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/);
      const classMatch = classGate
        ? classHeader.match(
            /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+))?/
          )
        : null;
      if (classMatch) {
        const name = classMatch[1];
        const extendsClass = classMatch[2];
        const implementsInterfaces = classMatch[3];
        currentClass = name;
        classBraceDepth = 0;
        // Count braces from the whole gathered header: when `extends`/`implements`
        // wrap, the opening `{` sits on a later line and counting only `line`
        // would leave the depth at 0, immediately closing the class scope and
        // hiding every method inside it.
        const openCount = (classHeader.match(/{/g) || []).length;
        const closeCount = (classHeader.match(/}/g) || []).length;
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
          signature: CodeParser.signatureFrom(classHeader),
          docstring,
          isExported: trimmed.startsWith('export'),
        });

        // The opening brace may sit on a continuation line that the header already
        // counted; remember where the header ended so the loop does not add it a
        // second time (which would push the class body to depth 2 and hide every
        // method declared in it).
        classHeaderEndIdx = classHeaderInfo.endIdx;

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

      // Interface: [export] interface Foo [extends Bar] — gated on stripped code.
      const ifaceHeaderInfo = CodeParser.gatherHeader(lines, i);
      const ifaceHeader = ifaceHeaderInfo.text;
      const ifaceMatch = codeOnly.match(/^(?:export\s+)?interface\s+(\w+)/)
        ? ifaceHeader.match(/^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w\s,]+))?/)
        : null;
      if (ifaceMatch) {
        const name = ifaceMatch[1];
        const extendsIface = ifaceMatch[2];
        currentInterface = name;
        interfaceBraceDepth = (ifaceHeader.match(/{/g) || []).length - (ifaceHeader.match(/}/g) || []).length;
        interfaceHeaderEndIdx = ifaceHeaderInfo.endIdx;

        const symId = `${file}:${name}:${lineNum}`;
        symbols.push({
          id: symId,
          name,
          qname: name,
          kind: 'interface',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: CodeParser.signatureFrom(ifaceHeader),
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
      const typeMatch = codeOnly.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
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

      // Interface members. Indexed as symbols so an implementing method can be
      // matched against the contract it satisfies, and so a generated trait knows
      // which methods it declares. They are signatures, never calls.
      if (currentInterface && i > interfaceHeaderEndIdx) {
        const member = codeOnly.match(/^(?:readonly\s+)?(\w+)\s*[?]?\s*[:(]/);
        if (member && !NON_DECLARATION_KEYWORDS.has(member[1])) {
          const memberName = member[1];
          symbols.push({
            id: `${file}:${currentInterface}.${memberName}:${lineNum}`,
            name: memberName,
            qname: `${currentInterface}.${memberName}`,
            kind: 'method',
            file,
            startLine: lineNum,
            endLine: lineNum,
            signature: codeOnly.replace(/[;{].*$/, '').trim(),
            isExported: true,
          });
        }

        const open = (codeOnly.match(/{/g) || []).length;
        const close = (codeOnly.match(/}/g) || []).length;
        interfaceBraceDepth += open - close;
        if (interfaceBraceDepth <= 0) {
          currentInterface = null;
          interfaceBraceDepth = 0;
          interfaceHeaderEndIdx = -1;
        }
        continue;
      }

      // Method inside class: [public|private|protected]? [async] methodName(...)
      //
      // Matched against the string-stripped line: this pattern accepts any
      // `identifier(` at the start of a line, so a multi-line Cypher/SQL query
      // inside a method turned every `MATCH (sym:Symbol)` fragment into a bogus
      // method of the enclosing class (40 such symbols in this repository alone).
      if (currentClass) {
        // A member is only a declaration directly in the class body. At a deeper
        // brace level the line is a statement inside a method, and any
        // `identifier(` there is a call — this is what turned `rej(new Error(…))`
        // into a method named `rej`.
        // Any combination of member modifiers may precede the name. Requiring the
        // name directly after `public`/`private`/`protected` meant every `static`
        // method was invisible — and utility classes here are almost entirely static,
        // so `CodeParser.detectLanguage` and `StorageParser.parseSqlDdl` had no symbol
        // at all.
        const methodMatch =
          classBraceDepth === 1
            ? codeOnly.match(
                /^((?:(?:public|private|protected|static|abstract|override|readonly|declare|async|get|set)\s+)*)(\w+)\s*\(/
              )
            : null;

        if (methodMatch && !NON_DECLARATION_KEYWORDS.has(methodMatch[2])) {
          const modifiers = methodMatch[1] ?? '';
          const vis = /private/.test(modifiers)
            ? 'private'
            : /protected/.test(modifiers)
            ? 'protected'
            : 'public';
          const name = methodMatch[2];
          const qname = `${currentClass}.${name}`;
          const { text: signatureText } = CodeParser.gatherHeader(lines, i);
          symbols.push({
            id: `${file}:${qname}:${lineNum}`,
            name,
            qname,
            kind: 'method',
            file,
            startLine: lineNum,
            endLine: lineNum,
            signature: CodeParser.signatureFrom(signatureText),
            docstring,
            visibility: vis,
          });
          currentDoc = [];
          CodeParser.collectCalls(
            CodeParser.codeAfterHeader(codeOnly),
            `${file}:${qname}:${lineNum}`,
            file,
            lineNum,
            calls
          );
        }

        // Depth must be tracked on every line, not only at the class body level,
        // or the count never comes back down and later members are invisible.
        // Braces come from the stripped text so braces inside a query string are
        // not mistaken for the class or method body. Header continuation lines are
        // skipped: the header's own braces were counted when it was detected.
        if (i > classHeaderEndIdx) {
          const openCount = (codeOnly.match(/{/g) || []).length;
          const closeCount = (codeOnly.match(/}/g) || []).length;
          classBraceDepth += openCount - closeCount;
          if (classBraceDepth <= 0) {
            currentClass = null;
            classBraceDepth = 0;
            classHeaderEndIdx = -1;
          }
        }

        // The line already contributed its calls above; scanning it again in the
        // whole-line pass would record the declaration's own name as a self-call.
        if (methodMatch) continue;
      }

      // Function: [export] [async] function foo(...)  — parameters may wrap
      const fnMatch = codeOnly.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
      if (fnMatch) {
        const name = fnMatch[1];
        const { text: signatureText } = CodeParser.gatherHeader(lines, i);
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          qname: name,
          kind: 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: CodeParser.signatureFrom(signatureText),
          docstring,
          isExported: trimmed.startsWith('export'),
        });
        CodeParser.collectCalls(
          CodeParser.codeAfterHeader(codeOnly),
          `${file}:${name}:${lineNum}`,
          file,
          lineNum,
          calls
        );
        currentDoc = [];
        continue;
      }

      // Arrow function / const: [export] const foo = (async)? (...) =>  — parameters may wrap
      const arrowMatch = codeOnly.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
      if (arrowMatch) {
        const name = arrowMatch[1];
        const { text: signatureText } = CodeParser.gatherHeader(lines, i);
        if (CodeParser.isArrowDeclaration(signatureText)) {
          symbols.push({
            id: `${file}:${name}:${lineNum}`,
            name,
            qname: name,
            kind: 'function',
            file,
            startLine: lineNum,
            endLine: lineNum,
            signature: signatureText.split('=>')[0].trim() + ' =>',
            docstring,
            isExported: trimmed.startsWith('export'),
          });
          CodeParser.collectCalls(
            CodeParser.codeAfterHeader(codeOnly),
            `${file}:${name}:${lineNum}`,
            file,
            lineNum,
            calls
          );
          currentDoc = [];
          continue;
        }
      }

      // Call extraction: foo.bar(...) or baz(...). Runs on the string-stripped line so
      // query text, comments and fixture source cannot masquerade as calls.
      //
      // Skipped inside an interface: `area(): number;` declares a member, and reading
      // it as a call produced a phantom `Shape -> area` edge that then showed up as a
      // hub symbol and in call paths.
      const enclosing = symbols[symbols.length - 1];
      if (enclosing && enclosing.kind !== 'interface') {
        CodeParser.collectCalls(codeOnly, enclosing.id, file, lineNum, calls);
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
    /** Tracks an open multi-line string literal across iterations. */
    let inTemplate = false;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      const wasInTemplate = inTemplate;
      const stripped = CodeParser.stripStringLiterals(line, inTemplate, inBlockComment);
      inTemplate = stripped.inTemplate;
      inBlockComment = stripped.inBlockComment;
      const codeOnly = stripped.code.trim();

      // Reset currentClass if an unindented, non-comment, non-empty statement appears
      if (currentClass && trimmed.length > 0 && !trimmed.startsWith('#')) {
        const isIndented = line.startsWith(' ') || line.startsWith('\t');
        if (!isIndented && !trimmed.startsWith('class ')) {
          currentClass = null;
        }
      }

      // Imports: from foo import bar, baz OR import foo
      const fromImport = wasInTemplate ? null : trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)/);
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

      // Function or method: def foo(bar, baz):  — parameters may wrap
      const defMatch = trimmed.match(/^def\s+(\w+)\s*\(/);
      if (defMatch) {
        const name = defMatch[1];
        const isMethod = line.startsWith('    ') || line.startsWith('\t');
        const qname = isMethod && currentClass ? `${currentClass}.${name}` : name;
        const { text: signatureText } = CodeParser.gatherParens(lines, i);
        symbols.push({
          id: `${file}:${qname}:${lineNum}`,
          name,
          qname,
          kind: isMethod ? 'method' : 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: signatureText,
          visibility: name.startsWith('_') ? 'private' : 'public',
          isExported: !name.startsWith('_'),
        });
        continue;
      }

      // Calls: bar(...). String-stripped so query text cannot fake a call.
      const callMatches = codeOnly.matchAll(CALL_PATTERN);
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
    let inTemplate = false;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      const wasInTemplate = inTemplate;
      const stripped = CodeParser.stripStringLiterals(line, inTemplate, inBlockComment);
      inTemplate = stripped.inTemplate;
      inBlockComment = stripped.inBlockComment;
      const codeOnly = stripped.code.trim();

      // Struct/Interface: type Foo struct/interface
      const typeMatch = codeOnly.match(/^type\s+(\w+)\s+(struct|interface)/);
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
          signature: CodeParser.signatureFrom(trimmed),
          isExported: name[0] === name[0].toUpperCase(),
        });
        continue;
      }

      // Function or method: func (r *Receiver) Foo(...) or func Foo(...)  — parameters may wrap
      const funcMatch = trimmed.match(/^func\s+(?:\((?:[*\w\s]+)?\*?(\w+)\)\s+)?(\w+)\s*\(/);
      if (funcMatch) {
        const receiver = funcMatch[1];
        const name = funcMatch[2];
        const qname = receiver ? `${receiver}.${name}` : name;
        const { text: signatureText } = CodeParser.gatherHeader(lines, i);
        symbols.push({
          id: `${file}:${qname}:${lineNum}`,
          name,
          qname,
          kind: receiver ? 'method' : 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: CodeParser.signatureFrom(signatureText),
          isExported: name[0] === name[0].toUpperCase(),
        });
        continue;
      }

      // Calls. String-stripped so query text cannot fake a call.
      const callMatches = codeOnly.matchAll(CALL_PATTERN);
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
    let inTemplate = false;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      const wasInTemplate = inTemplate;
      const stripped = CodeParser.stripStringLiterals(line, inTemplate, inBlockComment);
      inTemplate = stripped.inTemplate;
      inBlockComment = stripped.inBlockComment;
      const codeOnly = stripped.code.trim();

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
          signature: CodeParser.signatureFrom(trimmed),
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

      // fn: [pub] [async] fn foo(...)  — parameters may wrap
      const fnMatch = codeOnly.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/);
      if (fnMatch) {
        const name = fnMatch[1];
        const qname = currentImpl ? `${currentImpl}::${name}` : name;
        const { text: signatureText } = CodeParser.gatherHeader(lines, i);
        symbols.push({
          id: `${file}:${qname}:${lineNum}`,
          name,
          qname,
          kind: currentImpl ? 'method' : 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: CodeParser.signatureFrom(signatureText),
          isExported: trimmed.startsWith('pub'),
        });
        continue;
      }

      if (trimmed === '}' && currentImpl) {
        currentImpl = null;
      }

      // Calls. String-stripped so query text cannot fake a call.
      const callMatches = codeOnly.matchAll(CALL_PATTERN_RUST);
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
    let inTemplate = false;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      const wasInTemplate = inTemplate;
      const stripped = CodeParser.stripStringLiterals(line, inTemplate, inBlockComment);
      inTemplate = stripped.inTemplate;
      inBlockComment = stripped.inBlockComment;
      const codeOnly = stripped.code.trim();

      // Function/method pattern: returnType methodName(args) {
      const fnMatch = codeOnly.match(
        /^(?:(?:public|private|protected|static|inline|virtual)\s+)*[\w<>:*&]+\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*\{?/
      );
      if (fnMatch && !NON_DECLARATION_KEYWORDS.has(fnMatch[1])) {
        const name = fnMatch[1];
        const { text: genericSignature } = CodeParser.gatherHeader(lines, i);
        symbols.push({
          id: `${file}:${name}:${lineNum}`,
          name,
          qname: name,
          kind: 'function',
          file,
          startLine: lineNum,
          endLine: lineNum,
          signature: CodeParser.signatureFrom(genericSignature),
        });
      }
    }
  }

  /** Directory names that hold compiled output rather than authored source. */
  private static readonly BUILD_DIRS = [
    'lib',
    'dist',
    'build',
    'out',
    'target',
    'esm',
    'cjs',
    'compiled',
  ];

  /** Directory names that hold authored source. */
  private static readonly SOURCE_DIRS = ['src', 'source', 'app', 'packages'];

  /** Recognised module extensions, longest first so `.tsx` beats `.ts`. */
  private static readonly MODULE_EXTENSIONS = [
    '.tsx',
    '.ts',
    '.jsx',
    '.js',
    '.mjs',
    '.cjs',
    '.py',
    '.go',
    '.rs',
  ];

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
  private static resolveRelativeCandidates(currentFile: string, importPath: string): string[] {
    if (!importPath.startsWith('.')) return [];

    const dir = dirname(currentFile);
    const base = join(dir, importPath).replace(/\\/g, '/').replace(/\/+$/, '');

    const seen = new Set<string>();
    const expanded = new Set<string>();
    const out: string[] = [];

    /** Add one literal path plus every extension/index variant of its stem. */
    const addPath = (raw: string) => {
      if (raw.length === 0) return;

      if (!seen.has(raw)) {
        seen.add(raw);
        out.push(raw);
      }

      // Always expand the extension-less stem, even when `raw` has no extension:
      // `./b` must still offer `b.ts`, `b/index.ts` and so on.
      const stem = raw.replace(/\.(tsx|ts|jsx|js|mjs|cjs|py|go|rs)$/, '');
      if (expanded.has(stem)) return;
      expanded.add(stem);

      if (!seen.has(stem)) {
        seen.add(stem);
        out.push(stem);
      }
      for (const ext of CodeParser.MODULE_EXTENSIONS) out.push(`${stem}${ext}`);
      for (const ext of CodeParser.MODULE_EXTENSIONS) out.push(`${stem}/index${ext}`);
      out.push(`${stem}/__init__.py`);
    };

    addPath(base);

    // Map build-output directories back onto source directories, segment by
    // segment, so `lib/config.js` also offers `src/config.ts`.
    const parts = base.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (!CodeParser.BUILD_DIRS.includes(parts[i])) continue;
      // Never rewrite the file name itself.
      if (i === parts.length - 1) continue;

      for (const sourceDir of CodeParser.SOURCE_DIRS) {
        const mapped = [...parts];
        mapped[i] = sourceDir;
        addPath(mapped.join('/'));
      }
    }

    return Array.from(new Set(out));
  }

  /**
   * Accurately calculate the endLine for each symbol (functions, methods, classes)
   * so that structural hashing, git diff range mapping, and definition lookups
   * cover the full body of the code block rather than just the signature line.
   */
  private static computeEndLines(lines: string[], symbols: CodeSymbol[], lang: string): void {
    if (symbols.length === 0) return;

    for (let sIdx = 0; sIdx < symbols.length; sIdx++) {
      const sym = symbols[sIdx];
      const startIdx = Math.max(0, sym.startLine - 1);

      if (lang === 'python') {
        // Python: indentation-based block boundary
        const startLine = lines[startIdx] || '';
        const matchIndent = startLine.match(/^([ \t]*)/);
        const baseIndent = matchIndent ? matchIndent[1].length : 0;

        // A wrapped signature puts its closing `):` back at the def's own indent,
        // which the indentation scan would read as the end of the block. Skip past
        // the header first, then measure the body.
        const headerEndIdx = CodeParser.gatherParens(lines, startIdx).endIdx;

        let endLine = Math.max(sym.startLine, headerEndIdx + 1);
        for (let i = Math.max(startIdx + 1, headerEndIdx + 1); i < lines.length; i++) {
          const l = lines[i];
          const trimmed = l.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            // Empty line or comment continues the block if subsequent lines are indented
            continue;
          }
          const currMatch = l.match(/^([ \t]*)/);
          const currIndent = currMatch ? currMatch[1].length : 0;
          if (currIndent <= baseIndent) {
            break;
          }
          endLine = i + 1;
        }
        sym.endLine = Math.max(sym.startLine, endLine);
      } else {
        // Brace-based languages: TS, JS, Go, Rust, Java, C, C++
        //
        // Counting braces from the declaration's first line is wrong: braces can
        // appear inside the parameter list (a default `= {}`, a destructured
        // argument) and inside the return type (`Promise<{ a: number }>`). Those
        // balanced braces closed the count immediately, so a 380-line function
        // was recorded as ending on its own signature line.
        //
        // The body brace is found by scanning the header with angle-bracket awareness:
        // the last `{` on the header's final line, which skips a `Promise<{ … }>`
        // return type that sits before it.
        const headerEndIdx = CodeParser.gatherHeader(lines, startIdx).endIdx;

        let bodyLine = -1;
        let bodyCol = -1;

        const closesOnLine = (lines[headerEndIdx] ?? '').lastIndexOf('{');
        if (closesOnLine >= 0) {
          bodyLine = headerEndIdx;
          bodyCol = closesOnLine;
        }

        if (bodyLine < 0) {
          // No body (a declaration without braces): the signature line is all there is.
          sym.endLine = Math.max(sym.startLine, headerEndIdx + 1);
          continue;
        }

        let openBraces = 0;
        let endLine = Math.max(sym.startLine, bodyLine + 1);

        for (let i = bodyLine; i < lines.length; i++) {
          const l = lines[i] ?? '';
          // Start counting at the body brace, ignoring anything before it.
          const from = i === bodyLine ? bodyCol : 0;
          const slice = l.slice(from);

          openBraces += (slice.match(/{/g) || []).length - (slice.match(/}/g) || []).length;

          if (openBraces <= 0) {
            endLine = i + 1;
            break;
          }
        }

        sym.endLine = Math.max(sym.startLine, endLine);
      }
    }
  }
}
