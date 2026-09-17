/**
 * The value every KnowCode tool returns.
 *
 * These three fields are exactly the properties declared by
 * `KNOWCODE_OUTPUT_SCHEMA` (which sets `additionalProperties: false`), because
 * the harness validates this object against that schema before rendering and
 * throws `ToolOutputError` on any undeclared key. Adding a field here without
 * adding it to the schema breaks every tool call at runtime, so
 * `tests/tool-output-contract.test.ts` pins the two together.
 */
export interface ExecutionResult {
    kind: 'knowcode';
    action: string;
    content: string;
}
export declare function executeKnowCodeTool(rawAction: string, args: any, workdir: string, daemonPort?: number): Promise<ExecutionResult>;
