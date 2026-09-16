import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';
export interface KnowCodeToolSpec {
    readonly name: string;
    readonly description: string;
    readonly parameters: ParameterSchemaSpec;
    readonly action: string;
    readonly aliases?: readonly string[];
}
export declare const knowCodeToolSpecs: readonly KnowCodeToolSpec[];
