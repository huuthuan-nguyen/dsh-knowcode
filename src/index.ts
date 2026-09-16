import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { KnowCodeConfig, resolveConfig, type ResolvedKnowCodeConfig } from './config.js';
import { KNOWCODE_SYSTEM_PROMPT } from './prompt.js';
import { knowCodeToolSpecs } from './tools/tool-specs.js';
import { executeKnowCodeTool, type ExecutionResult } from './tools/dispatcher.js';

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
} as const;

export function apply(ctx: Context, rawConfig: KnowCodeConfig): void {
  const config: ResolvedKnowCodeConfig = resolveConfig(rawConfig);

  // Register each tool in the catalog (including backward-compatible aliases)
  for (const spec of knowCodeToolSpecs) {
    const registerOne = (toolName: string) => {
      ctx.tools.register(
        defineTool({
          name: toolName,
          description: spec.description,
          parameters: spec.parameters,
          output: {
            schema: KNOWCODE_OUTPUT_SCHEMA,
            render: (_args, value: ExecutionResult) => [{ type: 'text', text: value.content }],
            presentationMeta: (_args, value: ExecutionResult) => ({
              action: value.action,
            }),
          },
          execute: async (args: any, runCtx: ToolRunContext) => {
            const sessionCwd = runCtx.agent?.session.header.cwd ?? process.cwd();
            return await executeKnowCodeTool(spec.action, args, sessionCwd, config.daemonPort);
          },
          presentCall: (_args: any) => ({
            card: 'terminal',
            title: toolName,
            output: `[KnowCode] Running ${toolName}...`,
          }),
          presentResult: (_args: any, result: any) => {
            const block = result.content?.[0];
            const text = block && block.type === 'text' ? block.text : '';
            return { card: 'terminal', output: text };
          },
        })
      );
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
