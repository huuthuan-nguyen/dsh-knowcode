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
export interface DispatchOptions {
    /**
     * Start a daemon for the workspace when none is running.
     *
     * Off by default so callers (tests, the CLI) stay predictable; the plugin
     * enables it from the `autoStartDaemon` config option.
     */
    autoStartDaemon?: boolean;
    /** How long to wait for an auto-started daemon to answer before giving up. */
    autoStartTimeoutMs?: number;
    /** How long to wait for its initial index to settle before answering anyway. */
    indexTimeoutMs?: number;
    /** Largest file an auto-started daemon may read and index, in bytes. */
    maxFileSize?: number;
    /** Stop an auto-started daemon after this many idle milliseconds (0 disables). */
    idleTimeoutMs?: number;
}
/**
 * Run a tool and, when this call is the one that started the workspace daemon, prefix
 * the result with a note saying so.
 *
 * Building an index is why the first call in a workspace is slower, and the agent has
 * no other way to learn that — nor whether the counts it is about to read are
 * complete. The note is attached to that single call only.
 */
export declare function executeKnowCodeTool(rawAction: string, args: any, workdir: string, daemonPort?: number, options?: DispatchOptions): Promise<ExecutionResult>;
