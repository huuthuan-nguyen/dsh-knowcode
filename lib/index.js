import { defineTool } from '@deepseek-ai/dsh-tools';
import { KnowCodeConfig, resolveConfig } from './config.js';
import { KNOWCODE_SYSTEM_PROMPT } from './prompt.js';
import { knowCodeToolSpecs } from './tools/tool-specs.js';
import { executeKnowCodeTool } from './tools/dispatcher.js';
export const name = 'knowcode';
export const inject = ['tools', 'systemPrompt'];
export const Config = KnowCodeConfig;
export const KNOWCODE_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        kind: { type: 'string', const: 'knowcode', required: true },
        action: { type: 'string', required: true },
        content: { type: 'string', required: true },
    },
};
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    // Register each tool in the catalog (including backward-compatible aliases)
    for (const spec of knowCodeToolSpecs) {
        const registerOne = (toolName) => {
            ctx.tools.register(defineTool({
                name: toolName,
                description: spec.description,
                parameters: spec.parameters,
                output: {
                    schema: KNOWCODE_OUTPUT_SCHEMA,
                    render: (_args, value) => [{ type: 'text', text: value.content }],
                    presentationMeta: (_args, value) => ({
                        action: value.action,
                    }),
                },
                execute: async (args, runCtx) => {
                    const sessionCwd = runCtx.agent?.session.header.cwd ?? process.cwd();
                    return await executeKnowCodeTool(spec.action, args, sessionCwd, config.daemonPort);
                },
                presentCall: (_args) => ({
                    card: 'terminal',
                    title: toolName,
                    output: `[KnowCode] Running ${toolName}...`,
                }),
                presentResult: (_args, result) => {
                    const block = result.content?.[0];
                    const text = block && block.type === 'text' ? block.text : '';
                    return { card: 'terminal', output: text };
                },
            }));
        };
        registerOne(spec.name);
        if (spec.aliases) {
            for (const alias of spec.aliases) {
                if (alias !== spec.name) {
                    registerOne(alias);
                }
            }
        }
    }
    // Inject system prompt rules
    ctx.systemPrompt.section({
        name: 'tool:knowcode',
        order: 115,
        text: KNOWCODE_SYSTEM_PROMPT,
    });
}
