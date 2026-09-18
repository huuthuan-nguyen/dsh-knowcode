import test from 'node:test';
import assert from 'node:assert';
import { Context } from '@deepseek-ai/cordis';
import { apply, name } from '../lib/index.js';
import { knowCodeToolSpecs } from '../lib/tools/tool-specs.js';
import { KNOWCODE_SYSTEM_PROMPT } from '../lib/prompt.js';

test('Cordis plugin registration and tools verification', () => {
  assert.strictEqual(name, 'knowcode');

  const registeredTools: any[] = [];
  let registeredPrompt: any = null;
  const disposers: Array<() => void> = [];

  // Mock Cordis Context services
  const ctx = {
    tools: {
      register: (tool: any) => {
        registeredTools.push(tool);
      },
    },
    systemPrompt: {
      section: (section: any) => {
        registeredPrompt = section;
      },
    },
    // `apply` registers a disposal effect that stops daemons this process spawned.
    effect: (execute: () => () => void) => {
      disposers.push(execute());
      return () => {};
    },
  } as unknown as Context;

  apply(ctx, {});

  const toolNames = registeredTools.map((t) => t.name);

  // Verify all 25 primary LLM-optimized tools are registered
  assert.strictEqual(knowCodeToolSpecs.length, 25);
  for (const spec of knowCodeToolSpecs) {
    assert.ok(toolNames.includes(spec.name), `Tool ${spec.name} must be registered`);
  }

  // Verify specific new LLM names
  assert.ok(toolNames.includes('code_get_architecture_overview'));
  assert.ok(toolNames.includes('code_get_symbol_definition_and_signature'));
  assert.ok(toolNames.includes('code_analyze_refactor_blast_radius'));
  assert.ok(toolNames.includes('code_find_function_callers'));
  assert.ok(toolNames.includes('code_find_function_callees'));
  assert.ok(toolNames.includes('code_detect_circular_dependencies'));
  assert.ok(toolNames.includes('code_find_affected_test_files'));
  assert.ok(toolNames.includes('code_extract_symbol_porting_contract'));
  assert.ok(toolNames.includes('knowledge_search_documentation_and_rules'));
  assert.ok(toolNames.includes('knowledge_get_document_content_and_rules'));
  assert.ok(toolNames.includes('knowcode_check_index_health_and_stats'));
  assert.ok(toolNames.includes('knowcode_trigger_incremental_reindex'));
  assert.ok(toolNames.includes('knowcode_execute_custom_cypher_query'));

  // Verify call path, subtype, symbol search, dead code, and git diff tools
  assert.ok(toolNames.includes('code_find_call_path_between_symbols'));
  assert.ok(toolNames.includes('code_find_implementations_and_subtypes'));
  assert.ok(toolNames.includes('code_search_symbols_by_pattern'));
  assert.ok(toolNames.includes('code_find_unused_dead_symbols'));
  assert.ok(toolNames.includes('code_analyze_git_diff_semantic_impact'));

  // Verify cross-paradigm porting, 3rd-party slice, and clone detection tools
  assert.ok(toolNames.includes('code_generate_cross_paradigm_porting_blueprint'));
  assert.ok(toolNames.includes('code_extract_third_party_usage_slice'));
  assert.ok(toolNames.includes('code_find_similar_duplicate_functions'));

  // Verify bidirectional spec-to-code traceability tools
  assert.ok(toolNames.includes('spec_find_code_flow_for_feature'));
  assert.ok(toolNames.includes('code_find_spec_features_for_symbol'));

  // Verify polyglot contract-to-storage tools
  assert.ok(toolNames.includes('schema_map_contract_to_storage'));
  assert.ok(toolNames.includes('schema_analyze_storage_migration_impact'));

  // Verify backward-compatible aliases are also registered
  assert.ok(toolNames.includes('code_callers'));
  assert.ok(toolNames.includes('code_callees'));
  assert.ok(toolNames.includes('code_blast_radius'));
  assert.ok(toolNames.includes('code_call_path'));
  assert.ok(toolNames.includes('code_subtypes'));
  assert.ok(toolNames.includes('code_oop_to_rust'));
  assert.ok(toolNames.includes('code_find_duplicates'));
  assert.ok(toolNames.includes('spec_to_code_flow'));
  assert.ok(toolNames.includes('code_to_spec_features'));
  assert.ok(toolNames.includes('schema_map_contract'));
  assert.ok(toolNames.includes('schema_migration_impact'));

  // Verify system prompt
  assert.ok(registeredPrompt);
  assert.strictEqual(registeredPrompt.name, 'tool:knowcode');
  assert.strictEqual(registeredPrompt.text, KNOWCODE_SYSTEM_PROMPT);
});
