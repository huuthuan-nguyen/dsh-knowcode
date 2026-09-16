import type { Context } from '@deepseek-ai/cordis';
import { KnowCodeConfig } from './config.js';
export declare const name = "knowcode";
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").default<KnowCodeConfig>;
export declare const KNOWCODE_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly kind: {
            readonly type: "string";
            readonly const: "knowcode";
            readonly required: true;
        };
        readonly action: {
            readonly type: "string";
            readonly required: true;
        };
        readonly content: {
            readonly type: "string";
            readonly required: true;
        };
    };
};
export declare function apply(ctx: Context, rawConfig: KnowCodeConfig): void;
