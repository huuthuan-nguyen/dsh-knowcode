import type { KnowCodeRepository } from '../db/client.js';

export class LinkEngine {
  constructor(private repo: KnowCodeRepository) {}

  /**
   * Run cross-linking passes in FalkorDB
   */
  public async linkAll(): Promise<{ linkedTests: number; linkedDocs: number }> {
    const linkedTests = await this.linkTestsToSources();
    const linkedDocs = await this.linkDocsToSymbols();
    return { linkedTests, linkedDocs };
  }

  /**
   * Link test files to tested files based on imports and naming
   */
  public async linkTestsToSources(): Promise<number> {
    // 1. Link via import: if a test file imports a non-test file, create TESTS_FOR
    const res1 = await this.repo.query(`
      MATCH (tf:File {isTest: true})-[:IMPORTS]->(sf:File {isTest: false})
      MERGE (tf)-[:TESTS_FOR]->(sf)
      RETURN count(*) AS cnt
    `);

    // 2. Link via naming conventions: foo.test.ts -> foo.ts, test_foo.py -> foo.py
    const res2 = await this.repo.query(`
      MATCH (tf:File {isTest: true}), (sf:File {isTest: false})
      WHERE tf.path CONTAINS replace(sf.path, '.ts', '.test.ts')
         OR tf.path CONTAINS replace(sf.path, '.js', '.test.js')
         OR tf.path CONTAINS replace(sf.path, '.go', '_test.go')
         OR tf.path CONTAINS replace(sf.path, '.py', '_test.py')
         OR tf.path CONTAINS ('test_' + sf.path)
      MERGE (tf)-[:TESTS_FOR]->(sf)
      RETURN count(*) AS cnt
    `);

    const cnt1 = res1.data?.[0]?.cnt ?? 0;
    const cnt2 = res2.data?.[0]?.cnt ?? 0;
    return cnt1 + cnt2;
  }

  /**
   * Link documentation sections to the code symbols they actually reference.
   *
   * Matching `sec.content CONTAINS sym.name` scanned prose for anything that looked
   * like an identifier, so a section saying "one line per phase" linked
   * `Tracer.line`, and ordinary words such as `start`, `call`, `clean`, `walk` and
   * `log` linked whatever symbols happened to share the name. Feature flows then
   * opened with entry points like `walk` and `clean`.
   *
   * `referencedSymbols` is computed by the document parser from real signals —
   * backticked identifiers, `name()` mentions and PascalCase names — and stored
   * comma-delimited, so containment tests whole names only.
   */
  public async linkDocsToSymbols(): Promise<number> {
    const res = await this.repo.query(`
      MATCH (sec:DocSection), (sym:Symbol)
      WHERE sec.referencedSymbols IS NOT NULL
        AND (sec.referencedSymbols CONTAINS (',' + sym.name + ',')
          OR sec.referencedSymbols CONTAINS (',' + sym.qname + ','))
      MERGE (sec)-[:DOCUMENTS]->(sym)
      RETURN count(*) AS cnt
    `);
    return res.data?.[0]?.cnt ?? 0;
  }
}
