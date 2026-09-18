import { emptySchema, objectSchema } from './json-schema.js';
export const knowCodeToolSpecs = [
    {
        name: 'knowcode_check_index_health_and_stats',
        description: 'Check the health of the FalkorDB graph index, total code files, symbols, call edges, documentation sections, architecture rules, and background daemon status. Reports whether an indexing pass is currently running, so a low file or symbol count can be recognised as work in progress rather than an empty workspace. Run this once per session before starting complex refactoring or navigation tasks to verify index freshness.',
        parameters: emptySchema(),
        action: 'status',
        aliases: ['knowcode_status'],
    },
    {
        name: 'knowcode_trigger_incremental_reindex',
        description: 'Trigger an on-demand incremental re-index of newly added or modified files across the workspace into the FalkorDB graph. Call this after editing or adding files if the background daemon is offline or after large batch code modifications to ensure graph accuracy. If a pass is already running, this shares it and returns its result rather than failing.',
        parameters: emptySchema(),
        action: 'sync',
        aliases: ['knowcode_sync'],
    },
    {
        name: 'code_get_architecture_overview',
        description: 'PRIMARY ORIENTATION TOOL for exploring unfamiliar repositories and large codebases. Queries the FalkorDB code graph to return top-level entry points (exported symbols with 0 internal callers), central hub symbols (ranked by incoming call in-degree / PageRank), and language breakdown without flooding the LLM context window with raw source code.',
        parameters: objectSchema({
            limit: {
                type: 'number',
                description: 'Maximum number of central hub symbols and entry points to return (default: 25).',
            },
        }),
        action: 'explore',
        aliases: ['code_explore'],
    },
    {
        name: 'code_get_symbol_definition_and_signature',
        description: 'Retrieve the exact AST definition, complete type signature, parameter list, return type, docstring, file path, and start/end line numbers of any function, method, class, struct, or interface. Eliminates signature hallucinations and argument guessing during implementation or interface conformance.',
        parameters: objectSchema({
            name: {
                type: 'string',
                description: 'Symbol name or fully qualified name (e.g. "validateToken", "UserService.authenticate", or "AuthController").',
            },
            file: {
                type: 'string',
                description: 'Optional relative file path to disambiguate when multiple symbols share the same name across different files.',
            },
        }, ['name']),
        action: 'symbol_definition',
        aliases: ['code_symbol_definition'],
    },
    {
        name: 'code_analyze_refactor_blast_radius',
        description: 'CRITICAL SAFE REFACTORING TOOL: ALWAYS run this before modifying, renaming, or deleting any shared function, class method, or exported API. Performs transitive graph traversal up to N hops to discover all indirect callers, computes a quantitative risk assessment score (Low/Medium/High/Critical), identifies all affected files, and lists automated test files covering the affected paths.',
        parameters: objectSchema({
            symbol: {
                type: 'string',
                description: 'Target symbol or method name to evaluate refactoring impact for (e.g. "validateToken" or "UserService.authenticate").',
            },
            depth: {
                type: 'number',
                description: 'Maximum transitive call depth to traverse in the graph (default: 3).',
            },
        }, ['symbol']),
        action: 'blast_radius',
        aliases: ['code_blast_radius'],
    },
    {
        name: 'code_find_function_callers',
        description: 'Find all direct invocation sites calling a specific function or class method across the entire codebase. Returns caller names, qualified caller identifiers, file paths, and exact line numbers. Essential during refactoring to update every invocation site when modifying function parameters, argument orders, or return types.',
        parameters: objectSchema({
            symbol: {
                type: 'string',
                description: 'Function or method name to find callers for (e.g. "validateToken" or "UserService.authenticate").',
            },
        }, ['symbol']),
        action: 'callers',
        aliases: ['code_callers', 'code_function_callers'],
    },
    {
        name: 'code_find_function_callees',
        description: 'Find all subroutines, helper functions, and methods called directly by a specific function or method (downward execution trace). Inspects dependencies, sub-calls, and error-checking branches to understand implementation logic and preconditions before modifying a function.',
        parameters: objectSchema({
            symbol: {
                type: 'string',
                description: 'Function or method name to trace outgoing calls from (e.g. "handleLogin" or "AuthController.handleLogin").',
            },
        }, ['symbol']),
        action: 'callees',
        aliases: ['code_callees', 'code_function_callees'],
    },
    {
        name: 'code_detect_circular_dependencies',
        description: 'Detect circular **import** dependency loops between files and modules using FalkorDB cycle traversal. Reports file paths, not individual symbols: a loop is listed once per rotation, so a single three-file cycle appears three times. Crucial when modularizing monolithic codebases, breaking tight coupling, or preparing for language ports (e.g. Go and Rust strictly forbid circular package imports).',
        parameters: emptySchema(),
        action: 'detect_cycles',
        aliases: ['code_detect_cycles'],
    },
    {
        name: 'code_find_affected_test_files',
        description: 'Discover all automated unit and integration test files that cover or import the specified source files. Uses both graph import dependencies and naming conventions (*.test.ts, *_test.go, test_*.py). Run this after completing code edits or bug fixes to verify zero regressions.',
        parameters: objectSchema({
            files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of relative source file paths that were modified or are being refactored (e.g. ["src/auth.ts", "src/user.ts"]).',
            },
        }, ['files']),
        action: 'affected_tests',
        aliases: ['code_affected_tests'],
    },
    {
        name: 'code_extract_symbol_porting_contract',
        description: 'CROSS-LANGUAGE PORTING ACCELERATOR: Extracts the complete language-agnostic interface blueprint of a class, struct, or module: exported signatures, member fields, enclosed methods, external callee dependencies, governing ADR architectural rules, and test suites. Provides the exact specification needed to port code to another language (e.g. Python to Go, TypeScript to Rust) with 100% semantic fidelity.',
        parameters: objectSchema({
            symbol: {
                type: 'string',
                description: 'Name of the class, struct, or function to generate a porting contract for (e.g. "AuthService").',
            },
        }, ['symbol']),
        action: 'porting_contract',
        aliases: ['code_porting_contract'],
    },
    {
        name: 'knowledge_search_documentation_and_rules',
        description: 'Search across project documentation, Architecture Decision Records (ADRs), specifications, and coding standards. Returns matched sections with priority levels (MUST / SHOULD / AVOID) and automatic cross-links to related code symbols in the graph.',
        parameters: objectSchema({
            query: {
                type: 'string',
                description: 'Technical concept, architectural pattern, or question to search (e.g. "authentication token validation" or "database error handling").',
            },
            limit: {
                type: 'number',
                description: 'Maximum number of documentation matches to return (default: 10).',
            },
        }, ['query']),
        action: 'knowledge_search',
        aliases: ['knowledge_search'],
    },
    {
        name: 'knowledge_get_document_content_and_rules',
        description: 'Retrieve the full content, heading hierarchy, and architectural rules for a specific documentation file or ADR title. Use this to understand why an architectural decision was made (the "Why") before refactoring existing code patterns.',
        parameters: objectSchema({
            pathOrTitle: {
                type: 'string',
                description: 'Relative file path (e.g. "docs/adr/001-auth.md") or document heading title.',
            },
        }, ['pathOrTitle']),
        action: 'knowledge_doc',
        aliases: ['knowledge_doc'],
    },
    {
        name: 'knowcode_execute_custom_cypher_query',
        description: 'ADVANCED ESCAPE HATCH: Execute a raw Cypher query directly against the FalkorDB code and knowledge graph for specialized multi-hop traversals not covered by standard tools (e.g. finding classes implementing an interface that do not call a specific validator).',
        parameters: objectSchema({
            cypher: {
                type: 'string',
                description: 'Cypher query string (e.g. "MATCH (c:Symbol {kind: \'class\'})<-[:EXTENDS]-(sub) RETURN c.name, sub.name LIMIT 10").',
            },
        }, ['cypher']),
        action: 'cypher',
        aliases: ['knowcode_cypher'],
    },
    {
        name: 'code_find_call_path_between_symbols',
        description: 'Trace the shortest call invocation path between two functions or methods across the entire codebase graph (up to 12 hops). Traces multi-hop execution flow from entry points to downstream services, helping verify architectural layering, security boundaries, and dataflow paths.',
        parameters: objectSchema({
            fromSymbol: {
                type: 'string',
                description: 'Source function or method name (e.g. "handleLogin" or "AuthController.login").',
            },
            toSymbol: {
                type: 'string',
                description: 'Target downstream function or method name (e.g. "executePayment" or "Database.query").',
            },
        }, ['fromSymbol', 'toSymbol']),
        action: 'call_path',
        aliases: ['code_call_path', 'code_trace_call_path'],
    },
    {
        name: 'code_find_implementations_and_subtypes',
        description: 'Find all subclasses, structs, and classes that extend or implement a given interface, abstract class, or base class. Essential for polymorphism, dependency injection, and factory pattern refactorings.',
        parameters: objectSchema({
            symbol: {
                type: 'string',
                description: 'Name of the base class or interface (e.g. "IUserRepository" or "BaseController").',
            },
        }, ['symbol']),
        action: 'subtypes',
        aliases: ['code_subtypes', 'code_implementations'],
    },
    {
        name: 'code_search_symbols_by_pattern',
        description: 'Search for symbols across the codebase by name pattern, case-insensitive substring, or keyword. Useful when you only know a partial name or concept (e.g. "Token", "Auth", "Payment") and need to locate the exact qualified symbol name.',
        parameters: objectSchema({
            pattern: {
                type: 'string',
                description: 'Substring or pattern to search for in symbol names (e.g. "Token" or "validate").',
            },
            kind: {
                type: 'string',
                description: 'Optional symbol kind filter (e.g. "function", "class", "method", "interface").',
            },
            limit: {
                type: 'number',
                description: 'Maximum number of results to return (default: 25).',
            },
        }, ['pattern']),
        action: 'search_symbols',
        aliases: ['code_search_symbols'],
    },
    {
        name: 'code_find_unused_dead_symbols',
        description: 'Identify unreferenced symbols with 0 incoming calls in the codebase, to eliminate dead code, ghost helpers and unused declarations. By default only internal/private symbols are reported, since an exported symbol may be public API; pass `include_exported` to widen it. Methods that satisfy an implemented interface or base-class member are excluded: they fulfil a contract even when nothing calls them by name.',
        // Both are optional: the schema must not force the caller to pass them.
        parameters: objectSchema({
            limit: {
                type: 'number',
                description: 'Maximum number of dead symbol candidates to return (default: 50).',
            },
            include_exported: {
                type: 'boolean',
                description: 'Also report exported symbols with no incoming calls (default false). Useful in an application; in a library an export may be public API.',
            },
        }),
        action: 'unused_symbols',
        aliases: ['code_dead_code', 'code_unused_symbols'],
    },
    {
        name: 'code_analyze_git_diff_semantic_impact',
        description: 'ONE-CLICK REGRESSION AUDIT: Analyzes uncommitted git working tree changes (or changes against a base commit/branch), maps changed line ranges to AST symbols, computes transitive callers at risk, and identifies all automated test suites to run before commit or PR creation.',
        parameters: objectSchema({
            baseRef: {
                type: 'string',
                description: 'Optional git base ref or commit to diff against (e.g. "HEAD~1" or "main"). If omitted, checks current unstaged and staged changes.',
            },
        }),
        action: 'git_diff_impact',
        aliases: ['code_git_diff_impact', 'code_audit_git_diff'],
    },
    {
        name: 'code_generate_cross_paradigm_porting_blueprint',
        description: 'CROSS-PARADIGM PORTING ACCELERATOR: Bidirectional paradigm transformation tool. Supports OOP (Java/C#) ➔ Systems/Functional (Rust/Go) by flattening class hierarchies into traits/structs and Result/Error enums. Also supports reverse porting: Functional/Systems (Rust/Go) ➔ OOP (Java/C#) with encapsulation, getters/setters, interface conformance, and class exception hierarchies.',
        parameters: objectSchema({
            symbol: {
                type: 'string',
                description: 'Name of the class, struct, or module to port (e.g. "UserManager" or "PaymentService").',
            },
            targetLanguage: {
                type: 'string',
                description: 'Target language paradigm (default: "rust", options: "rust" | "go" | "java" | "csharp").',
            },
        }, ['symbol']),
        action: 'cross_paradigm_blueprint',
        aliases: ['code_oop_to_rust', 'code_port_to_rust', 'code_rust_to_oop'],
    },
    {
        name: 'code_extract_third_party_usage_slice',
        description: 'ZERO-DEPENDENCY POLYFILL & ECOSYSTEM RECOMMENDER: Analyzes the exact subset of an external 3rd-party library actually invoked by your codebase. Eliminates 95% of unused surface area, outputs a minimal functional specification to re-implement from scratch, AND recommends equivalent target ecosystem libraries (e.g. Java Guava Cache ➔ Rust moka or Go bigcache) with method-to-method API mappings.',
        parameters: objectSchema({
            libraryPrefix: {
                type: 'string',
                description: 'Package name or prefix of the 3rd party library to slice (e.g. "com.google.common.cache" or "jsonwebtoken").',
            },
            targetLanguage: {
                type: 'string',
                description: 'Target language ecosystem to find equivalents for (default: "rust", options: "rust" | "go" | "java" | "typescript" | "python").',
            },
        }, ['libraryPrefix']),
        action: 'third_party_slice',
        aliases: ['code_library_slice', 'code_slim_polyfill', 'code_find_library_equivalent'],
    },
    {
        name: 'code_find_similar_duplicate_functions',
        description: 'SEMANTIC & STRUCTURAL CODE CLONE HUNTER: Detects duplicate or near-duplicate functions and methods across the codebase (Type-1 exact clones and Type-2 variable-renamed clones) using normalized AST token stream fingerprinting. Uncovers copy-pasted "dirty code" where logic and control-flow are identical but variable names differ, proposing unified abstractions to eliminate technical debt.',
        parameters: objectSchema({
            symbol: {
                type: 'string',
                description: 'Optional function or method name to find clones of. If omitted, scans the entire workspace for duplicate pairs.',
            },
            threshold: {
                type: 'number',
                description: 'Similarity threshold from 0.0 to 1.0 (default: 0.85).',
            },
            minLines: {
                type: 'number',
                description: 'Minimum line count of functions to inspect (default: 3).',
            },
        }),
        action: 'similar_functions',
        aliases: ['code_find_duplicates', 'code_code_clones'],
    },
    {
        name: 'spec_find_code_flow_for_feature',
        description: 'BIDIRECTIONAL TRACEABILITY (Spec ➔ Code Flow): Discovers all functions, classes, and downstream call-flows in the codebase that implement a feature specified in *.md documentation, PRD, or architecture specs. Traverses execution flow from entry points to leaf services and generates an ASCII / Mermaid execution diagram.',
        parameters: objectSchema({
            query: {
                type: 'string',
                description: 'Feature name, keyword, or spec markdown file path (e.g. "User Authentication" or "docs/specs/checkout.md").',
            },
            flowDepth: {
                type: 'number',
                description: 'Maximum call-flow depth to traverse (default: 3, max: 6).',
            },
        }, ['query']),
        action: 'spec_code_flow',
        aliases: ['spec_to_code_flow', 'feature_code_flow', 'code_feature_flow'],
    },
    {
        name: 'code_find_spec_features_for_symbol',
        description: 'BIDIRECTIONAL TRACEABILITY (Code ➔ Feature Specs): Identifies all features, specifications in *.md, PRD sections, and architectural rules that a specific function, method, or class belongs to or serves. Traces both direct documentation links and upstream caller execution paths.',
        parameters: objectSchema({
            symbol: {
                type: 'string',
                description: 'Name of the function, method, or class to inspect (e.g. "PasswordHasher.verify" or "OrderRepository.save").',
            },
            searchCallers: {
                type: 'boolean',
                description: 'Whether to traverse upstream callers to identify higher-level feature flows (default: true).',
            },
        }, ['symbol']),
        action: 'symbol_spec_features',
        aliases: ['code_to_spec_features', 'symbol_feature_specs', 'feature_for_symbol'],
    },
    {
        name: 'schema_map_contract_to_storage',
        description: 'POLYGLOT CONTRACT-TO-STORAGE ALIGNMENT: Maps any external data contract (XML XSD, JSON OpenAPI/Swagger, gRPC Protobuf) to polyglot storage backends (SQL, MongoDB, Redis, Elasticsearch, Vector DB, TSDB, Graph DB). Produces a field-level mapping matrix, detects type discrepancies (e.g. numeric overflow, BSON ObjectId vs UUID, dense vector dimensions), and flags unmapped/orphan attributes.',
        parameters: objectSchema({
            contractEntity: {
                type: 'string',
                description: 'Name of the message, complexType, or schema (e.g. "UserProfile" or "CustomerRecord").',
            },
            storageTarget: {
                type: 'string',
                description: 'Optional target table, collection, or index name (e.g. "users" or "users_idx").',
            },
            storageEngine: {
                type: 'string',
                description: 'Optional storage engine filter (e.g. "sql", "mongodb", "redis", "elasticsearch", "vector").',
            },
        }, ['contractEntity']),
        action: 'contract_storage_mapping',
        aliases: ['schema_map_contract', 'contract_to_db', 'map_contract_to_storage'],
    },
    {
        name: 'schema_analyze_storage_migration_impact',
        description: 'POLYGLOT STORAGE MIGRATION BLAST RADIUS: Analyzes the breaking impact of altering, dropping, or renaming an attribute in SQL tables, MongoDB collections, Elasticsearch indices, or Vector DB collections. Detects all affected external contracts (XML/JSON/gRPC), application DAOs/queries, and mapped test suites.',
        parameters: objectSchema({
            storageContainer: {
                type: 'string',
                description: 'Name of the SQL table, Mongo collection, or ES index (e.g. "users").',
            },
            attribute: {
                type: 'string',
                description: 'Name of the column or field being modified (e.g. "email" or "embedding").',
            },
            action: {
                type: 'string',
                description: 'Planned schema change (default: "drop", options: "drop" | "rename" | "type_change").',
            },
        }, ['storageContainer', 'attribute']),
        action: 'storage_migration_impact',
        aliases: ['schema_migration_impact', 'db_migration_blast_radius'],
    },
];
