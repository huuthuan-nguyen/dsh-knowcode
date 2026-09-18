export function renderExplore(data) {
    const parts = ['### 🧭 Codebase Architectural Overview\n'];
    parts.push('#### 📍 Top Entry Points (Public / 0 Callers):');
    if (data.entryPoints.length === 0) {
        parts.push('_No explicit entry points identified._');
    }
    else {
        for (const ep of data.entryPoints.slice(0, 10)) {
            parts.push(`- **\`${ep.name}\`** (${ep.kind}) in \`${ep.file}\``);
        }
    }
    parts.push('\n#### ⚓ Central Hub Symbols (Highest incoming call degree):');
    if (data.topSymbols.length === 0) {
        parts.push('_No call connections found yet. Run index or sync._');
    }
    else {
        for (const hub of data.topSymbols.slice(0, 10)) {
            parts.push(`- **\`${hub.name}\`** (${hub.kind}) in \`${hub.file}\` — Called by **${hub.inDegree}** callers`);
        }
    }
    parts.push(`\n_Sample of ${data.files.length} indexed files. Query symbols with \`code_symbol_definition\` or \`code_callers\`._`);
    return parts.join('\n');
}
export function renderBlastRadius(data) {
    const parts = [];
    const riskBadge = {
        low: '🟢 LOW RISK',
        medium: '🟡 MEDIUM RISK',
        high: '🟠 HIGH RISK',
        critical: '🔴 CRITICAL RISK',
    }[data.riskAssessment.level];
    parts.push(`### 💥 Blast Radius Analysis: \`${data.targetSymbol}\``);
    parts.push(`**File**: \`${data.targetFile}\` | **Depth**: ${data.depth} | **Risk**: ${riskBadge} (${data.riskAssessment.score}/100)`);
    parts.push(`**Total Affected Callers**: ${data.totalAffectedCallers} across **${data.affectedFiles.length}** files\n`);
    parts.push('#### ⚠️ Risk Assessment:');
    for (const reason of data.riskAssessment.reasons) {
        parts.push(`- ${reason}`);
    }
    parts.push('\n#### ⛓️ Transitive Caller Chain:');
    if (data.callChain.length === 0) {
        parts.push('_No callers found. Symbol can be modified with minimal ripple effects._');
    }
    else {
        for (const c of data.callChain.slice(0, 20)) {
            parts.push(`- [Depth ${c.depth}] \`${c.callerQName}\` in \`${c.callerFile}:${c.callerLine}\` ➔ calls \`${c.calleeName}\``);
        }
        if (data.callChain.length > 20) {
            parts.push(`_...and ${data.callChain.length - 20} more callers._`);
        }
    }
    parts.push('\n#### 🧪 Recommended Verification Tests:');
    if (data.affectedTests.length === 0) {
        parts.push('⚠️ _No automated test files detected covering these paths. Manual verification advised._');
    }
    else {
        for (const test of data.affectedTests) {
            parts.push(`- \`${test}\``);
        }
    }
    return parts.join('\n');
}
export function renderCallers(symbol, callers) {
    if (callers.length === 0) {
        return `No callers found calling function/method \`${symbol}\`.`;
    }
    const lines = [`### 📞 Direct Callers for Function/Method \`${symbol}\` (${callers.length} sites):\n`];
    for (const c of callers) {
        lines.push(`- \`${c.callerQName}\` (${c.callerKind}) at \`${c.file}:${c.line}\``);
    }
    return lines.join('\n');
}
export function renderCallees(symbol, callees) {
    if (callees.length === 0) {
        return `No outgoing calls found from function/method \`${symbol}\`.`;
    }
    const lines = [`### 🔍 Callees Called By Function/Method \`${symbol}\` (${callees.length} targets):\n`];
    for (const c of callees) {
        lines.push(`- \`${c.calleeQName}\` (${c.calleeKind}) in \`${c.file}\``);
    }
    return lines.join('\n');
}
export function renderCycles(data) {
    if (!data.hasCycles) {
        return '✅ **No circular dependencies detected!** The dependency DAG is clean and acyclic.';
    }
    const lines = [`### ⚠️ Circular Dependencies Detected (${data.cycleCount} loops):\n`];
    for (let i = 0; i < data.cycles.length; i++) {
        lines.push(`${i + 1}. ${data.cycles[i].formatted}`);
    }
    lines.push('\n_Resolve these cycles before refactoring modules or porting to languages like Go or Rust._');
    return lines.join('\n');
}
export function renderSymbolDefinition(sym, name) {
    if (!sym) {
        return `Symbol \`${name}\` not found in codebase index.`;
    }
    const lines = [
        `### 🏷️ Symbol: \`${sym.qname}\` (${sym.kind})`,
        `- **File**: \`${sym.file}\` (lines ${sym.startLine}-${sym.endLine})`,
        `- **Visibility**: ${sym.visibility ?? 'public'} | **Exported**: ${sym.isExported ? 'yes' : 'no'}`,
        `\`\`\`typescript\n${sym.signature}\n\`\`\``,
    ];
    if (sym.docstring) {
        lines.push(`**Documentation**:\n${sym.docstring}`);
    }
    return lines.join('\n');
}
export function renderPortingContract(data, symbol) {
    if (!data)
        return `Could not generate porting contract for \`${symbol}\`. Symbol not found.`;
    const lines = [
        `### 🔄 Language Porting Contract: \`${data.qname}\` (${data.language})`,
        `**Kind**: ${data.kind} | **Source File**: \`${data.file}\` | **Exported**: ${data.exported ? 'Yes' : 'No'}`,
        '\n#### 📜 Signature & Contract:',
        `\`\`\`${data.language}\n${data.signature}\n\`\`\``,
    ];
    if (data.docstring) {
        lines.push(`\n#### 📝 Documented Specifications:\n${data.docstring}`);
    }
    if (data.typesAndMembers.length > 0) {
        lines.push('\n#### 🧱 Enclosed Members / Struct Fields:');
        for (const m of data.typesAndMembers) {
            lines.push(`- **\`${m.name}\`** (${m.kind}): \`${m.signature}\``);
        }
    }
    const supertypes = data.dependencies.supertypes ?? [];
    if (supertypes.length > 0) {
        lines.push('\n#### 🧬 Inherited / Implemented Types (also required by the port):');
        for (const sup of supertypes) {
            lines.push(`- \`${sup.name}\`${sup.external ? ' _(defined outside the workspace)_' : ''}`);
        }
    }
    lines.push('\n#### 🔗 External Call Dependencies:');
    if (data.dependencies.callees.length === 0) {
        lines.push(supertypes.length > 0
            ? '_No calls of its own, but it depends on the types listed above._'
            : '_Pure self-contained logic (zero external callees). Ideal for porting!_');
    }
    else {
        for (const c of data.dependencies.callees) {
            lines.push(`- Calls \`${c.qname ?? c.name}\` in \`${c.file ?? 'external'}\``);
        }
    }
    if (data.governingRules.length > 0) {
        lines.push('\n#### 📋 Governing Architectural Rules (ADRs):');
        for (const r of data.governingRules) {
            lines.push(`- **${r.title}**: ${r.content}`);
        }
    }
    lines.push('\n#### 🧪 Verification Test Suites:');
    if (data.relatedTests.length === 0) {
        lines.push('_No existing tests found. Write unit tests before and after porting._');
    }
    else {
        for (const t of data.relatedTests) {
            lines.push(`- \`${t}\``);
        }
    }
    return lines.join('\n');
}
export function renderStatus(stats) {
    return [
        '### 📊 KnowCode Index & Daemon Status',
        `- **Daemon**: ${stats.daemonRunning ? `🟢 Online (PID: ${stats.daemonPid}, Port: ${stats.port})` : '🔴 Offline'}`,
        `- **Database**: \`${stats.dbPath}\``,
        `- **Code Files**: ${stats.totalCodeFiles}`,
        `- **Symbols**: ${stats.totalSymbols}`,
        `- **Call Edges**: ${stats.totalCalls}`,
        `- **Knowledge Docs**: ${stats.totalDocFiles} (${stats.totalSections} sections, ${stats.totalRules} rules)`,
        `- **Last Indexed**: ${stats.lastIndexedAt ?? 'Never'}`,
    ].join('\n');
}
export function renderCallPath(data) {
    if (!data.found) {
        return `### 🛤️ Call Path Analysis\n${data.formatted}`;
    }
    return [
        `### 🛤️ Shortest Call Path (${data.hops} hops): \`${data.fromSymbol}\` ➔ \`${data.toSymbol}\``,
        data.formatted,
    ].join('\n');
}
export function renderSubtypes(symbol, subtypes) {
    if (subtypes.length === 0) {
        return `No subclasses or implementations found extending/implementing \`${symbol}\`.`;
    }
    const lines = [`### 🧬 Subtypes & Implementations for \`${symbol}\` (${subtypes.length} classes/structs):\n`];
    for (const s of subtypes) {
        lines.push(`- **\`${s.qname}\`** [${s.relationship}] (${s.kind}) in \`${s.file}:${s.startLine}\``);
    }
    return lines.join('\n');
}
export function renderSymbolSearchResults(pattern, symbols) {
    if (symbols.length === 0) {
        return `No symbols matching pattern "${pattern}" found in codebase.`;
    }
    const lines = [`### 🔍 Symbol Search Results for "${pattern}" (${symbols.length} matches):\n`];
    for (const s of symbols) {
        lines.push(`- **\`${s.qname}\`** (\`${s.kind}\`) in \`${s.file}:${s.startLine}\` — \`${s.signature}\``);
    }
    return lines.join('\n');
}
export function renderUnusedSymbols(symbols) {
    if (symbols.length === 0) {
        return '✅ **Clean Codebase!** No unreferenced internal symbols detected.';
    }
    const lines = [
        `### 🧹 Unused / Dead Symbol Candidates (${symbols.length} symbols with 0 incoming calls):\n`,
        '> _Review these internal symbols for deletion or dead code cleanup:_\n',
    ];
    for (const s of symbols) {
        lines.push(`- **\`${s.qname}\`** (${s.kind}) at \`${s.file}:${s.startLine}\`${s.isExported ? ' — _exported, may be public API_' : ''}`);
    }
    return lines.join('\n');
}
export function renderGitDiffImpact(data) {
    const riskBadge = data.overallRisk === 'critical'
        ? '🔴 **CRITICAL RISK**'
        : data.overallRisk === 'high'
            ? '🟠 **HIGH RISK**'
            : data.overallRisk === 'medium'
                ? '🟡 **MEDIUM RISK**'
                : '🟢 **LOW RISK**';
    const lines = [
        `### 📊 Git Diff Semantic Impact Analysis`,
        `- **Overall Risk**: ${riskBadge}`,
        `- **Summary**: ${data.summary}`,
        `- **Files Changed**: ${data.filesChanged}`,
        `- **Directly Impacted Symbols**: ${data.impactedSymbols.length}`,
        `- **Incoming Callers at Risk**: ${data.totalTransitiveCallers}`,
    ];
    if (data.impactedSymbols.length > 0) {
        lines.push('\n#### 🎯 Modified/Impacted Symbols:');
        for (const sym of data.impactedSymbols) {
            lines.push(`- [${sym.changeType.toUpperCase()}] **\`${sym.qname}\`** (${sym.kind}) at \`${sym.file}:${sym.line}\``);
        }
    }
    lines.push('\n#### 🧪 Verification Test Suites:');
    if (data.affectedTests.length === 0) {
        lines.push('_No affected test suites detected. Consider adding unit tests for modified symbols._');
    }
    else {
        for (const t of data.affectedTests) {
            lines.push(`- \`${t}\``);
        }
    }
    return lines.join('\n');
}
export function renderCrossParadigmBlueprint(data) {
    const icon = data.targetLanguage === 'rust'
        ? '🦀'
        : data.targetLanguage === 'go'
            ? '🐹'
            : data.targetLanguage === 'java'
                ? '☕'
                : '🔷';
    const lines = [
        `### ${icon} Cross-Paradigm Blueprint: \`${data.symbolName}\` ➔ ${data.targetLanguage.toUpperCase()}`,
        `- **Source Paradigm**: ${data.sourceKind} in ${data.sourceLanguage}`,
        `- **Target Language**: ${data.targetLanguage.toUpperCase()}`,
        `- **Constructs / Structs**: ${data.structs.length}`,
        `- **Behavior Traits / Interfaces**: ${data.traits.length}`,
    ];
    if (data.traits.length > 0) {
        lines.push('\n#### 🧬 Behavior Traits / Interfaces (carry these over too):');
        for (const t of data.traits) {
            lines.push(`- **\`${t.name}\`**${t.methods.length > 0 ? ` — ${t.methods.length} member(s)` : ''}`);
        }
    }
    if (data.ownershipGuidelines.length > 0) {
        lines.push('\n#### 🛡️ Ownership & Architectural Guidelines:');
        for (const g of data.ownershipGuidelines) {
            lines.push(`- ${g}`);
        }
    }
    if (data.idiomaticSkeleton) {
        lines.push(`\n#### 📐 Idiomatic ${data.targetLanguage.toUpperCase()} Skeleton:`);
        lines.push(`\`\`\`${data.targetLanguage}\n${data.idiomaticSkeleton}\`\`\``);
    }
    return lines.join('\n');
}
export function renderThirdPartyUsageSlice(data) {
    const lines = [
        `### 🧩 3rd-Party Library Usage Slice: \`${data.libraryPrefix}\``,
        `- **Total Call Sites in Workspace**: ${data.totalCallSites}`,
        `- **Distinct Invoked Methods**: ${data.invokedMethods.length}`,
        `- **Imported Symbols**: ${data.importedSymbols.length === 0 ? 'Wildcard/Direct' : data.importedSymbols.map((s) => `\`${s}\``).join(', ')}`,
        `- **Slim Polyfill Feasibility**: ~${data.suggestedPolyfillSpec.estimatedLinesToImplement} lines of code to write from scratch`,
        `\n> **Architectural Recommendation**: ${data.suggestedPolyfillSpec.summary}\n`,
    ];
    if (data.invokedMethods.length > 0) {
        lines.push('#### 🎯 Methods Actually Used by Codebase:');
        for (const m of data.invokedMethods) {
            lines.push(`- **\`${m.name}\`** (${m.callCount} calls across ${m.callerFiles.length} files) — Example at \`${m.callerFiles[0]}:${m.exampleLine}\``);
        }
    }
    if (data.recommendedPackages && data.recommendedPackages.length > 0) {
        lines.push('\n#### 📦 Recommended 3rd-Party Libraries in Target Ecosystem:');
        for (const pkg of data.recommendedPackages) {
            lines.push(`- **\`${pkg.packageName}\`** (${pkg.ecosystem})`);
            lines.push(`  - **Install**: \`${pkg.installCommand}\``);
            lines.push(`  - **Description**: ${pkg.description}`);
            if (pkg.methodMappings.length > 0) {
                lines.push(`  - **API Mapping**: ${pkg.methodMappings.map((m) => `\`${m.sourceMethod}()\` ➔ \`${m.targetMethod}()\``).join(', ')}`);
            }
        }
    }
    return lines.join('\n');
}
export function renderDuplicateClones(clones) {
    if (clones.length === 0) {
        return '✅ **Clean Codebase!** No duplicate or copy-paste code clones detected.';
    }
    const lines = [
        `### 👯 Code Clones & Duplicate Logic Detected (${clones.length} pairs):\n`,
        '> _The following functions share identical AST control flow and callee patterns (differing only in variable names or literals). Refactor to eliminate technical debt:_\n',
    ];
    for (let i = 0; i < clones.length; i++) {
        const c = clones[i];
        lines.push(`#### ${i + 1}. [${c.cloneType}] ${c.similarityPercent}% Logic Match`);
        lines.push(`- **Function A**: \`${c.sourceSymbol.qname}\` at \`${c.sourceSymbol.file}:${c.sourceSymbol.line}\``);
        lines.push(`- **Function B**: \`${c.targetSymbol.qname}\` at \`${c.targetSymbol.file}:${c.targetSymbol.line}\``);
        if (c.differingVariables.length > 0) {
            lines.push(`- **Differing Identifiers**: ${c.differingVariables.map((v) => `\`${v.sourceVar}\` ➔ \`${v.targetVar}\``).join(', ')}`);
        }
        lines.push(`- **Refactoring Recommendation**: ${c.suggestedRefactoring}\n`);
    }
    return lines.join('\n');
}
export function renderFeatureCodeFlow(data) {
    if (!data.specFile && data.entrySymbols.length === 0) {
        return `⚠️ ${data.description}`;
    }
    const lines = [
        `### 🗺️ Feature Spec ➔ Code Execution Flow: "${data.featureName}"`,
        `- **Specification File**: \`${data.specFile}\``,
        `- **Spec Section**: ${data.specSection}`,
        `- **Total Code Symbols Involved**: ${data.totalSymbolsInvolved}`,
        `- **Source Files Involved**: ${data.filesInvolved.length} file(s)`,
    ];
    if (data.description) {
        lines.push(`\n> **Spec Summary**: ${data.description.replace(/\n+/g, ' ')}\n`);
    }
    if (data.entrySymbols.length > 0) {
        lines.push('#### 🚪 Entry Point Symbols:');
        for (const e of data.entrySymbols) {
            lines.push(`- **\`${e.qname}\`** (${e.kind}) at \`${e.file}:${e.line}\``);
        }
    }
    if (data.executionFlow.length > 0) {
        lines.push('\n#### ⚡ Call Execution Hierarchy:');
        for (const node of data.executionFlow) {
            const indent = '  '.repeat(node.depth);
            const callerInfo = node.callerName ? ` _(called by \`${node.callerName}\`)_` : ' _(Entry Point)_';
            lines.push(`${indent}- **\`${node.qname}\`** (${node.kind}) at \`${node.file}:${node.line}\`${callerInfo}`);
        }
    }
    if (data.mermaidDiagram && data.mermaidDiagram.trim().length > 10) {
        lines.push('\n#### 📊 Flow Diagram:');
        lines.push(`\`\`\`mermaid\n${data.mermaidDiagram}\`\`\``);
    }
    return lines.join('\n');
}
export function renderSymbolSpecFeatures(data) {
    const lines = [
        `### 📋 Symbol ➔ Feature Specs Mapping: \`${data.symbolQName}\``,
        `- **Defined in File**: \`${data.file}:${data.line}\``,
        `- **Direct Spec References**: ${data.directSpecs.length}`,
        `- **Upstream Feature Flows**: ${data.indirectFeatures.length}`,
        `\n> **Traceability Summary**: ${data.summary}\n`,
    ];
    if (data.directSpecs.length > 0) {
        lines.push('#### 📖 Directly Documented In:');
        for (const s of data.directSpecs) {
            lines.push(`- **${s.sectionTitle}** (\`${s.specFile}\`) [${s.relation.toUpperCase()}]`);
            if (s.contentSnippet) {
                lines.push(`  > _"${s.contentSnippet.trim()}..."_`);
            }
        }
    }
    if (data.indirectFeatures.length > 0) {
        lines.push('\n#### 🎯 Serves in Feature Flows:');
        for (const f of data.indirectFeatures) {
            const pathStr = f.callPath.length > 0 ? f.callPath.join(' ➔ ') : f.entryPoint;
            lines.push(`- **Feature**: "${f.featureName}" (\`${f.specFile}\`)`);
            lines.push(`  - **Invocation Path**: \`${pathStr}\``);
        }
    }
    if (data.directSpecs.length === 0 && data.indirectFeatures.length === 0) {
        lines.push('_This symbol is not currently linked to any specification in *.md or called by documented feature entry points._');
    }
    return lines.join('\n');
}
export function renderContractStorageMapping(data) {
    const engineBadge = data.storageEngine === 'sql'
        ? '🐘 SQL (RDBMS)'
        : data.storageEngine === 'mongodb'
            ? '🍃 MongoDB (NoSQL Document)'
            : data.storageEngine === 'redis'
                ? '🔴 Redis (Key-Value / Cache)'
                : data.storageEngine === 'elasticsearch'
                    ? '🔎 Elasticsearch (Search Engine)'
                    : data.storageEngine === 'vector'
                        ? '🧬 Vector DB (Embeddings)'
                        : data.storageEngine === 'timeseries'
                            ? '📈 Time Series (TSDB)'
                            : '🕸️ Graph DB';
    const lines = [
        `### 🔗 Contract ➔ Polyglot Storage Mapping: \`${data.contractEntity}\` ➔ ${engineBadge}`,
        `- **Contract Format**: \`${data.contractFormat.toUpperCase()}\` (\`${data.contractFile}\`)`,
        `- **Storage Target**: \`${data.storageContainer}\` (\`${data.storageFile}\`)`,
        `- **Mapped Attributes**: ${data.mappings.length} field(s)`,
        `- **Overall Compatibility**: **${data.overallCompatibility.toUpperCase()}**`,
        `\n> **Summary**: ${data.summary}\n`,
    ];
    if (data.mappings.length > 0) {
        lines.push('#### 📋 Field-Level Alignment Matrix:');
        lines.push('| Contract Field | Contract Type | Storage Attribute | Storage Type | Role | Status | Note |');
        lines.push('|---|---|---|---|---|---|---|');
        for (const m of data.mappings) {
            const statusBadge = m.typeStatus === 'compatible'
                ? '✅ Compatible'
                : m.typeStatus === 'conversion_required'
                    ? '🔄 Conversion'
                    : '⚠️ Discrepancy';
            lines.push(`| \`${m.contractField}\` | \`${m.contractType}\` | \`${m.storageAttribute}\` | \`${m.storageType}\` | ${m.role} | ${statusBadge} | ${m.note ?? '-'} |`);
        }
    }
    if (data.unmappedContractFields.length > 0) {
        lines.push('\n#### ⚠️ Unmapped Contract Fields (Not persisted in storage):');
        for (const f of data.unmappedContractFields) {
            lines.push(`- \`${f}\``);
        }
    }
    if (data.unmappedStorageAttributes.length > 0) {
        lines.push('\n#### 📦 Internal Storage Attributes (Not exposed in contract):');
        for (const a of data.unmappedStorageAttributes) {
            lines.push(`- \`${a}\``);
        }
    }
    return lines.join('\n');
}
export function renderStorageMigrationImpact(data) {
    const riskBadge = data.riskLevel === 'critical'
        ? '🔴 **CRITICAL RISK**'
        : data.riskLevel === 'high'
            ? '🟠 **HIGH RISK**'
            : data.riskLevel === 'medium'
                ? '🟡 **MEDIUM RISK**'
                : '🟢 **LOW RISK**';
    const lines = [
        `### 💥 Polyglot Storage Migration Blast Radius: \`${data.containerName}.${data.attributeName}\``,
        `- **Storage Engine**: \`${data.storageEngine.toUpperCase()}\``,
        `- **Planned Action**: \`${data.action.toUpperCase()}\``,
        `- **Risk Level**: ${riskBadge}`,
        `\n> **Summary**: ${data.summary}\n`,
    ];
    if (data.impactedContracts.length > 0) {
        lines.push('#### 📜 Impacted External Contracts (XML / JSON / gRPC):');
        for (const c of data.impactedContracts) {
            lines.push(`- [${c.format.toUpperCase()}] Entity **\`${c.entityName}\`** (\`${c.file}\`) ➔ Field \`${c.fieldName}\``);
        }
    }
    if (data.impactedCodeSymbols.length > 0) {
        lines.push('\n#### 💻 Impacted Code Queries & Symbols:');
        for (const s of data.impactedCodeSymbols) {
            lines.push(`- **\`${s.qname}\`** at \`${s.file}:${s.line}\``);
        }
    }
    if (data.recommendations.length > 0) {
        lines.push('\n#### 🛡️ Safe Migration Protocol:');
        for (const rec of data.recommendations) {
            lines.push(`- ${rec}`);
        }
    }
    return lines.join('\n');
}
