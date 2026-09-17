/**
 * Schema types for KnowCode tool definitions.
 *
 * These are **type-only** re-exports of the harness contract, so `tsc` erases
 * them completely: the published compiled output contains no runtime import of
 * any `@deepseek-ai` package. A plugin should not load harness internals at
 * runtime — the contract with the host is exactly the object passed to
 * `tools.register()`, and a runtime import can add yet another evaluated copy of
 * a package the host already owns.
 *
 * Reusing the harness's own types (rather than hand-rolled ones) keeps the tool
 * definitions provably assignable to `ToolDefinition` at compile time while
 * shipping zero runtime dependency.
 *
 * Note this is defense-in-depth, not the remedy for the harness's
 * "Cannot read properties of undefined (reading 'prepare')" defect: that crash
 * comes from the harness keying its scheduler on a private `Symbol()` instead of
 * `Symbol.for()`, and it reproduces with zero plugins installed.
 */
import type { JsonSchemaNode, ParameterJsonSchema } from '@deepseek-ai/dsh-tools';
export type { JsonSchemaNode, ParameterJsonSchema };
/**
 * The schema a tool declares for its arguments: a JSON Schema object root with
 * an explicit `properties` map. `required` is always an object-level array of
 * property names — never `defineTool`'s author shorthand `required: true`.
 */
export type JsonSchemaObject = ParameterJsonSchema;
/**
 * Declare a parameter object.
 *
 * Builds a fresh plain object on every call so tool definitions can never share
 * mutable schema state.
 */
export declare function objectSchema(properties: Record<string, JsonSchemaNode>, required?: string[]): ParameterJsonSchema;
/** A no-argument tool: an explicit empty object schema. */
export declare function emptySchema(): ParameterJsonSchema;
/**
 * Present a strongly-typed schema as the loose `ToolDefinition['parameters']`
 * record the registry accepts.
 *
 * `ToolDefinition` types `parameters` as `Record<string, unknown>` (a plain
 * object carries its schema verbatim), and a typed schema interface has no index
 * signature, so one cast is unavoidable at the boundary. `defineTool` performs
 * the identical cast internally; building the definition by hand just makes it
 * explicit and keeps a single, commented crossing point.
 */
export declare function asToolParameters(schema: ParameterJsonSchema): Record<string, unknown>;
/** Minimal shape of the content blocks our renderers return. */
export type TextContentBlock = {
    readonly type: 'text';
    readonly text: string;
};
