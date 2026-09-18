import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext, JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import { KnowCodeConfig, resolveConfig, type KnowCodeConfig as KnowCodeConfigShape } from './config.js';
import { KNOWCODE_SYSTEM_PROMPT } from './prompt.js';
import { knowCodeToolSpecs } from './tools/tool-specs.js';
import { executeKnowCodeTool, type ExecutionResult } from './tools/dispatcher.js';
import { stopOwnedDaemons } from './server/auto-start.js';
import type { TextContentBlock } from './tools/json-schema.js';
import { asToolParameters } from './tools/json-schema.js';

/**
 * Canonical result schema for every KnowCode tool.
 *
 * Declared as standard JSON Schema. The registry asserts this at registration
 * time (`assertSupportedJsonSchema`), which rejects `defineTool` author
 * shorthand such as `required: true` inside a property — `required` must be an
 * object-level array of property names.
 */
export const KNOWCODE_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'knowcode' },
    action: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['kind', 'action', 'content'],
};

export const name = 'knowcode';
export const inject = ['tools', 'systemPrompt'];
export const Config = KnowCodeConfig;

/** Render the model-facing text for a completed KnowCode call. */
function renderResult(_args: unknown, value: any): TextContentBlock[] {
  return [{ type: 'text', text: value?.content ?? '' }];
}

/** Extract the first text block of a harness tool result, tolerating absence. */
function firstText(result: any): string {
  const block = result?.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}

export function apply(ctx: Context, rawConfig: KnowCodeConfigShape): void {
  const config = resolveConfig(rawConfig);

  // Register each tool in the catalog (including backward-compatible aliases).
  //
  // The definition is a plain object built with ZERO runtime harness imports:
  // the contract with the host is exactly the object passed to
  // `tools.register()`. Every `@deepseek-ai` reference above is `import type`,
  // so `tsc` erases it from the published output.
  //
  // This is defense-in-depth, NOT the fix for "Cannot read properties of
  // undefined (reading 'prepare')". That crash is a HARNESS defect — its
  // TOOL_RUNTIME_SCHEDULER uses a private `Symbol()` instead of `Symbol.for()`,
  // so two evaluated copies of @deepseek-ai/dsh-tools yield two different keys —
  // and it reproduces on a profile with zero plugins installed. Staying
  // dependency-free only guarantees this plugin never contributes an extra copy.
  for (const spec of knowCodeToolSpecs) {
    const registerOne = (toolName: string) => {
      ctx.tools.register({
        name: toolName,
        description: spec.description,
        // Standard JSON Schema, sent verbatim to the model provider.
        parameters: asToolParameters(spec.parameters),
        output: {
          schema: KNOWCODE_OUTPUT_SCHEMA,
          render: renderResult,
          presentationMeta: (_args: unknown, value: any) => ({
            action: value?.action ?? toolName,
          }),
        },
        execute: async (args: any, runCtx: ToolRunContext) => {
          const sessionCwd = runCtx.agent?.session.header.cwd ?? process.cwd();
          return await executeKnowCodeTool(spec.action, args, sessionCwd, config.daemonPort, {
            autoStartDaemon: config.autoStartDaemon,
            maxFileSize: config.maxFileSize,
          });
        },
        // `TerminalCallView` accepts only { card, title, description?, cwd? }.
        presentCall: () => ({
          card: 'terminal' as const,
          title: toolName,
          description: `[KnowCode] ${spec.action} — querying the embedded FalkorDB code graph`,
        }),
        presentResult: (_args: unknown, result: any) => ({
          card: 'terminal' as const,
          output: firstText(result),
        }),
      });
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

  // Stop the daemons this process spawned when the plugin is disposed.
  //
  // A daemon is spawned detached so it survives the tool call that needed it —
  // which also means nothing else would ever stop it. Quitting the harness used
  // to leave one running per project, each holding an embedded FalkorDB process,
  // an HTTP server, a file watcher and a database file.
  //
  // DeepSeek Harness disposes the host fiber from its SIGINT/SIGTERM handler
  // (`runProfile` in apps/cli), so this runs on Ctrl+C and on SIGTERM. A SIGKILL
  // skips disposal and is the one case that still orphans a daemon.
  //
  // Only daemons recorded as ours are stopped: a server the user started by hand
  // with `knowcode serve .`, or another harness's, is left untouched.
  ctx.effect(() => () => {
    if (!config.stopDaemonOnExit) return;
    const stopped = stopOwnedDaemons();
    if (stopped.length > 0) {
      console.log(`[KnowCode] Stopped ${stopped.length} workspace daemon(s) on shutdown.`);
    }
  }, 'knowcode: stop owned daemons');
}
