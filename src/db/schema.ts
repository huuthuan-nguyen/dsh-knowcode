import type { Graph } from 'falkordb';

export async function initGraphSchema(graph: Graph): Promise<void> {
  const indexStatements = [
    'CREATE INDEX FOR (s:Symbol) ON (s.name)',
    'CREATE INDEX FOR (s:Symbol) ON (s.qname)',
    'CREATE INDEX FOR (s:Symbol) ON (s.file)',
    'CREATE INDEX FOR (s:Symbol) ON (s.kind)',
    'CREATE INDEX FOR (f:File) ON (f.path)',
    'CREATE INDEX FOR (d:Document) ON (d.path)',
    'CREATE INDEX FOR (sec:DocSection) ON (sec.id)',
    'CREATE INDEX FOR (r:Rule) ON (r.id)',
    'CREATE INDEX FOR (s:Symbol) ON (s.structuralHash)',
  ];

  for (const stmt of indexStatements) {
    try {
      await graph.query(stmt);
    } catch {
      // index might already exist
    }
  }
}
