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
/**
 * Trim a gathered declaration to just its signature.
 * Cuts at the last `{` of the header.
 */
export function signatureFrom(text) {
    const brace = text.lastIndexOf('{');
    return (brace >= 0 ? text.slice(0, brace) : text).trim();
}
/**
 * Gather declaration header lines from start line up to the line opening the body.
 */
export function gatherHeader(lines, startIdx, maxLookahead = 40) {
    const parts = [];
    let paren = 0;
    let angle = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < lines.length && i - startIdx <= maxLookahead; i++) {
        const raw = lines[i] ?? '';
        const code = raw.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        let bodyBrace = false;
        for (const ch of code) {
            if (ch === '(')
                paren++;
            else if (ch === ')')
                paren = Math.max(0, paren - 1);
            else if (ch === '<')
                angle++;
            else if (ch === '>')
                angle = Math.max(0, angle - 1);
            else if (ch === '{' && paren === 0 && angle === 0)
                bodyBrace = true;
        }
        parts.push(raw.trim());
        endIdx = i;
        if (bodyBrace)
            break;
        if (paren === 0 && angle === 0 && /=>\s*$/.test(code))
            break;
    }
    return { text: parts.join(' '), endIdx };
}
/**
 * Extract docstring comment immediately preceding a node.
 */
function extractDocstring(node, lines) {
    let prev = node.previousNamedSibling;
    if (!prev && node.parent && node.parent.type === 'export_statement') {
        prev = node.parent.previousNamedSibling;
    }
    if (!prev) {
        let sibling = node.previousSibling;
        if (!sibling && node.parent && node.parent.type === 'export_statement') {
            sibling = node.parent.previousSibling;
        }
        while (sibling) {
            if (sibling.type === 'comment') {
                prev = sibling;
                break;
            }
            sibling = sibling.previousSibling;
        }
    }
    if (prev && prev.type === 'comment') {
        const text = prev.text.trim();
        if (text.startsWith('/**') || text.startsWith('/*') || text.startsWith('//') || text.startsWith('#')) {
            return text
                .split('\n')
                .map((l) => l.trim())
                .join('\n');
        }
    }
    return undefined;
}
export function parseWithTreeSitterAst(filePath, language, source, lines, tree, resolveCandidates) {
    const symbols = [];
    const calls = [];
    const imports = [];
    const heritage = [];
    const lang = language.toLowerCase();
    switch (lang) {
        case 'typescript':
        case 'javascript':
        case 'tsx':
            parseTsJsAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'python':
            parsePythonAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'go':
            parseGoAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'rust':
            parseRustAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'c':
        case 'cpp':
            parseCppAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'java':
            parseJavaAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'c_sharp':
        case 'csharp':
        case 'cs':
            parseCSharpAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'ruby':
            parseRubyAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'php':
            parsePhpAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'kotlin':
            parseKotlinAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'solidity':
            parseSolidityAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'lua':
            parseLuaAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'zig':
            parseZigAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        case 'bash':
            parseBashAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
        default:
            // Universal Polyglot Tree-Sitter AST parser for ANY other language!
            parseUniversalAst(filePath, lines, tree.rootNode, symbols, calls, imports, heritage, resolveCandidates);
            break;
    }
    return { symbols, calls, imports, heritage };
}
// ---------------------------------------------------------------------------
// TypeScript & JavaScript AST Walker
// ---------------------------------------------------------------------------
function parseTsJsAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    const scopeStack = [];
    function visit(node) {
        if (node.type === 'import_statement') {
            const sourceNode = node.childForFieldName('source');
            if (sourceNode) {
                const importPath = sourceNode.text.replace(/^['"`]|['"`]$/g, '');
                const specifiers = [];
                for (const child of node.children) {
                    if (child.type === 'import_clause') {
                        for (const sub of child.children) {
                            if (sub.type === 'identifier') {
                                specifiers.push(sub.text);
                            }
                            else if (sub.type === 'named_imports') {
                                for (const impSpec of sub.children) {
                                    if (impSpec.type === 'import_specifier') {
                                        const nameNode = impSpec.childForFieldName('name') ?? impSpec.children[0];
                                        if (nameNode)
                                            specifiers.push(nameNode.text);
                                    }
                                }
                            }
                            else if (sub.type === 'namespace_import') {
                                const idNode = sub.children.find((c) => c.type === 'identifier');
                                if (idNode)
                                    specifiers.push(idNode.text);
                            }
                        }
                    }
                }
                const candidates = resolveCandidates(file, importPath);
                imports.push({
                    sourceFile: file,
                    importedPath: importPath,
                    resolvedFile: candidates[0],
                    resolvedCandidates: candidates,
                    specifiers,
                });
            }
            return;
        }
        if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
            const isExported = node.parent?.type === 'export_statement';
            const outerNode = isExported ? node.parent : node;
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = outerNode.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const docstring = extractDocstring(node, lines);
                const symId = `${file}:${name}:${startLine}`;
                const clsSymbol = {
                    id: symId,
                    name,
                    qname: name,
                    kind: 'class',
                    file,
                    startLine,
                    endLine,
                    signature,
                    docstring,
                    isExported,
                };
                symbols.push(clsSymbol);
                const heritageNode = node.children.find((c) => c.type === 'class_heritage');
                if (heritageNode) {
                    for (const clause of heritageNode.children) {
                        if (clause.type === 'extends_clause') {
                            for (const c of clause.children) {
                                if (c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'nested_identifier') {
                                    heritage.push({ subSymbolId: symId, superSymbolName: c.text, kind: 'extends' });
                                    break;
                                }
                            }
                        }
                        else if (clause.type === 'implements_clause') {
                            for (const c of clause.children) {
                                if (c.type === 'type_identifier' || c.type === 'nested_identifier') {
                                    heritage.push({ subSymbolId: symId, superSymbolName: c.text, kind: 'implements' });
                                }
                            }
                        }
                    }
                }
                scopeStack.push(clsSymbol);
                const body = node.childForFieldName('body');
                if (body) {
                    for (const member of body.children) {
                        visitClassMember(file, lines, name, member, symbols, calls);
                    }
                }
                scopeStack.pop();
                return;
            }
        }
        if (node.type === 'interface_declaration') {
            const isExported = node.parent?.type === 'export_statement';
            const outerNode = isExported ? node.parent : node;
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = outerNode.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const docstring = extractDocstring(node, lines);
                const symId = `${file}:${name}:${startLine}`;
                const ifaceSymbol = {
                    id: symId,
                    name,
                    qname: name,
                    kind: 'interface',
                    file,
                    startLine,
                    endLine,
                    signature,
                    docstring,
                    isExported,
                };
                symbols.push(ifaceSymbol);
                const extendsClause = node.children.find((c) => c.type === 'extends_type_clause');
                if (extendsClause) {
                    for (const c of extendsClause.children) {
                        if (c.type === 'type_identifier' || c.type === 'nested_identifier') {
                            heritage.push({ subSymbolId: symId, superSymbolName: c.text, kind: 'extends' });
                        }
                    }
                }
                const body = node.childForFieldName('body');
                if (body) {
                    for (const member of body.children) {
                        if (member.type === 'method_signature' ||
                            member.type === 'property_signature' ||
                            member.type === 'call_signature') {
                            const mNameNode = member.childForFieldName('name') ?? member.children[0];
                            if (mNameNode && !NON_DECLARATION_KEYWORDS.has(mNameNode.text)) {
                                const memberName = mNameNode.text;
                                const mStartLine = member.startPosition.row + 1;
                                const mEndLine = member.endPosition.row + 1;
                                const mSig = lines[mStartLine - 1]?.trim().replace(/[;{].*$/, '').trim() ?? memberName;
                                symbols.push({
                                    id: `${file}:${name}.${memberName}:${mStartLine}`,
                                    name: memberName,
                                    qname: `${name}.${memberName}`,
                                    kind: 'method',
                                    file,
                                    startLine: mStartLine,
                                    endLine: mEndLine,
                                    signature: mSig,
                                    isExported: true,
                                });
                            }
                        }
                    }
                }
                return;
            }
        }
        if (node.type === 'type_alias_declaration') {
            const isExported = node.parent?.type === 'export_statement';
            const outerNode = isExported ? node.parent : node;
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = outerNode.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const sig = lines[startLine - 1]?.trim() ?? `type ${name} = ...`;
                symbols.push({
                    id: `${file}:${name}:${startLine}`,
                    name,
                    qname: name,
                    kind: 'type',
                    file,
                    startLine,
                    endLine,
                    signature: sig,
                    docstring: extractDocstring(node, lines),
                    isExported,
                });
                return;
            }
        }
        if (node.type === 'enum_declaration') {
            const isExported = node.parent?.type === 'export_statement';
            const outerNode = isExported ? node.parent : node;
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = outerNode.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const sig = lines[startLine - 1]?.trim() ?? `enum ${name}`;
                symbols.push({
                    id: `${file}:${name}:${startLine}`,
                    name,
                    qname: name,
                    kind: 'enum',
                    file,
                    startLine,
                    endLine,
                    signature: sig,
                    docstring: extractDocstring(node, lines),
                    isExported,
                });
                return;
            }
        }
        if (node.type === 'function_declaration') {
            const isExported = node.parent?.type === 'export_statement';
            const outerNode = isExported ? node.parent : node;
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = outerNode.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const docstring = extractDocstring(node, lines);
                const symId = `${file}:${name}:${startLine}`;
                const fnSymbol = {
                    id: symId,
                    name,
                    qname: name,
                    kind: 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    docstring,
                    isExported,
                };
                symbols.push(fnSymbol);
                scopeStack.push(fnSymbol);
                const body = node.childForFieldName('body');
                if (body) {
                    collectTsJsCalls(file, body, fnSymbol.id, calls);
                }
                scopeStack.pop();
                return;
            }
        }
        if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
            const isExported = node.parent?.type === 'export_statement';
            const outerNode = isExported ? node.parent : node;
            for (const declarator of node.children.filter((c) => c.type === 'variable_declarator')) {
                const value = declarator.childForFieldName('value');
                if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
                    const nameNode = declarator.childForFieldName('name');
                    if (nameNode && nameNode.type === 'identifier') {
                        const name = nameNode.text;
                        const startLine = outerNode.startPosition.row + 1;
                        const endLine = value.endPosition.row + 1;
                        const headerInfo = gatherHeader(lines, startLine - 1);
                        const signature = signatureFrom(headerInfo.text);
                        const docstring = extractDocstring(node, lines);
                        const symId = `${file}:${name}:${startLine}`;
                        const fnSymbol = {
                            id: symId,
                            name,
                            qname: name,
                            kind: 'function',
                            file,
                            startLine,
                            endLine,
                            signature,
                            docstring,
                            isExported,
                        };
                        symbols.push(fnSymbol);
                        scopeStack.push(fnSymbol);
                        const body = value.childForFieldName('body') ?? value;
                        collectTsJsCalls(file, body, fnSymbol.id, calls);
                        scopeStack.pop();
                    }
                }
            }
            return;
        }
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
}
function visitClassMember(file, lines, className, member, symbols, calls) {
    if (member.type === 'method_definition') {
        const nameNode = member.childForFieldName('name');
        if (!nameNode)
            return;
        const name = nameNode.text;
        if (NON_DECLARATION_KEYWORDS.has(name))
            return;
        const startLine = member.startPosition.row + 1;
        const endLine = member.endPosition.row + 1;
        const qname = `${className}.${name}`;
        const symId = `${file}:${qname}:${startLine}`;
        const memberText = member.text;
        const vis = /private\b/.test(memberText)
            ? 'private'
            : /protected\b/.test(memberText)
                ? 'protected'
                : 'public';
        const headerInfo = gatherHeader(lines, startLine - 1);
        const signature = signatureFrom(headerInfo.text);
        const docstring = extractDocstring(member, lines);
        const methodSymbol = {
            id: symId,
            name,
            qname,
            kind: 'method',
            file,
            startLine,
            endLine,
            signature,
            docstring,
            visibility: vis,
        };
        symbols.push(methodSymbol);
        const body = member.childForFieldName('body');
        if (body) {
            collectTsJsCalls(file, body, symId, calls);
        }
    }
    else if (member.type === 'field_definition' || member.type === 'class_field' || member.type === 'public_field_definition') {
        const classSymId = `${file}:${className}:${member.parent?.parent?.startPosition.row ? member.parent.parent.startPosition.row + 1 : member.startPosition.row + 1}`;
        const value = member.childForFieldName('value');
        if (value) {
            collectTsJsCalls(file, value, classSymId, calls);
        }
    }
}
function collectTsJsCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'call_expression') {
            const fnNode = node.childForFieldName('function');
            if (fnNode) {
                recordCall(file, fnNode, node.startPosition.row + 1, callerId, calls);
            }
        }
        else if (node.type === 'new_expression') {
            const ctorNode = node.childForFieldName('constructor');
            if (ctorNode) {
                recordCall(file, ctorNode, node.startPosition.row + 1, callerId, calls);
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
function recordCall(file, fnNode, line, callerId, calls) {
    let calleeName = '';
    let calleeQName = '';
    if (fnNode.type === 'identifier') {
        calleeName = fnNode.text;
        calleeQName = fnNode.text;
    }
    else if (fnNode.type === 'member_expression') {
        const propNode = fnNode.childForFieldName('property');
        const objNode = fnNode.childForFieldName('object');
        if (propNode) {
            calleeName = propNode.text;
            if (objNode) {
                const objText = objNode.text;
                const lastIdent = objText.split('.').pop() ?? '';
                if (/^[A-Za-z_$][\w$]*$/.test(lastIdent)) {
                    calleeQName = `${lastIdent}.${calleeName}`;
                }
                else {
                    calleeQName = calleeName;
                }
            }
            else {
                calleeQName = calleeName;
            }
        }
    }
    if (calleeName && !NON_DECLARATION_KEYWORDS.has(calleeName) && calleeName !== 'require' && calleeName !== 'import') {
        calls.push({
            callerId,
            calleeName,
            calleeQName: calleeQName || calleeName,
            file,
            line,
        });
    }
}
// ---------------------------------------------------------------------------
// Python AST Walker
// ---------------------------------------------------------------------------
function parsePythonAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node, currentClass = null) {
        if (node.type === 'import_statement') {
            for (const child of node.children) {
                if (child.type === 'dotted_name') {
                    const mod = child.text;
                    const candidates = resolveCandidates(file, mod);
                    imports.push({
                        sourceFile: file,
                        importedPath: mod,
                        resolvedFile: candidates[0],
                        resolvedCandidates: candidates,
                        specifiers: [mod],
                    });
                }
            }
            return;
        }
        if (node.type === 'import_from_statement') {
            const importIdx = node.children.findIndex((c) => c.text === 'import');
            if (importIdx !== -1) {
                const modNode = node.children
                    .slice(0, importIdx)
                    .find((c) => c.type === 'dotted_name' || c.type === 'relative_import');
                const mod = modNode ? modNode.text : '';
                const specifiers = [];
                for (const c of node.children.slice(importIdx + 1)) {
                    if (c.type === 'dotted_name' || c.type === 'identifier') {
                        specifiers.push(c.text);
                    }
                    else if (c.type === 'aliased_import') {
                        const nameNode = c.childForFieldName('name') ?? c.children[0];
                        if (nameNode)
                            specifiers.push(nameNode.text);
                    }
                    else if (c.type === 'wildcard_import') {
                        specifiers.push('*');
                    }
                }
                if (mod) {
                    const candidates = resolveCandidates(file, mod);
                    imports.push({
                        sourceFile: file,
                        importedPath: mod,
                        resolvedFile: candidates[0],
                        resolvedCandidates: candidates,
                        specifiers,
                    });
                }
            }
            return;
        }
        if (node.type === 'class_definition') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const docstring = extractPythonDocstring(node);
                const symId = `${file}:${name}:${startLine}`;
                const clsSymbol = {
                    id: symId,
                    name,
                    qname: name,
                    kind: 'class',
                    file,
                    startLine,
                    endLine,
                    signature,
                    docstring,
                    isExported: !name.startsWith('_'),
                };
                symbols.push(clsSymbol);
                const superclassesNode = node.childForFieldName('superclasses');
                if (superclassesNode) {
                    for (const sc of superclassesNode.children) {
                        if (sc.type === 'identifier' || sc.type === 'attribute') {
                            heritage.push({ subSymbolId: symId, superSymbolName: sc.text, kind: 'extends' });
                        }
                    }
                }
                const body = node.childForFieldName('body');
                if (body) {
                    for (const child of body.children) {
                        visit(child, name);
                    }
                }
                return;
            }
        }
        if (node.type === 'function_definition') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const docstring = extractPythonDocstring(node);
                const isMethod = Boolean(currentClass);
                const qname = isMethod ? `${currentClass}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const fnSymbol = {
                    id: symId,
                    name,
                    qname,
                    kind: isMethod ? 'method' : 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    docstring,
                    isExported: !name.startsWith('_'),
                };
                symbols.push(fnSymbol);
                const body = node.childForFieldName('body');
                if (body) {
                    collectPythonCalls(file, body, symId, calls);
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child, currentClass);
        }
    }
    visit(root, null);
}
function extractPythonDocstring(node) {
    const body = node.childForFieldName('body');
    if (body) {
        const firstStmt = body.children.find((c) => c.type === 'expression_statement');
        if (firstStmt) {
            const str = firstStmt.children.find((c) => c.type === 'string');
            if (str) {
                return str.text.replace(/^["']{1,3}|["']{1,3}$/g, '').trim();
            }
        }
    }
    return undefined;
}
function collectPythonCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'call') {
            const fnNode = node.childForFieldName('function');
            if (fnNode) {
                let calleeName = '';
                let calleeQName = '';
                if (fnNode.type === 'identifier') {
                    calleeName = fnNode.text;
                    calleeQName = fnNode.text;
                }
                else if (fnNode.type === 'attribute') {
                    const attr = fnNode.childForFieldName('attribute');
                    const obj = fnNode.childForFieldName('object');
                    if (attr) {
                        calleeName = attr.text;
                        calleeQName = obj ? `${obj.text}.${calleeName}` : calleeName;
                    }
                }
                if (calleeName && !NON_DECLARATION_KEYWORDS.has(calleeName)) {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName: calleeQName || calleeName,
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
// ---------------------------------------------------------------------------
// Go AST Walker
// ---------------------------------------------------------------------------
function parseGoAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node) {
        if (node.type === 'import_declaration') {
            for (const spec of node.descendantsOfType('import_spec')) {
                const pathNode = spec.childForFieldName('path');
                if (pathNode) {
                    const importPath = pathNode.text.replace(/^"|"$/g, '');
                    const candidates = resolveCandidates(file, importPath);
                    const nameNode = spec.childForFieldName('name');
                    const specifiers = [nameNode ? nameNode.text : importPath.split('/').pop() ?? importPath];
                    imports.push({
                        sourceFile: file,
                        importedPath: importPath,
                        resolvedFile: candidates[0],
                        resolvedCandidates: candidates,
                        specifiers,
                    });
                }
            }
            return;
        }
        if (node.type === 'type_declaration') {
            for (const spec of node.children.filter((c) => c.type === 'type_spec')) {
                const nameNode = spec.childForFieldName('name');
                const typeNode = spec.childForFieldName('type');
                if (nameNode) {
                    const name = nameNode.text;
                    const startLine = node.startPosition.row + 1;
                    const endLine = node.endPosition.row + 1;
                    const kind = typeNode?.type === 'struct_type' ? 'struct' : typeNode?.type === 'interface_type' ? 'interface' : 'type';
                    const sig = lines[startLine - 1]?.trim() ?? `type ${name}`;
                    symbols.push({
                        id: `${file}:${name}:${startLine}`,
                        name,
                        qname: name,
                        kind,
                        file,
                        startLine,
                        endLine,
                        signature: sig,
                        isExported: /^[A-Z]/.test(name),
                    });
                }
            }
            return;
        }
        if (node.type === 'function_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const symId = `${file}:${name}:${startLine}`;
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: /^[A-Z]/.test(name),
                });
                const body = node.childForFieldName('body');
                if (body) {
                    collectGoCalls(file, body, symId, calls);
                }
                return;
            }
        }
        if (node.type === 'method_declaration') {
            const nameNode = node.childForFieldName('name');
            const receiverNode = node.childForFieldName('receiver');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                let receiverType = '';
                if (receiverNode) {
                    const raw = receiverNode.text.replace(/[()*]/g, '').trim();
                    receiverType = raw.split(/\s+/).pop() ?? '';
                }
                const qname = receiverType ? `${receiverType}.${name}` : name;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const symId = `${file}:${qname}:${startLine}`;
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: 'method',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: /^[A-Z]/.test(name),
                });
                const body = node.childForFieldName('body');
                if (body) {
                    collectGoCalls(file, body, symId, calls);
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
}
function collectGoCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'call_expression') {
            const fnNode = node.childForFieldName('function');
            if (fnNode) {
                let calleeName = '';
                let calleeQName = '';
                if (fnNode.type === 'identifier') {
                    calleeName = fnNode.text;
                    calleeQName = fnNode.text;
                }
                else if (fnNode.type === 'selector_expression') {
                    const field = fnNode.childForFieldName('field');
                    const operand = fnNode.childForFieldName('operand');
                    if (field) {
                        calleeName = field.text;
                        calleeQName = operand ? `${operand.text}.${calleeName}` : calleeName;
                    }
                }
                if (calleeName && !NON_DECLARATION_KEYWORDS.has(calleeName)) {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName: calleeQName || calleeName,
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
// ---------------------------------------------------------------------------
// Rust AST Walker
// ---------------------------------------------------------------------------
function parseRustAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node) {
        if (node.type === 'use_declaration') {
            const text = node.text.replace(/^use\s+|;$/g, '').trim();
            const specifiers = [text.split('::').pop() ?? text];
            const candidates = resolveCandidates(file, text);
            imports.push({
                sourceFile: file,
                importedPath: text,
                resolvedFile: candidates[0],
                resolvedCandidates: candidates,
                specifiers,
            });
            return;
        }
        if (node.type === 'struct_item') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                symbols.push({
                    id: `${file}:${name}:${startLine}`,
                    name,
                    qname: name,
                    kind: 'struct',
                    file,
                    startLine,
                    endLine,
                    signature: lines[startLine - 1]?.trim() ?? `struct ${name}`,
                    isExported: node.children.some((c) => c.type === 'visibility_modifier'),
                });
                return;
            }
        }
        if (node.type === 'trait_item') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                symbols.push({
                    id: `${file}:${name}:${startLine}`,
                    name,
                    qname: name,
                    kind: 'trait',
                    file,
                    startLine,
                    endLine,
                    signature: lines[startLine - 1]?.trim() ?? `trait ${name}`,
                    isExported: node.children.some((c) => c.type === 'visibility_modifier'),
                });
                return;
            }
        }
        if (node.type === 'impl_item') {
            const traitNode = node.childForFieldName('trait');
            const typeNode = node.childForFieldName('type');
            const typeName = typeNode ? typeNode.text : '';
            const traitName = traitNode ? traitNode.text : '';
            if (traitName && typeName) {
                heritage.push({
                    subSymbolId: `${file}:${typeName}:${node.startPosition.row + 1}`,
                    superSymbolName: traitName,
                    kind: 'implements',
                });
            }
            const body = node.childForFieldName('body');
            if (body) {
                for (const item of body.children.filter((c) => c.type === 'function_item')) {
                    const fnNameNode = item.childForFieldName('name');
                    if (fnNameNode) {
                        const fnName = fnNameNode.text;
                        const startLine = item.startPosition.row + 1;
                        const endLine = item.endPosition.row + 1;
                        const qname = typeName ? `${typeName}.${fnName}` : fnName;
                        const symId = `${file}:${qname}:${startLine}`;
                        const headerInfo = gatherHeader(lines, startLine - 1);
                        const signature = signatureFrom(headerInfo.text);
                        symbols.push({
                            id: symId,
                            name: fnName,
                            qname,
                            kind: 'method',
                            file,
                            startLine,
                            endLine,
                            signature,
                            isExported: item.children.some((c) => c.type === 'visibility_modifier'),
                        });
                        const fnBody = item.childForFieldName('body');
                        if (fnBody) {
                            collectRustCalls(file, fnBody, symId, calls);
                        }
                    }
                }
            }
            return;
        }
        if (node.type === 'function_item') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const symId = `${file}:${name}:${startLine}`;
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: node.children.some((c) => c.type === 'visibility_modifier'),
                });
                const body = node.childForFieldName('body');
                if (body) {
                    collectRustCalls(file, body, symId, calls);
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
}
function collectRustCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'call_expression') {
            const fnNode = node.childForFieldName('function');
            if (fnNode) {
                let calleeName = '';
                let calleeQName = '';
                if (fnNode.type === 'identifier') {
                    calleeName = fnNode.text;
                    calleeQName = fnNode.text;
                }
                else if (fnNode.type === 'field_expression') {
                    const field = fnNode.childForFieldName('field');
                    const value = fnNode.childForFieldName('value');
                    if (field) {
                        calleeName = field.text;
                        calleeQName = value ? `${value.text}.${calleeName}` : calleeName;
                    }
                }
                else if (fnNode.type === 'scoped_identifier') {
                    const name = fnNode.childForFieldName('name');
                    const path = fnNode.childForFieldName('path');
                    if (name) {
                        calleeName = name.text;
                        calleeQName = path ? `${path.text}::${calleeName}` : calleeName;
                    }
                }
                if (calleeName && !NON_DECLARATION_KEYWORDS.has(calleeName)) {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName: calleeQName || calleeName,
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
// ---------------------------------------------------------------------------
// C / C++ AST Walker
// ---------------------------------------------------------------------------
function parseCppAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node, currentClass = null) {
        if (node.type === 'preproc_include') {
            const pathNode = node.childForFieldName('path');
            if (pathNode) {
                const importPath = pathNode.text.replace(/^[<"]|[>"]$/g, '');
                const candidates = resolveCandidates(file, importPath);
                imports.push({
                    sourceFile: file,
                    importedPath: importPath,
                    resolvedFile: candidates[0],
                    resolvedCandidates: candidates,
                    specifiers: [importPath],
                });
            }
            return;
        }
        if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const symId = `${file}:${name}:${startLine}`;
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: node.type === 'class_specifier' ? 'class' : 'struct',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: true,
                });
                const body = node.childForFieldName('body');
                if (body) {
                    for (const member of body.children) {
                        visit(member, name);
                    }
                }
                return;
            }
        }
        if (node.type === 'function_definition') {
            const declarator = node.childForFieldName('declarator');
            let name = '';
            if (declarator) {
                const idNode = declarator.descendantsOfType('field_identifier')[0] ??
                    declarator.descendantsOfType('identifier')[0];
                name = idNode ? idNode.text : declarator.text.replace(/\(.*$/, '').trim();
            }
            if (name && !NON_DECLARATION_KEYWORDS.has(name)) {
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const isMethod = Boolean(currentClass);
                const qname = isMethod ? `${currentClass}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: isMethod ? 'method' : 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: true,
                });
                const body = node.childForFieldName('body');
                if (body) {
                    collectCppCalls(file, body, symId, calls);
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child, currentClass);
        }
    }
    visit(root, null);
}
function collectCppCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'call_expression') {
            const fnNode = node.childForFieldName('function');
            if (fnNode) {
                let calleeName = '';
                let calleeQName = '';
                if (fnNode.type === 'identifier') {
                    calleeName = fnNode.text;
                    calleeQName = fnNode.text;
                }
                else if (fnNode.type === 'field_expression') {
                    const field = fnNode.childForFieldName('field');
                    const argument = fnNode.childForFieldName('argument');
                    if (field) {
                        calleeName = field.text;
                        calleeQName = argument ? `${argument.text}.${calleeName}` : calleeName;
                    }
                }
                if (calleeName && !NON_DECLARATION_KEYWORDS.has(calleeName)) {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName: calleeQName || calleeName,
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
// ---------------------------------------------------------------------------
// Java AST Walker
// ---------------------------------------------------------------------------
function parseJavaAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node) {
        if (node.type === 'import_declaration') {
            const nameNode = node.children.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
            if (nameNode) {
                const importPath = nameNode.text;
                const specifiers = [importPath.split('.').pop() ?? importPath];
                const candidates = resolveCandidates(file, importPath);
                imports.push({
                    sourceFile: file,
                    importedPath: importPath,
                    resolvedFile: candidates[0],
                    resolvedCandidates: candidates,
                    specifiers,
                });
            }
            return;
        }
        if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const headerInfo = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(headerInfo.text);
                const symId = `${file}:${name}:${startLine}`;
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: node.type === 'class_declaration' ? 'class' : 'interface',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: node.children.some((c) => c.type === 'modifiers' && c.text.includes('public')),
                });
                const superclass = node.childForFieldName('superclass');
                if (superclass) {
                    const superName = superclass.descendantsOfType('type_identifier')[0]?.text;
                    if (superName) {
                        heritage.push({ subSymbolId: symId, superSymbolName: superName, kind: 'extends' });
                    }
                }
                const interfaces = node.childForFieldName('interfaces');
                if (interfaces) {
                    for (const iface of interfaces.descendantsOfType('type_identifier')) {
                        heritage.push({ subSymbolId: symId, superSymbolName: iface.text, kind: 'implements' });
                    }
                }
                const body = node.childForFieldName('body');
                if (body) {
                    for (const member of body.children) {
                        if (member.type === 'method_declaration') {
                            const mNameNode = member.childForFieldName('name');
                            if (mNameNode) {
                                const mName = mNameNode.text;
                                const mStartLine = member.startPosition.row + 1;
                                const mEndLine = member.endPosition.row + 1;
                                const mQName = `${name}.${mName}`;
                                const mSymId = `${file}:${mQName}:${mStartLine}`;
                                const hasBody = Boolean(member.childForFieldName('body'));
                                const mSig = hasBody
                                    ? signatureFrom(gatherHeader(lines, mStartLine - 1).text)
                                    : member.text.replace(/;$/, '').trim();
                                symbols.push({
                                    id: mSymId,
                                    name: mName,
                                    qname: mQName,
                                    kind: 'method',
                                    file,
                                    startLine: mStartLine,
                                    endLine: mEndLine,
                                    signature: mSig,
                                    isExported: member.children.some((c) => c.type === 'modifiers' && c.text.includes('public')),
                                });
                                const mBody = member.childForFieldName('body');
                                if (mBody) {
                                    collectJavaCalls(file, mBody, mSymId, calls);
                                }
                            }
                        }
                    }
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
}
function collectJavaCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'method_invocation') {
            const nameNode = node.childForFieldName('name');
            const objNode = node.childForFieldName('object');
            if (nameNode) {
                const calleeName = nameNode.text;
                const calleeQName = objNode ? `${objNode.text}.${calleeName}` : calleeName;
                if (!NON_DECLARATION_KEYWORDS.has(calleeName)) {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName,
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
// ---------------------------------------------------------------------------
// C# AST Walker (c_sharp)
// ---------------------------------------------------------------------------
function parseCSharpAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node, currentContainer = null) {
        if (node.type === 'using_directive') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier' || c.type === 'qualified_name');
            if (nameNode) {
                const ns = nameNode.text;
                const candidates = resolveCandidates(file, ns.replace(/\./g, '/'));
                imports.push({
                    sourceFile: file,
                    importedPath: ns,
                    resolvedFile: candidates[0],
                    resolvedCandidates: candidates,
                    specifiers: [ns.split('.').pop() ?? ns],
                });
            }
            return;
        }
        if (node.type === 'class_declaration' ||
            node.type === 'interface_declaration' ||
            node.type === 'struct_declaration' ||
            node.type === 'record_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const qname = currentContainer ? `${currentContainer}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                const isExported = node.children.some((c) => c.type === 'modifier' && c.text.includes('public'));
                const kind = node.type === 'interface_declaration' ? 'interface' : node.type === 'struct_declaration' ? 'struct' : 'class';
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind,
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported,
                });
                // Base list / Heritage
                const baseList = node.children.find((c) => c.type === 'base_list');
                if (baseList) {
                    for (const baseItem of baseList.children) {
                        if (baseItem.type === 'identifier' || baseItem.type === 'type_identifier' || baseItem.type === 'generic_name') {
                            heritage.push({
                                subSymbolId: symId,
                                superSymbolName: baseItem.text,
                                kind: 'extends',
                            });
                        }
                    }
                }
                const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'declaration_list');
                if (body) {
                    for (const member of body.children) {
                        visit(member, qname);
                    }
                }
                return;
            }
        }
        if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const qname = currentContainer ? `${currentContainer}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                const isExported = node.children.some((c) => c.type === 'modifier' && c.text.includes('public'));
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: 'method',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported,
                });
                const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'block');
                if (body) {
                    collectCSharpCalls(file, body, symId, calls);
                }
                return;
            }
        }
        if (node.type === 'namespace_declaration') {
            const nameNode = node.childForFieldName('name');
            const nsName = nameNode ? nameNode.text : currentContainer;
            for (const child of node.children) {
                visit(child, nsName);
            }
            return;
        }
        for (const child of node.children) {
            visit(child, currentContainer);
        }
    }
    visit(root, null);
}
function collectCSharpCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'invocation_expression') {
            const expr = node.childForFieldName('function') ?? node.children[0];
            if (expr) {
                let calleeName = '';
                let calleeQName = '';
                if (expr.type === 'identifier') {
                    calleeName = expr.text;
                    calleeQName = expr.text;
                }
                else if (expr.type === 'member_access_expression') {
                    const nameNode = expr.childForFieldName('name');
                    const exprNode = expr.childForFieldName('expression');
                    if (nameNode) {
                        calleeName = nameNode.text;
                        calleeQName = exprNode ? `${exprNode.text}.${calleeName}` : calleeName;
                    }
                }
                if (calleeName && !NON_DECLARATION_KEYWORDS.has(calleeName)) {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName: calleeQName || calleeName,
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
// ---------------------------------------------------------------------------
// Ruby AST Walker
// ---------------------------------------------------------------------------
function parseRubyAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node, currentClass = null) {
        // require / require_relative
        if (node.type === 'call') {
            const fn = node.children[0]?.text;
            if (fn === 'require' || fn === 'require_relative') {
                const arg = node.descendantsOfType('string_content')[0]?.text;
                if (arg) {
                    const candidates = resolveCandidates(file, arg.startsWith('.') ? arg : `./${arg}`);
                    imports.push({
                        sourceFile: file,
                        importedPath: arg,
                        resolvedFile: candidates[0],
                        resolvedCandidates: candidates,
                        specifiers: [arg.split('/').pop() ?? arg],
                    });
                }
                return;
            }
        }
        if (node.type === 'class' || node.type === 'module') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'constant');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const qname = currentClass ? `${currentClass}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const sig = lines[startLine - 1]?.trim() ?? `${node.type} ${name}`;
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: node.type === 'module' ? 'module' : 'class',
                    file,
                    startLine,
                    endLine,
                    signature: sig,
                    isExported: true,
                });
                // Superclass
                const superNode = node.children.find((c) => c.type === 'superclass');
                if (superNode) {
                    const superName = superNode.children.find((c) => c.type === 'constant')?.text;
                    if (superName) {
                        heritage.push({ subSymbolId: symId, superSymbolName: superName, kind: 'extends' });
                    }
                }
                const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'body_statement');
                if (body) {
                    for (const member of body.children) {
                        visit(member, qname);
                    }
                }
                return;
            }
        }
        if (node.type === 'method' || node.type === 'singleton_method') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const isMethod = Boolean(currentClass);
                const qname = isMethod ? `${currentClass}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const sig = lines[startLine - 1]?.trim() ?? `def ${name}`;
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: isMethod ? 'method' : 'function',
                    file,
                    startLine,
                    endLine,
                    signature: sig,
                    isExported: !name.startsWith('_'),
                });
                const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'body_statement');
                if (body) {
                    collectRubyCalls(file, body, symId, calls);
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child, currentClass);
        }
    }
    visit(root, null);
}
function collectRubyCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'call') {
            const fnNode = node.childForFieldName('method') ?? node.children.find((c) => c.type === 'identifier');
            if (fnNode) {
                const calleeName = fnNode.text;
                if (!NON_DECLARATION_KEYWORDS.has(calleeName) && calleeName !== 'require' && calleeName !== 'require_relative') {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName: calleeName,
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
// ---------------------------------------------------------------------------
// PHP AST Walker
// ---------------------------------------------------------------------------
function parsePhpAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node, currentClass = null) {
        if (node.type === 'namespace_use_declaration') {
            for (const clause of node.descendantsOfType('namespace_use_clause')) {
                const nameNode = clause.children.find((c) => c.type === 'name' || c.type === 'qualified_name');
                if (nameNode) {
                    const mod = nameNode.text;
                    const candidates = resolveCandidates(file, mod.replace(/\\/g, '/'));
                    imports.push({
                        sourceFile: file,
                        importedPath: mod,
                        resolvedFile: candidates[0],
                        resolvedCandidates: candidates,
                        specifiers: [mod.split('\\').pop() ?? mod],
                    });
                }
            }
            return;
        }
        if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const symId = `${file}:${name}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: node.type === 'class_declaration' ? 'class' : 'interface',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: true,
                });
                // Heritage
                const baseClause = node.children.find((c) => c.type === 'base_clause');
                if (baseClause) {
                    const superName = baseClause.children.find((c) => c.type === 'name' || c.type === 'qualified_name')?.text;
                    if (superName)
                        heritage.push({ subSymbolId: symId, superSymbolName: superName, kind: 'extends' });
                }
                const ifaceClause = node.children.find((c) => c.type === 'class_interface_clause');
                if (ifaceClause) {
                    for (const sub of ifaceClause.children.filter((c) => c.type === 'name' || c.type === 'qualified_name')) {
                        heritage.push({ subSymbolId: symId, superSymbolName: sub.text, kind: 'implements' });
                    }
                }
                const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'declaration_list');
                if (body) {
                    for (const member of body.children) {
                        visit(member, name);
                    }
                }
                return;
            }
        }
        if (node.type === 'method_declaration' || node.type === 'function_definition') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'name');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const isMethod = Boolean(currentClass);
                const qname = isMethod ? `${currentClass}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: isMethod ? 'method' : 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: !node.children.some((c) => c.type === 'visibility_modifier' && c.text === 'private'),
                });
                const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'compound_statement');
                if (body) {
                    collectPhpCalls(file, body, symId, calls);
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child, currentClass);
        }
    }
    visit(root, null);
}
function collectPhpCalls(file, root, callerId, calls) {
    function walk(node) {
        if (node.type === 'member_call_expression' || node.type === 'function_call_expression') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'name');
            if (nameNode) {
                const calleeName = nameNode.text;
                if (!NON_DECLARATION_KEYWORDS.has(calleeName)) {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName: calleeName,
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
// ---------------------------------------------------------------------------
// Kotlin AST Walker
// ---------------------------------------------------------------------------
function parseKotlinAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node, currentClass = null) {
        if (node.type === 'import_header') {
            const id = node.children.find((c) => c.type === 'identifier')?.text;
            if (id) {
                const candidates = resolveCandidates(file, id.replace(/\./g, '/'));
                imports.push({
                    sourceFile: file,
                    importedPath: id,
                    resolvedFile: candidates[0],
                    resolvedCandidates: candidates,
                    specifiers: [id.split('.').pop() ?? id],
                });
            }
            return;
        }
        if (node.type === 'class_declaration' || node.type === 'object_declaration') {
            const nameNode = node.children.find((c) => c.type === 'type_identifier' || c.type === 'simple_identifier');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const qname = currentClass ? `${currentClass}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: 'class',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: true,
                });
                // Heritage
                for (const spec of node.children.filter((c) => c.type === 'delegation_specifier')) {
                    const superId = spec.descendantsOfType('type_identifier')[0]?.text;
                    if (superId) {
                        heritage.push({ subSymbolId: symId, superSymbolName: superId, kind: 'extends' });
                    }
                }
                const body = node.children.find((c) => c.type === 'class_body');
                if (body) {
                    for (const member of body.children) {
                        visit(member, qname);
                    }
                }
                return;
            }
        }
        if (node.type === 'function_declaration') {
            const nameNode = node.children.find((c) => c.type === 'simple_identifier');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const isMethod = Boolean(currentClass);
                const qname = isMethod ? `${currentClass}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: isMethod ? 'method' : 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: true,
                });
                const body = node.children.find((c) => c.type === 'function_body');
                if (body) {
                    collectGenericCalls(file, body, symId, calls);
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child, currentClass);
        }
    }
    visit(root, null);
}
// ---------------------------------------------------------------------------
// Solidity AST Walker
// ---------------------------------------------------------------------------
function parseSolidityAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node, currentContract = null) {
        if (node.type === 'contract_declaration' || node.type === 'interface_declaration') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const symId = `${file}:${name}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: node.type === 'contract_declaration' ? 'class' : 'interface',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: true,
                });
                // Inheritance
                for (const inh of node.descendantsOfType('inheritance_specifier')) {
                    const superName = inh.descendantsOfType('identifier')[0]?.text;
                    if (superName) {
                        heritage.push({ subSymbolId: symId, superSymbolName: superName, kind: 'extends' });
                    }
                }
                const body = node.childForFieldName('body') ?? node;
                for (const child of body.children) {
                    visit(child, name);
                }
                return;
            }
        }
        if (node.type === 'function_definition') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const isMethod = Boolean(currentContract);
                const qname = isMethod ? `${currentContract}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind: isMethod ? 'method' : 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: true,
                });
                const body = node.childForFieldName('body') ?? node.children.find((c) => c.type === 'block_statement');
                if (body) {
                    collectGenericCalls(file, body, symId, calls);
                }
                return;
            }
        }
        for (const child of node.children) {
            visit(child, currentContract);
        }
    }
    visit(root, null);
}
// ---------------------------------------------------------------------------
// Lua AST Walker
// ---------------------------------------------------------------------------
function parseLuaAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node) {
        if (node.type === 'function_declaration' ||
            node.type === 'function_definition_statement' ||
            node.type === 'local_function') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const symId = `${file}:${name}:${startLine}`;
                const signature = lines[startLine - 1]?.trim() ?? `function ${name}`;
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: node.type !== 'local_function',
                });
                collectGenericCalls(file, node, symId, calls);
                return;
            }
        }
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
}
// ---------------------------------------------------------------------------
// Zig AST Walker
// ---------------------------------------------------------------------------
function parseZigAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node) {
        if (node.type === 'fn_declaration' || node.type === 'function_declaration') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const symId = `${file}:${name}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text);
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: 'function',
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: lines[startLine - 1]?.includes('pub ') ?? false,
                });
                collectGenericCalls(file, node, symId, calls);
                return;
            }
        }
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
}
// ---------------------------------------------------------------------------
// Bash AST Walker
// ---------------------------------------------------------------------------
function parseBashAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    function visit(node) {
        if (node.type === 'function_definition') {
            const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'word');
            if (nameNode) {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const symId = `${file}:${name}:${startLine}`;
                const sig = lines[startLine - 1]?.trim() ?? `function ${name}`;
                symbols.push({
                    id: symId,
                    name,
                    qname: name,
                    kind: 'function',
                    file,
                    startLine,
                    endLine,
                    signature: sig,
                    isExported: true,
                });
                collectGenericCalls(file, node, symId, calls);
                return;
            }
        }
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
}
// ---------------------------------------------------------------------------
// Universal Polyglot Tree-Sitter AST Walker (Any Language / Custom Grammars)
// ---------------------------------------------------------------------------
function parseUniversalAst(file, lines, root, symbols, calls, imports, heritage, resolveCandidates) {
    const containerStack = [];
    function visit(node) {
        const t = node.type.toLowerCase();
        // 1. Detect Container or Callable Symbol Declarations
        let kind = null;
        if (t.includes('class') || t.includes('record'))
            kind = 'class';
        else if (t.includes('interface') || t.includes('protocol'))
            kind = 'interface';
        else if (t.includes('trait'))
            kind = 'trait';
        else if (t.includes('struct'))
            kind = 'struct';
        else if (t.includes('enum'))
            kind = 'enum';
        else if (t.includes('module') || t.includes('namespace'))
            kind = 'module';
        else if (t.includes('method') || ((t.includes('func') || t.includes('def') || t.includes('fn')) && containerStack.length > 0)) {
            kind = 'method';
        }
        else if (t.includes('func') || t.includes('def') || t.includes('fn') || t.includes('sub') || t.includes('proc')) {
            kind = 'function';
        }
        const isContainer = ['class', 'interface', 'struct', 'trait', 'module'].includes(kind ?? '');
        const isCallable = ['function', 'method'].includes(kind ?? '');
        if (kind && (isContainer || isCallable)) {
            let name = node.childForFieldName('name')?.text;
            if (!name) {
                const idChild = node.children.find((c) => (c.type.includes('ident') || c.type.includes('name')) &&
                    !['class', 'def', 'func', 'fn', 'function', 'method', 'struct', 'interface'].includes(c.text));
                if (idChild)
                    name = idChild.text;
            }
            if (name && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) && !NON_DECLARATION_KEYWORDS.has(name)) {
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;
                const parentContainer = containerStack[containerStack.length - 1];
                const qname = parentContainer ? `${parentContainer}.${name}` : name;
                const symId = `${file}:${qname}:${startLine}`;
                const header = gatherHeader(lines, startLine - 1);
                const signature = signatureFrom(header.text) || (lines[startLine - 1]?.trim() ?? name);
                symbols.push({
                    id: symId,
                    name,
                    qname,
                    kind,
                    file,
                    startLine,
                    endLine,
                    signature,
                    isExported: true,
                });
                // Heritage check inside container
                if (isContainer) {
                    for (const c of node.children) {
                        const ct = c.type.toLowerCase();
                        if (ct.includes('extend') || ct.includes('implement') || ct.includes('super') || ct.includes('base') || ct.includes('inherit')) {
                            for (const sub of c.children) {
                                if (sub.type.includes('ident') && sub.text !== name) {
                                    heritage.push({
                                        subSymbolId: symId,
                                        superSymbolName: sub.text,
                                        kind: ct.includes('implement') ? 'implements' : 'extends',
                                    });
                                }
                            }
                        }
                    }
                    containerStack.push(name);
                    for (const child of node.children)
                        visit(child);
                    containerStack.pop();
                    return;
                }
                if (isCallable) {
                    collectGenericCalls(file, node, symId, calls);
                    return;
                }
            }
        }
        // 2. Import detection
        if (t.includes('import') || t.includes('require') || t.includes('include') || t.includes('use_')) {
            const pathNode = node.childForFieldName('path') ??
                node.childForFieldName('source') ??
                node.children.find((c) => c.type.includes('string') || c.type.includes('path') || c.type.includes('ident'));
            if (pathNode) {
                const rawPath = pathNode.text.replace(/^['"<]|['">]$/g, '');
                if (rawPath) {
                    const candidates = resolveCandidates(file, rawPath);
                    imports.push({
                        sourceFile: file,
                        importedPath: rawPath,
                        resolvedFile: candidates[0],
                        resolvedCandidates: candidates,
                        specifiers: [rawPath.split(/[/.\\]/).pop() ?? rawPath],
                    });
                }
            }
            return;
        }
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
}
function collectGenericCalls(file, root, callerId, calls) {
    function walk(node) {
        const t = node.type.toLowerCase();
        if (t.includes('call') || t.includes('invocation')) {
            const fnNode = node.childForFieldName('function') ??
                node.childForFieldName('method') ??
                node.childForFieldName('callee') ??
                node.children.find((c) => c.type.includes('ident') || c.type.includes('expr'));
            if (fnNode) {
                let calleeName = fnNode.text.replace(/\(.*$/, '').trim();
                if (calleeName.includes('.'))
                    calleeName = calleeName.split('.').pop() ?? calleeName;
                if (calleeName.includes('::'))
                    calleeName = calleeName.split('::').pop() ?? calleeName;
                if (calleeName.includes('->'))
                    calleeName = calleeName.split('->').pop() ?? calleeName;
                if (calleeName && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(calleeName) && !NON_DECLARATION_KEYWORDS.has(calleeName)) {
                    calls.push({
                        callerId,
                        calleeName,
                        calleeQName: fnNode.text.replace(/\(.*$/, '').trim(),
                        file,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
        for (const child of node.children) {
            walk(child);
        }
    }
    walk(root);
}
