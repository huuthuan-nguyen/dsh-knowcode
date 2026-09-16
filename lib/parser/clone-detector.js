import { createHash } from 'node:crypto';
/**
 * Normalizes a code snippet by anonymizing variable and parameter identifiers
 * while preserving control flow structure, operators, literals, and external callees.
 */
export function normalizeFunctionBody(code) {
    // 1. Remove comments
    const cleanCode = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '')
        .trim();
    // 2. Tokenize based on common programming language syntax
    const tokenRegex = /(?:[0-9]+(?:\.[0-9]+)?)|(?:'[^']*'|"[^"]*"|`[^`]*`)|(?:[a-zA-Z_$][a-zA-Z0-9_$]*)|(?:===|!==|==|!=|<=|>=|=>|\+\+|--|\+=|-=|\*=|&&|\|\||[{}()[\].,;:?+\-*/%&|^~=<>!])/g;
    const rawTokens = cleanCode.match(tokenRegex) ?? [];
    // Keywords that should NOT be anonymized
    const preservedKeywords = new Set([
        'if', 'else', 'while', 'for', 'do', 'return', 'throw', 'throws', 'try', 'catch', 'finally',
        'switch', 'case', 'default', 'break', 'continue', 'await', 'async', 'yield', 'let', 'const',
        'var', 'function', 'class', 'struct', 'interface', 'new', 'this', 'self', 'super', 'null',
        'undefined', 'true', 'false', 'nil', 'none', 'import', 'export', 'pub', 'fn', 'mut', 'impl',
        'match', 'type', 'enum', 'void', 'int', 'string', 'bool', 'boolean', 'float', 'double', 'char'
    ]);
    const varMap = {};
    let nextVarId = 1;
    const normalizedTokens = [];
    for (let i = 0; i < rawTokens.length; i++) {
        const token = rawTokens[i];
        // Numbers -> 0
        if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) {
            normalizedTokens.push('0');
            continue;
        }
        // String literals -> ""
        if (/^['"`]/.test(token)) {
            normalizedTokens.push('""');
            continue;
        }
        // Preserved keywords and operators
        if (preservedKeywords.has(token) || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(token)) {
            normalizedTokens.push(token);
            continue;
        }
        // Check if it's a function declaration name: function foo() -> normalize to $fn
        const prevToken = i > 0 ? rawTokens[i - 1] : null;
        const nextToken = i + 1 < rawTokens.length ? rawTokens[i + 1] : null;
        if (prevToken === 'function' || prevToken === 'fn' || prevToken === 'func' || prevToken === 'def') {
            normalizedTokens.push('$fn');
            continue;
        }
        if (prevToken === '.' || nextToken === '(') {
            // Keep function or property call name to retain semantic callee structure
            normalizedTokens.push(token);
            continue;
        }
        // Local variable or parameter identifier -> map to $v1, $v2, ...
        if (!varMap[token]) {
            varMap[token] = `$v${nextVarId++}`;
        }
        normalizedTokens.push(varMap[token]);
    }
    const normalized = normalizedTokens.join(' ');
    const structuralHash = createHash('sha256').update(normalized).digest('hex').substring(0, 16);
    return {
        normalized,
        structuralHash,
        variableMap: varMap,
    };
}
/**
 * Calculates Dice similarity coefficient between two tokenized string bodies (0.0 to 1.0)
 */
export function calculateDiceSimilarity(a, b) {
    if (a === b)
        return 1.0;
    if (!a || !b)
        return 0.0;
    const getBigrams = (str) => {
        const map = new Map();
        const tokens = str.split(' ');
        for (let i = 0; i < tokens.length - 1; i++) {
            const bigram = `${tokens[i]} ${tokens[i + 1]}`;
            map.set(bigram, (map.get(bigram) ?? 0) + 1);
        }
        return map;
    };
    const bgA = getBigrams(a);
    const bgB = getBigrams(b);
    let intersection = 0;
    for (const [bigram, countA] of bgA.entries()) {
        if (bgB.has(bigram)) {
            intersection += Math.min(countA, bgB.get(bigram));
        }
    }
    const total = Array.from(bgA.values()).reduce((sum, v) => sum + v, 0) +
        Array.from(bgB.values()).reduce((sum, v) => sum + v, 0);
    return total === 0 ? 0.0 : (2.0 * intersection) / total;
}
