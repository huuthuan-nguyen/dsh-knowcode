import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
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
    static detectLanguage(filePath) {
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
    static isTestFile(filePath) {
        const lower = filePath.toLowerCase().replace(/\\/g, '/');
        return (lower.includes('.test.') ||
            lower.includes('.spec.') ||
            lower.includes('_test.') ||
            lower.startsWith('test_') ||
            lower.startsWith('tests/') ||
            lower.startsWith('test/') ||
            lower.includes('/tests/') ||
            lower.includes('/__tests__/') ||
            lower.includes('/test/'));
    }
    /**
     * Parse code file into symbols, imports, and calls
     */
    static parseFile(filePath, content) {
        const lang = CodeParser.detectLanguage(filePath);
        if (!lang)
            return null;
        const source = content ?? readFileSync(filePath, 'utf8');
        const hash = createHash('sha256').update(source).digest('hex');
        const lines = source.split('\n');
        const lineCount = lines.length;
        const size = Buffer.byteLength(source, 'utf8');
        const isTest = CodeParser.isTestFile(filePath);
        const symbols = [];
        const calls = [];
        const imports = [];
        const heritage = [];
        // Parse according to language
        if (lang === 'typescript' || lang === 'javascript') {
            CodeParser.parseJsTs(filePath, lines, symbols, calls, imports, heritage);
        }
        else if (lang === 'python') {
            CodeParser.parsePython(filePath, lines, symbols, calls, imports, heritage);
        }
        else if (lang === 'go') {
            CodeParser.parseGo(filePath, lines, symbols, calls, imports);
        }
        else if (lang === 'rust') {
            CodeParser.parseRust(filePath, lines, symbols, calls, imports);
        }
        else {
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
    static stripStringLiterals(line, inTemplate) {
        let code = '';
        let i = 0;
        let mode = inTemplate ? 'template' : 'none';
        while (i < line.length) {
            const ch = line[i];
            if (mode === 'none') {
                if (ch === '"')
                    mode = 'double';
                else if (ch === "'")
                    mode = 'single';
                else if (ch === '`')
                    mode = 'template';
                else
                    code += ch;
                i++;
                continue;
            }
            // Inside a literal: consume it, but keep character offsets aligned.
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if ((mode === 'double' && ch === '"') ||
                (mode === 'single' && ch === "'") ||
                (mode === 'template' && ch === '`')) {
                mode = 'none';
            }
            i++;
        }
        // Only template literals span lines; a lone quote ends with its line.
        return { code, inTemplate: mode === 'template' };
    }
    /**
     * Whether a gathered declaration is genuinely `… = (params) => …`.
     *
     * The arrow pattern previously accepted any `const NAME = (` whose balanced
     * text merely *contained* `=>`, so
     * `const files = (res.data ?? []).map((row) => ({…}))` was indexed as a
     * function named `files`. The arrow must follow the parameter list itself.
     */
    static isArrowDeclaration(text) {
        const eq = text.indexOf('=');
        if (eq < 0)
            return false;
        let i = eq + 1;
        const skipSpace = () => {
            while (i < text.length && /\s/.test(text[i]))
                i++;
        };
        skipSpace();
        if (text.startsWith('async', i))
            i += 'async'.length;
        skipSpace();
        if (text[i] !== '(')
            return false;
        // Walk to the paren that closes the parameter list.
        let depth = 0;
        for (; i < text.length; i++) {
            if (text[i] === '(')
                depth++;
            else if (text[i] === ')') {
                depth--;
                if (depth === 0) {
                    i++;
                    break;
                }
            }
        }
        if (depth !== 0)
            return false;
        skipSpace();
        if (text.startsWith('=>', i))
            return true;
        // An optional return type may sit between `)` and `=>`.
        if (text[i] === ':') {
            const arrow = text.indexOf('=>', i);
            if (arrow < 0)
                return false;
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
    static signatureFrom(text) {
        const brace = text.lastIndexOf('{');
        return (brace >= 0 ? text.slice(0, brace) : text).trim();
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
    static gatherParens(lines, startIdx, maxLookahead = 40) {
        const parts = [];
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
                }
                else if (ch === ')') {
                    depth--;
                }
            }
            parts.push(raw.trim());
            endIdx = i;
            // Stop as soon as the parameter list balances. When the line has no `(` at
            // all (a brace-only declaration such as `class Foo {`), the header is that
            // single line — continuing would swallow the first line of the body.
            if (!sawOpen)
                break;
            if (depth <= 0)
                break;
        }
        return { text: parts.join(' '), endIdx };
    }
    /**
     * Join a declaration's lines up to the line that opens its body, for
     * declarations whose header (extends/implements clauses) may wrap.
     *
     * @returns the joined header, and the index of its last line so callers can
     *   avoid counting that line's braces twice.
     */
    static gatherToBrace(lines, startIdx, maxLookahead = 20) {
        const parts = [];
        let endIdx = startIdx;
        for (let i = startIdx; i < lines.length && i - startIdx <= maxLookahead; i++) {
            const raw = lines[i] ?? '';
            parts.push(raw.trim());
            endIdx = i;
            if (raw.includes('{'))
                break;
        }
        return { text: parts.join(' '), endIdx };
    }
    /**
     * Parse TypeScript / JavaScript files
     */
    static parseJsTs(file, lines, symbols, calls, imports, heritage) {
        let currentClass = null;
        let classBraceDepth = 0;
        /** Last line of the current class header; its braces are already counted. */
        let classHeaderEndIdx = -1;
        let currentDoc = [];
        let inDoc = false;
        /** Tracks an open multi-line template literal across iterations. */
        let inTemplate = false;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const line = lines[i];
            const trimmed = line.trim();
            const stripped = CodeParser.stripStringLiterals(line, inTemplate);
            inTemplate = stripped.inTemplate;
            const codeOnly = stripped.code.trim();
            // Collect docstring
            if (trimmed.startsWith('/**')) {
                currentDoc = [trimmed];
                inDoc = !trimmed.endsWith('*/');
                continue;
            }
            else if (inDoc) {
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
                const specifiers = [];
                if (defaultImp)
                    specifiers.push(defaultImp);
                if (namespaceImp)
                    specifiers.push(namespaceImp);
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
            const classHeaderInfo = CodeParser.gatherToBrace(lines, i);
            const classHeader = classHeaderInfo.text;
            const classGate = codeOnly.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/);
            const classMatch = classGate
                ? classHeader.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+))?/)
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
            const ifaceHeaderInfo = CodeParser.gatherToBrace(lines, i);
            const ifaceHeader = ifaceHeaderInfo.text;
            const ifaceMatch = codeOnly.match(/^(?:export\s+)?interface\s+(\w+)/)
                ? ifaceHeader.match(/^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w\s,]+))?/)
                : null;
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
                const methodMatch = classBraceDepth === 1
                    ? codeOnly.match(/^(?:(public|private|protected)\s+)?(?:async\s+)?(\w+)\s*\(/)
                    : null;
                if (methodMatch && !NON_DECLARATION_KEYWORDS.has(methodMatch[2])) {
                    const vis = methodMatch[1] ?? 'public';
                    const name = methodMatch[2];
                    const qname = `${currentClass}.${name}`;
                    const { text: signatureText } = CodeParser.gatherParens(lines, i);
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
                if (methodMatch)
                    continue;
            }
            // Function: [export] [async] function foo(...)  — parameters may wrap
            const fnMatch = codeOnly.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
            if (fnMatch) {
                const name = fnMatch[1];
                const { text: signatureText } = CodeParser.gatherParens(lines, i);
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
                currentDoc = [];
                continue;
            }
            // Arrow function / const: [export] const foo = (async)? (...) =>  — parameters may wrap
            const arrowMatch = codeOnly.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
            if (arrowMatch) {
                const name = arrowMatch[1];
                const { text: signatureText } = CodeParser.gatherParens(lines, i);
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
                    currentDoc = [];
                    continue;
                }
            }
            // Call extraction: foo.bar(...) or baz(...). Runs on the string-stripped
            // line so query text (SQL, Cypher) cannot masquerade as calls.
            const callMatches = codeOnly.matchAll(CALL_PATTERN);
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
    static parsePython(file, lines, symbols, calls, imports, heritage) {
        let currentClass = null;
        let currentDoc = [];
        /** Tracks an open multi-line string literal across iterations. */
        let inTemplate = false;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const line = lines[i];
            const trimmed = line.trim();
            const stripped = CodeParser.stripStringLiterals(line, inTemplate);
            inTemplate = stripped.inTemplate;
            const codeOnly = stripped.code.trim();
            // Reset currentClass if an unindented, non-comment, non-empty statement appears
            if (currentClass && trimmed.length > 0 && !trimmed.startsWith('#')) {
                const isIndented = line.startsWith(' ') || line.startsWith('\t');
                if (!isIndented && !trimmed.startsWith('class ')) {
                    currentClass = null;
                }
            }
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
                if (['if', 'for', 'while', 'with', 'def', 'class', 'return', 'except'].includes(fn))
                    continue;
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
    static parseGo(file, lines, symbols, calls, imports) {
        let inTemplate = false;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const line = lines[i];
            const trimmed = line.trim();
            const stripped = CodeParser.stripStringLiterals(line, inTemplate);
            inTemplate = stripped.inTemplate;
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
                    kind: kind,
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
                const { text: signatureText } = CodeParser.gatherParens(lines, i);
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
                if (['if', 'for', 'switch', 'select', 'func', 'return'].includes(fn))
                    continue;
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
    static parseRust(file, lines, symbols, calls, imports) {
        let currentImpl = null;
        let inTemplate = false;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const line = lines[i];
            const trimmed = line.trim();
            const stripped = CodeParser.stripStringLiterals(line, inTemplate);
            inTemplate = stripped.inTemplate;
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
                    kind: (kind === 'trait' ? 'trait' : 'struct'),
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
                const { text: signatureText } = CodeParser.gatherParens(lines, i);
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
                if (['if', 'while', 'match', 'for', 'return', 'fn', 'let'].includes(fn))
                    continue;
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
    static parseGeneric(file, lines, symbols, calls) {
        let inTemplate = false;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const line = lines[i];
            const trimmed = line.trim();
            const stripped = CodeParser.stripStringLiterals(line, inTemplate);
            inTemplate = stripped.inTemplate;
            const codeOnly = stripped.code.trim();
            // Function/method pattern: returnType methodName(args) {
            const fnMatch = codeOnly.match(/^(?:(?:public|private|protected|static|inline|virtual)\s+)*[\w<>:*&]+\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*\{?/);
            if (fnMatch && !NON_DECLARATION_KEYWORDS.has(fnMatch[1])) {
                const name = fnMatch[1];
                symbols.push({
                    id: `${file}:${name}:${lineNum}`,
                    name,
                    qname: name,
                    kind: 'function',
                    file,
                    startLine: lineNum,
                    endLine: lineNum,
                    signature: CodeParser.signatureFrom(trimmed),
                });
            }
        }
    }
    /** Directory names that hold compiled output rather than authored source. */
    static BUILD_DIRS = [
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
    static SOURCE_DIRS = ['src', 'source', 'app', 'packages'];
    /** Recognised module extensions, longest first so `.tsx` beats `.ts`. */
    static MODULE_EXTENSIONS = [
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
    static resolveRelativeCandidates(currentFile, importPath) {
        if (!importPath.startsWith('.'))
            return [];
        const dir = dirname(currentFile);
        const base = join(dir, importPath).replace(/\\/g, '/').replace(/\/+$/, '');
        const seen = new Set();
        const expanded = new Set();
        const out = [];
        /** Add one literal path plus every extension/index variant of its stem. */
        const addPath = (raw) => {
            if (raw.length === 0)
                return;
            if (!seen.has(raw)) {
                seen.add(raw);
                out.push(raw);
            }
            // Always expand the extension-less stem, even when `raw` has no extension:
            // `./b` must still offer `b.ts`, `b/index.ts` and so on.
            const stem = raw.replace(/\.(tsx|ts|jsx|js|mjs|cjs|py|go|rs)$/, '');
            if (expanded.has(stem))
                return;
            expanded.add(stem);
            if (!seen.has(stem)) {
                seen.add(stem);
                out.push(stem);
            }
            for (const ext of CodeParser.MODULE_EXTENSIONS)
                out.push(`${stem}${ext}`);
            for (const ext of CodeParser.MODULE_EXTENSIONS)
                out.push(`${stem}/index${ext}`);
            out.push(`${stem}/__init__.py`);
        };
        addPath(base);
        // Map build-output directories back onto source directories, segment by
        // segment, so `lib/config.js` also offers `src/config.ts`.
        const parts = base.split('/');
        for (let i = 0; i < parts.length; i++) {
            if (!CodeParser.BUILD_DIRS.includes(parts[i]))
                continue;
            // Never rewrite the file name itself.
            if (i === parts.length - 1)
                continue;
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
    static computeEndLines(lines, symbols, lang) {
        if (symbols.length === 0)
            return;
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
            }
            else {
                // Brace-based languages: TS, JS, Go, Rust, Java, C, C++
                //
                // Counting braces from the declaration's first line is wrong: braces can
                // appear inside the parameter list (a default `= {}`, a destructured
                // argument) and inside the return type (`Promise<{ a: number }>`). Those
                // balanced braces closed the count immediately, so a 380-line function
                // was recorded as ending on its own signature line.
                //
                // The body's opening brace is therefore located explicitly: the last `{`
                // on the line that closes the parameter list (skipping a `{...}` return
                // type that precedes it), or the first `{` on a nearby following line when
                // the header ends without one.
                const headerEndIdx = CodeParser.gatherParens(lines, startIdx).endIdx;
                let bodyLine = -1;
                let bodyCol = -1;
                const closesOnLine = (lines[headerEndIdx] ?? '').lastIndexOf('{');
                if (closesOnLine >= 0) {
                    bodyLine = headerEndIdx;
                    bodyCol = closesOnLine;
                }
                else {
                    for (let i = headerEndIdx + 1; i < lines.length && i <= headerEndIdx + 3; i++) {
                        const col = (lines[i] ?? '').indexOf('{');
                        if (col >= 0) {
                            bodyLine = i;
                            bodyCol = col;
                            break;
                        }
                    }
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
