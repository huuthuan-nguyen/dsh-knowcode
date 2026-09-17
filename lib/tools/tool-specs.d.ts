import { type JsonSchemaObject } from './json-schema.js';
export interface KnowCodeToolSpec {
    readonly name: string;
    readonly description: string;
    /** Standard JSON Schema (object-rooted). Sent verbatim to the model provider. */
    readonly parameters: JsonSchemaObject;
    readonly action: string;
    readonly aliases?: readonly string[];
}
export declare const knowCodeToolSpecs: readonly KnowCodeToolSpec[];
