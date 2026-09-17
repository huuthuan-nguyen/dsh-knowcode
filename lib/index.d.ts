import type { Context } from '@deepseek-ai/cordis';
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import { type KnowCodeConfig as KnowCodeConfigShape } from './config.js';
/**
 * Canonical result schema for every KnowCode tool.
 *
 * Declared as standard JSON Schema. The registry asserts this at registration
 * time (`assertSupportedJsonSchema`), which rejects `defineTool` author
 * shorthand such as `required: true` inside a property — `required` must be an
 * object-level array of property names.
 */
export declare const KNOWCODE_OUTPUT_SCHEMA: JsonSchemaNode;
export declare const name = "knowcode";
export declare const inject: string[];
export declare const Config: {
    '~standard': {
        version: 1;
        vendor: string;
        validate(value: unknown): {
            value: import("./config.js").ResolvedKnowCodeConfig;
        };
    };
};
export declare function apply(ctx: Context, rawConfig: KnowCodeConfigShape): void;
