/**
 * Normalizes a code snippet by anonymizing variable and parameter identifiers
 * while preserving control flow structure, operators, literals, and external callees.
 */
export declare function normalizeFunctionBody(code: string): {
    normalized: string;
    structuralHash: string;
    variableMap: Record<string, string>;
};
/**
 * Calculates Dice similarity coefficient between two tokenized string bodies (0.0 to 1.0)
 */
export declare function calculateDiceSimilarity(a: string, b: string): number;
