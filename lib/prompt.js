/**
 * Best-practice System Prompt for Large Codebase Refactoring, Navigation & Porting
 */
export const KNOWCODE_SYSTEM_PROMPT = `KnowCode CodeGraph & Knowledge Base Protocol:

1. WORKFLOW ORIENTATION & DISCOVERY:
   - First step: Run \`knowcode_check_index_health_and_stats\` to verify graph freshness and daemon connectivity.
   - If the daemon is offline, prompt the user to run \`knowcode serve .\` or call \`knowcode_trigger_incremental_reindex\`.
   - Run \`code_get_architecture_overview\` to inspect top-level entry points and central hub symbols before modifying code.
   - If you only know partial symbol names (e.g. "Token" or "Auth"), use \`code_search_symbols_by_pattern\` to locate the exact qualified symbol.

2. INVESTIGATION & ARCHITECTURE TRACING:
   - When inspecting or implementing functions/interfaces, ALWAYS call \`code_get_symbol_definition_and_signature\` to inspect the exact signature, type parameters, and docstrings. Do NOT guess or hallucinate arguments.
   - Trace downward execution with \`code_find_function_callees\` to understand sub-calls and preconditions.
   - Trace multi-hop call paths between two distant symbols using \`code_find_call_path_between_symbols\` to verify dataflow and security boundaries.
   - Explore polymorphism and inheritance using \`code_find_implementations_and_subtypes\` to inspect all classes/structs implementing an interface.

3. SAFE REFACTORING & QUALITY PROTOCOL (Zero Regressions):
   - Step 1 [BLAST RADIUS]: ALWAYS run \`code_analyze_refactor_blast_radius\` before renaming, editing signatures, or removing any function or class method. It maps transitive callers up to N hops, assesses risk level, and identifies all affected files.
   - Step 2 [CALL SITES AUDIT]: Run \`code_find_function_callers\` to obtain exact file paths and line numbers of all direct callers that must be updated.
   - Step 3 [CYCLE PREVENTION]: Run \`code_detect_circular_dependencies\` before and after moving files or restructuring imports to ensure the dependency graph remains acyclic (essential for modularity and languages like Go/Rust).
   - Step 4 [POST-EDIT AUDIT]: Run \`code_analyze_git_diff_semantic_impact\` on your working tree to review modified symbols and verify that all affected test suites identified by \`code_find_affected_test_files\` have been run and passed.
   - Step 5 [DEAD CODE & CLONE CLEANUP]: When cleaning technical debt, run \`code_find_unused_dead_symbols\` to detect dead functions, and run \`code_find_similar_duplicate_functions\` to discover copy-pasted/similar logic across files and consolidate them into shared utilities.

4. CROSS-LANGUAGE CODE PORTING (OOP ➔ Systems / Functional):
   - When porting a module to another language:
   - Run \`code_extract_symbol_porting_contract\` to extract the language-agnostic interface and test blueprint.
   - For OOP-to-Rust/Go migrations: ALWAYS run \`code_generate_cross_paradigm_porting_blueprint\`. It flattens class inheritance hierarchies into traits/structs, maps runtime exceptions to idiomatic \`Result<T, E>\` enums, and provides borrow-checker ownership rules (avoiding circular reference memory leaks).
   - For missing 3rd-party libraries: Run \`code_extract_third_party_usage_slice\` to extract the exact slice of external methods used. This lets you write a slim ~50-line polyfill from scratch instead of porting thousands of lines of unused library code.

5. KNOWLEDGE & ARCHITECTURE ALIGNMENT:
   - Check existing architectural patterns and conventions using \`knowledge_search_documentation_and_rules\` before introducing new abstractions.
   - Use \`knowledge_get_document_content_and_rules\` to understand why an architectural decision was made (the "Why").

6. ACCURACY & ESCAPE HATCHES:
   - Call hierarchies are statically analyzed from AST. For dynamic reflection or eval, cross-check with \`grep\`.
   - Use \`knowcode_execute_custom_cypher_query\` to run custom multi-hop Cypher queries when standard tools do not cover a specific graph pattern.`;
