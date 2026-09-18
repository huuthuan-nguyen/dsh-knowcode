import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { apply, Config, KNOWCODE_OUTPUT_SCHEMA, name } from '../lib/index.js';
import { knowCodeToolSpecs } from '../lib/tools/tool-specs.js';
import { resolveConfig } from '../lib/config.js';

const ROOT = resolve(import.meta.dirname, '..');

/** Drive the real `apply()` with a mock Cordis context and capture registrations. */
function registerAll(): { tools: any[]; sections: any[] } {
  const tools: any[] = [];
  const sections: any[] = [];
  const ctx = {
    tools: {
      register: (tool: any) => {
        tools.push(tool);
        return () => {};
      },
    },
    systemPrompt: {
      section: (section: any) => {
        sections.push(section);
      },
    },
    // `apply` registers a disposal effect; the mock only needs to accept it.
    effect: () => () => {},
  } as any;

  apply(ctx, {});
  return { tools, sections };
}

/** Visit every nested schema object reachable from `node`. */
function walk(node: any, visit: (node: any, path: string) => void, path = ''): void {
  if (node === null || typeof node !== 'object') return;
  visit(node, path);
  if (node.properties) {
    for (const [key, child] of Object.entries<any>(node.properties)) {
      walk(child, visit, `${path}.properties.${key}`);
    }
  }
  if (node.items) walk(node.items, visit, `${path}.items`);
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((child: any, i: number) => walk(child, visit, `${path}.oneOf[${i}]`));
  }
}

/** Every compiled `.js` file under a directory (recursive). */
function listJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema contract
// ---------------------------------------------------------------------------

test('every registered tool declares an object-rooted JSON Schema for parameters', () => {
  const { tools } = registerAll();

  assert.ok(tools.length >= knowCodeToolSpecs.length, 'every spec (and alias) must register');
  for (const tool of tools) {
    assert.strictEqual(typeof tool.name, 'string', 'tool.name');
    assert.strictEqual(typeof tool.description, 'string', `${tool.name}.description`);
    assert.strictEqual(tool.parameters?.type, 'object', `${tool.name}.parameters.type must be "object"`);
    assert.ok(
      tool.parameters.properties !== undefined && typeof tool.parameters.properties === 'object',
      `${tool.name}.parameters.properties must be an object map`
    );
    assert.strictEqual(typeof tool.execute, 'function', `${tool.name}.execute`);
    assert.strictEqual(typeof tool.output?.render, 'function', `${tool.name}.output.render`);
    assert.ok(tool.output?.schema, `${tool.name}.output.schema`);
  }

  // The output schema itself is object-rooted with a real required array.
  assert.strictEqual(KNOWCODE_OUTPUT_SCHEMA.type, 'object');
  assert.deepStrictEqual(KNOWCODE_OUTPUT_SCHEMA.required, ['kind', 'action', 'content']);
});

test('no schema uses defineTool shorthand `required: true`', () => {
  const { tools } = registerAll();

  for (const tool of tools) {
    const surfaces: Array<[string, any]> = [
      ['parameters', tool.parameters],
      ['output.schema', tool.output.schema],
    ];

    for (const [label, schema] of surfaces) {
      walk(schema, (node, path) => {
        if (node.required !== undefined) {
          assert.ok(
            Array.isArray(node.required),
            `${tool.name} ${label}${path}.required must be an array, never a boolean`
          );
          for (const requiredName of node.required) {
            assert.strictEqual(
              typeof requiredName,
              'string',
              `${tool.name} ${label}${path}.required entries must be strings`
            );
            assert.ok(
              node.properties !== undefined && Object.hasOwn(node.properties, requiredName),
              `${tool.name} ${label}${path}.required names unknown property "${requiredName}"`
            );
          }
        }

        if (node.properties !== undefined) {
          for (const [propName, child] of Object.entries<any>(node.properties)) {
            assert.strictEqual(
              child?.required,
              undefined,
              `${tool.name} ${label}${path}.properties.${propName} must not carry a boolean \`required\``
            );
          }
        }
      });
    }
  }
});

test('the harness JSON Schema validator accepts every registered schema', async () => {
  let assertSupportedJsonSchema: ((schema: unknown) => void) | undefined;
  try {
    const harness: any = await import('@deepseek-ai/dsh-tools');
    assertSupportedJsonSchema = harness.assertSupportedJsonSchema;
  } catch {
    // Harness not linked (e.g. CI without the monorepo); the structural checks above still ran.
    return;
  }
  if (typeof assertSupportedJsonSchema !== 'function') return;

  const { tools } = registerAll();
  for (const tool of tools) {
    assert.doesNotThrow(
      () => assertSupportedJsonSchema!(tool.parameters),
      `${tool.name}.parameters must pass the harness validator`
    );
    assert.doesNotThrow(
      () => assertSupportedJsonSchema!(tool.output.schema),
      `${tool.name}.output.schema must pass the harness validator`
    );
  }
});

// ---------------------------------------------------------------------------
// Contract guards: no runtime harness imports, and the DSH "reading 'prepare'"
// crash is a harness defect that a plugin cannot fix by changing its own source.
// ---------------------------------------------------------------------------

test('compiled output contains zero runtime @deepseek-ai imports', () => {
  const files = listJs(join(ROOT, 'lib'));
  assert.ok(files.length > 0, 'expected compiled output under lib/');

  // Match actual import/require statements only — prose in comments is fine.
  const runtimeImport = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\//;
  const offenders = files.filter((file) => runtimeImport.test(readFileSync(file, 'utf8')));

  assert.deepStrictEqual(
    offenders,
    [],
    'A plugin must not load harness internals at runtime: the contract with the host is ' +
      'exactly the object passed to tools.register(), and a runtime import can add another ' +
      'evaluated copy of a package the host already owns. Keep harness usage to `import type` ' +
      'only. (Defense-in-depth — the harness\'s own "undefined (reading \'prepare\')" defect is ' +
      'separate and reproduces with zero plugins installed.)'
  );
});

test('plugin module exports stay free of runtime harness bindings', () => {
  const source = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  // Only local relative imports may appear at module scope.
  const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));
  assert.ok(importLines.length > 0, 'expected import statements');
  for (const line of importLines) {
    assert.match(
      line,
      /from\s+'\.\.?\//,
      `only relative imports are allowed in lib/index.js, found: ${line.trim()}`
    );
  }
});

// ---------------------------------------------------------------------------
// Presenters (hardened against undefined, valid view shapes)
// ---------------------------------------------------------------------------

test('render and presentResult tolerate undefined values', () => {
  const { tools } = registerAll();
  const tool = tools[0];

  assert.doesNotThrow(() => tool.output.render(undefined, undefined));
  assert.doesNotThrow(() => tool.output.render(undefined, null));
  assert.doesNotThrow(() => tool.presentResult(undefined, undefined));

  assert.deepStrictEqual(tool.output.render(undefined, undefined), [{ type: 'text', text: '' }]);
  assert.deepStrictEqual(tool.output.render(undefined, { kind: 'knowcode', action: 'x', content: 'hello' }), [
    { type: 'text', text: 'hello' },
  ]);

  const view = tool.presentResult(undefined, { content: [{ type: 'text', text: 'body' }] });
  assert.strictEqual(view.card, 'terminal');
  assert.strictEqual(view.output, 'body');

  // presentationMeta must not throw on a missing value either.
  assert.doesNotThrow(() => tool.output.presentationMeta(undefined, undefined));
});

test('presentCall emits only valid TerminalCallView fields', () => {
  const { tools } = registerAll();
  const view = tools[0].presentCall({});

  // TerminalCallView: { card, title, description?, cwd? } — `output` is NOT a member.
  assert.deepStrictEqual(Object.keys(view).sort(), ['card', 'description', 'title']);
  assert.strictEqual(view.card, 'terminal');
  assert.strictEqual(typeof view.title, 'string');
  assert.strictEqual((view as any).output, undefined);
});

// ---------------------------------------------------------------------------
// Config (hand-written Standard Schema, no schemastery)
// ---------------------------------------------------------------------------

test('Config validates through Standard Schema v1 with defaults', () => {
  const standard = (Config as any)['~standard'];
  assert.strictEqual(standard.version, 1);
  assert.strictEqual(standard.vendor, 'dsh-knowcode');

  assert.deepStrictEqual(standard.validate({}).value, {
    falkordbUrl: '',
    daemonPort: 48123,
    dataDir: '.knowcode',
    maxFileSize: 1048576,
    blastRadiusMaxDepth: 3,
    autoStartDaemon: true,
    stopDaemonOnExit: true,
    idleTimeoutMs: 0,
  });

  // Missing / non-object input still yields defaults.
  assert.deepStrictEqual(standard.validate(undefined).value, resolveConfig(undefined));
  assert.deepStrictEqual(standard.validate(null).value, resolveConfig(null));
});

test('Config coerces invalid values and preserves explicit ones', () => {
  const standard = (Config as any)['~standard'];

  const bad = standard.validate({
    daemonPort: 'not-a-port',
    maxFileSize: -5,
    dataDir: '',
    blastRadiusMaxDepth: 0,
  }).value;
  assert.strictEqual(bad.daemonPort, 48123);
  assert.strictEqual(bad.maxFileSize, 1048576);
  assert.strictEqual(bad.dataDir, '.knowcode');
  assert.strictEqual(bad.blastRadiusMaxDepth, 3);

  const good = standard.validate({
    daemonPort: 49000,
    dataDir: 'custom-dir',
    maxFileSize: 2048,
    blastRadiusMaxDepth: 5,
    autoStartDaemon: false,
    stopDaemonOnExit: false,
    idleTimeoutMinutes: 5,
    falkordbUrl: 'redis://127.0.0.1:6379',
  }).value;
  assert.deepStrictEqual(good, {
    daemonPort: 49000,
    dataDir: 'custom-dir',
    maxFileSize: 2048,
    blastRadiusMaxDepth: 5,
    autoStartDaemon: false,
    stopDaemonOnExit: false,
    idleTimeoutMs: 300_000,
    falkordbUrl: 'redis://127.0.0.1:6379',
  });

  // `autoStartDaemon: false` is meaningful and must survive.
  assert.strictEqual(standard.validate({ autoStartDaemon: false }).value.autoStartDaemon, false);
  // `stopDaemonOnExit: false` must be distinguishable from its default.
  assert.strictEqual(standard.validate({ stopDaemonOnExit: false }).value.stopDaemonOnExit, false);
  assert.strictEqual(standard.validate({}).value.stopDaemonOnExit, true);

  // An idle budget is minutes in config, milliseconds in the resolved shape, and
  // anything invalid or non-positive means "disabled" rather than a surprise timer.
  assert.strictEqual(standard.validate({}).value.idleTimeoutMs, 0, 'idle timeout is off by default');
  assert.strictEqual(standard.validate({ idleTimeoutMinutes: 5 }).value.idleTimeoutMs, 300_000);
  assert.strictEqual(standard.validate({ idleTimeoutMinutes: -3 }).value.idleTimeoutMs, 0);
  assert.strictEqual(standard.validate({ idleTimeoutMinutes: 'soon' }).value.idleTimeoutMs, 0);
  assert.strictEqual(standard.validate({ autoStartDaemon: true }).value.autoStartDaemon, true);
  assert.strictEqual(standard.validate({}).value.autoStartDaemon, true);
});
