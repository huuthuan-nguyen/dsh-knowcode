/**
 * Declare a parameter object.
 *
 * Builds a fresh plain object on every call so tool definitions can never share
 * mutable schema state.
 */
export function objectSchema(properties, required = []) {
    return required.length > 0
        ? { type: 'object', properties, required }
        : { type: 'object', properties };
}
/** A no-argument tool: an explicit empty object schema. */
export function emptySchema() {
    return { type: 'object', properties: {} };
}
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
export function asToolParameters(schema) {
    return schema;
}
