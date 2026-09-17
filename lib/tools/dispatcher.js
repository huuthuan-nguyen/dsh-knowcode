import { KnowCodeRpcClient } from '../server/client-rpc.js';
import { renderExplore, renderBlastRadius, renderCallers, renderCallees, renderCycles, renderSymbolDefinition, renderPortingContract, renderStatus, renderCallPath, renderSubtypes, renderSymbolSearchResults, renderUnusedSymbols, renderGitDiffImpact, renderCrossParadigmBlueprint, renderThirdPartyUsageSlice, renderDuplicateClones, renderFeatureCodeFlow, renderSymbolSpecFeatures, renderContractStorageMapping, renderStorageMigrationImpact, } from '../render.js';
export async function executeKnowCodeTool(rawAction, args, workdir, daemonPort = 48123) {
    const client = new KnowCodeRpcClient({ workdir, port: daemonPort });
    // Normalize action names and aliases
    const actionMap = {
        // Health & Indexing
        knowcode_check_index_health_and_stats: 'status',
        knowcode_status: 'status',
        status: 'status',
        knowcode_trigger_incremental_reindex: 'sync',
        knowcode_sync: 'sync',
        sync: 'sync',
        // Architecture & Definition
        code_get_architecture_overview: 'explore',
        code_explore: 'explore',
        explore: 'explore',
        code_get_symbol_definition_and_signature: 'symbol_definition',
        code_symbol_definition: 'symbol_definition',
        symbol_definition: 'symbol_definition',
        // Refactoring & Call Hierarchy
        code_analyze_refactor_blast_radius: 'blast_radius',
        code_blast_radius: 'blast_radius',
        blast_radius: 'blast_radius',
        code_find_function_callers: 'callers',
        code_function_callers: 'callers',
        code_callers: 'callers',
        callers: 'callers',
        code_find_function_callees: 'callees',
        code_function_callees: 'callees',
        code_callees: 'callees',
        callees: 'callees',
        // Dependencies & Tests
        code_detect_circular_dependencies: 'detect_cycles',
        code_detect_cycles: 'detect_cycles',
        detect_cycles: 'detect_cycles',
        code_find_affected_test_files: 'affected_tests',
        code_affected_tests: 'affected_tests',
        affected_tests: 'affected_tests',
        // Porting
        code_extract_symbol_porting_contract: 'porting_contract',
        code_porting_contract: 'porting_contract',
        porting_contract: 'porting_contract',
        // Advanced Call Path & Hierarchy
        code_find_call_path_between_symbols: 'call_path',
        code_call_path: 'call_path',
        code_trace_call_path: 'call_path',
        call_path: 'call_path',
        code_find_implementations_and_subtypes: 'subtypes',
        code_subtypes: 'subtypes',
        code_implementations: 'subtypes',
        subtypes: 'subtypes',
        code_search_symbols_by_pattern: 'search_symbols',
        code_search_symbols: 'search_symbols',
        search_symbols: 'search_symbols',
        code_find_unused_dead_symbols: 'unused_symbols',
        code_unused_symbols: 'unused_symbols',
        code_dead_code: 'unused_symbols',
        unused_symbols: 'unused_symbols',
        code_analyze_git_diff_semantic_impact: 'git_diff_impact',
        code_git_diff_impact: 'git_diff_impact',
        code_audit_git_diff: 'git_diff_impact',
        git_diff_impact: 'git_diff_impact',
        // Cross-paradigm porting, 3rd-party slicing, and clone detection
        code_generate_cross_paradigm_porting_blueprint: 'cross_paradigm_blueprint',
        code_oop_to_rust: 'cross_paradigm_blueprint',
        code_port_to_rust: 'cross_paradigm_blueprint',
        code_rust_to_oop: 'cross_paradigm_blueprint',
        cross_paradigm_blueprint: 'cross_paradigm_blueprint',
        code_extract_third_party_usage_slice: 'third_party_slice',
        code_library_slice: 'third_party_slice',
        code_slim_polyfill: 'third_party_slice',
        code_find_library_equivalent: 'third_party_slice',
        third_party_slice: 'third_party_slice',
        code_find_similar_duplicate_functions: 'similar_functions',
        code_find_duplicates: 'similar_functions',
        code_code_clones: 'similar_functions',
        similar_functions: 'similar_functions',
        // Bidirectional spec-to-code flow traceability
        spec_find_code_flow_for_feature: 'spec_code_flow',
        spec_to_code_flow: 'spec_code_flow',
        feature_code_flow: 'spec_code_flow',
        code_feature_flow: 'spec_code_flow',
        spec_code_flow: 'spec_code_flow',
        code_find_spec_features_for_symbol: 'symbol_spec_features',
        code_to_spec_features: 'symbol_spec_features',
        symbol_feature_specs: 'symbol_spec_features',
        feature_for_symbol: 'symbol_spec_features',
        symbol_spec_features: 'symbol_spec_features',
        // Polyglot contract-to-storage mapping
        schema_map_contract_to_storage: 'contract_storage_mapping',
        schema_map_contract: 'contract_storage_mapping',
        contract_to_db: 'contract_storage_mapping',
        map_contract_to_storage: 'contract_storage_mapping',
        contract_storage_mapping: 'contract_storage_mapping',
        schema_analyze_storage_migration_impact: 'storage_migration_impact',
        schema_migration_impact: 'storage_migration_impact',
        db_migration_blast_radius: 'storage_migration_impact',
        storage_migration_impact: 'storage_migration_impact',
        // Knowledge
        knowledge_search_documentation_and_rules: 'knowledge_search',
        knowledge_search: 'knowledge_search',
        knowledge_get_document_content_and_rules: 'knowledge_doc',
        knowledge_doc: 'knowledge_doc',
        // Cypher
        knowcode_execute_custom_cypher_query: 'cypher',
        knowcode_cypher: 'cypher',
        cypher: 'cypher',
    };
    const action = actionMap[rawAction] ?? rawAction;
    const isAlive = await client.isDaemonAlive();
    // If status is asked and daemon is not running, report offline status
    if (action === 'status' && !isAlive) {
        return {
            kind: 'knowcode',
            action: rawAction,
            content: '### 📊 KnowCode Index & Daemon Status\n- **Daemon**: 🔴 Offline\n\n' +
                '> **Actionable Hint**: Start the background indexer and file watcher with `knowcode serve .` or run `knowcode index .` once.',
        };
    }
    if (!isAlive) {
        return {
            kind: 'knowcode',
            action: rawAction,
            content: `[KnowCode Notice: Daemon is not currently active for '${workdir}'.]\n` +
                `To enable sub-millisecond graph queries, blast-radius analysis, and live file tracking, please run:\n` +
                `\`knowcode serve\` in your terminal (or run \`knowcode index .\` for a one-time build).`,
        };
    }
    try {
        switch (action) {
            case 'status': {
                const stats = await client.getStatus();
                return { kind: 'knowcode', action: rawAction, content: renderStatus(stats) };
            }
            case 'sync': {
                const res = await client.triggerIndex();
                return {
                    kind: 'knowcode',
                    action: rawAction,
                    content: `✅ **KnowCode Sync Complete**: Indexed ${res.filesIndexed} files and ${res.symbolsIndexed} symbols in ${res.timeMs}ms.`,
                };
            }
            case 'explore': {
                const data = await client.call('explore', { limit: args.limit });
                return { kind: 'knowcode', action: rawAction, content: renderExplore(data) };
            }
            case 'symbol_definition': {
                const data = await client.call('symbol_definition', { name: args.name, file: args.file });
                return { kind: 'knowcode', action: rawAction, content: renderSymbolDefinition(data, args.name) };
            }
            case 'blast_radius': {
                const data = await client.call('blast_radius', { symbol: args.symbol, depth: args.depth });
                return { kind: 'knowcode', action: rawAction, content: renderBlastRadius(data) };
            }
            case 'callers': {
                const data = await client.call('callers', { symbol: args.symbol });
                return { kind: 'knowcode', action: rawAction, content: renderCallers(args.symbol, data) };
            }
            case 'callees': {
                const data = await client.call('callees', { symbol: args.symbol });
                return { kind: 'knowcode', action: rawAction, content: renderCallees(args.symbol, data) };
            }
            case 'detect_cycles': {
                const data = await client.call('detect_cycles');
                return { kind: 'knowcode', action: rawAction, content: renderCycles(data) };
            }
            case 'affected_tests': {
                const data = await client.call('affected_tests', { files: args.files });
                const text = data.length === 0
                    ? 'No affected test files found for the given sources.'
                    : `### 🧪 Affected Test Suites (${data.length} files):\n` + data.map((t) => `- \`${t}\``).join('\n');
                return { kind: 'knowcode', action: rawAction, content: text };
            }
            case 'porting_contract': {
                const data = await client.call('porting_contract', { symbol: args.symbol });
                return { kind: 'knowcode', action: rawAction, content: renderPortingContract(data, args.symbol) };
            }
            case 'call_path': {
                const data = await client.call('call_path', { fromSymbol: args.fromSymbol, toSymbol: args.toSymbol });
                return { kind: 'knowcode', action: rawAction, content: renderCallPath(data) };
            }
            case 'subtypes': {
                const data = await client.call('subtypes', { symbol: args.symbol });
                return { kind: 'knowcode', action: rawAction, content: renderSubtypes(args.symbol, data) };
            }
            case 'search_symbols': {
                const data = await client.call('search_symbols', { pattern: args.pattern, kind: args.kind, limit: args.limit });
                return { kind: 'knowcode', action: rawAction, content: renderSymbolSearchResults(args.pattern, data) };
            }
            case 'unused_symbols': {
                const data = await client.call('unused_symbols', { limit: args.limit });
                return { kind: 'knowcode', action: rawAction, content: renderUnusedSymbols(data) };
            }
            case 'git_diff_impact': {
                const data = await client.call('git_diff_impact', { baseRef: args.baseRef });
                return { kind: 'knowcode', action: rawAction, content: renderGitDiffImpact(data) };
            }
            case 'cross_paradigm_blueprint': {
                const data = await client.call('cross_paradigm_blueprint', {
                    symbol: args.symbol,
                    targetLanguage: args.targetLanguage,
                });
                return { kind: 'knowcode', action: rawAction, content: renderCrossParadigmBlueprint(data) };
            }
            case 'third_party_slice': {
                const data = await client.call('third_party_slice', {
                    libraryPrefix: args.libraryPrefix,
                    targetLanguage: args.targetLanguage,
                });
                return { kind: 'knowcode', action: rawAction, content: renderThirdPartyUsageSlice(data) };
            }
            case 'similar_functions': {
                const data = await client.call('similar_functions', {
                    symbol: args.symbol,
                    threshold: args.threshold,
                    minLines: args.minLines,
                });
                return { kind: 'knowcode', action: rawAction, content: renderDuplicateClones(data) };
            }
            case 'spec_code_flow': {
                const data = await client.call('spec_code_flow', {
                    query: args.query,
                    flowDepth: args.flowDepth,
                });
                return { kind: 'knowcode', action: rawAction, content: renderFeatureCodeFlow(data) };
            }
            case 'symbol_spec_features': {
                const data = await client.call('symbol_spec_features', {
                    symbol: args.symbol,
                    searchCallers: args.searchCallers,
                });
                return { kind: 'knowcode', action: rawAction, content: renderSymbolSpecFeatures(data) };
            }
            case 'contract_storage_mapping': {
                const data = await client.call('contract_storage_mapping', {
                    contractEntity: args.contractEntity,
                    storageTarget: args.storageTarget,
                    storageEngine: args.storageEngine,
                });
                return { kind: 'knowcode', action: rawAction, content: renderContractStorageMapping(data) };
            }
            case 'storage_migration_impact': {
                const data = await client.call('storage_migration_impact', {
                    storageContainer: args.storageContainer,
                    attribute: args.attribute,
                    action: args.action,
                });
                return { kind: 'knowcode', action: rawAction, content: renderStorageMigrationImpact(data) };
            }
            case 'knowledge_search': {
                const data = await client.call('knowledge_search', { query: args.query, limit: args.limit });
                if (data.length === 0) {
                    return { kind: 'knowcode', action: rawAction, content: `No documentation matches found for "${args.query}".` };
                }
                const lines = [`### 📚 Knowledge Base Results for "${args.query}":\n`];
                for (const item of data) {
                    lines.push(`#### [${item.type.toUpperCase()}] ${item.title} (\`${item.path}\`)`);
                    lines.push(`${item.snippet}\n`);
                    if (item.linkedSymbols?.length > 0) {
                        lines.push(`_Linked Symbols_: ${item.linkedSymbols.map((s) => `\`${s}\``).join(', ')}\n`);
                    }
                }
                return { kind: 'knowcode', action: rawAction, content: lines.join('\n') };
            }
            case 'knowledge_doc': {
                const data = await client.call('knowledge_doc', { pathOrTitle: args.pathOrTitle });
                if (!data) {
                    return { kind: 'knowcode', action: rawAction, content: `Document "${args.pathOrTitle}" not found.` };
                }
                const lines = [
                    `### 📖 ${data.title} (\`${data.path}\`)`,
                    `**Category**: ${data.category}\n`,
                ];
                for (const sec of data.sections) {
                    lines.push(`${'#'.repeat(Math.min(6, sec.level + 2))} ${sec.title}`);
                    lines.push(sec.content);
                }
                if (data.rules.length > 0) {
                    lines.push('\n#### 📋 Document Rules:');
                    for (const r of data.rules) {
                        lines.push(`- [${r.priority.toUpperCase()}] **${r.title}**: ${r.content}`);
                    }
                }
                return { kind: 'knowcode', action: rawAction, content: lines.join('\n') };
            }
            case 'cypher': {
                const data = await client.query(args.cypher);
                return {
                    kind: 'knowcode',
                    action: rawAction,
                    content: '```json\n' + JSON.stringify(data.data ?? [], null, 2) + '\n```',
                };
            }
            default:
                return {
                    kind: 'knowcode',
                    action: rawAction,
                    content: `[KnowCode Error: Unknown action '${rawAction}']`,
                };
        }
    }
    catch (err) {
        return {
            kind: 'knowcode',
            action: rawAction,
            content: `[KnowCode Error: ${err.message}]`,
        };
    }
}
