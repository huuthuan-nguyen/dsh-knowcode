export class LinkEngine {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    /**
     * Run cross-linking passes in FalkorDB
     */
    async linkAll() {
        const linkedTests = await this.linkTestsToSources();
        const linkedDocs = await this.linkDocsToSymbols();
        return { linkedTests, linkedDocs };
    }
    /**
     * Link test files to tested files based on imports and naming
     */
    async linkTestsToSources() {
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
     * Link documentation sections to code symbols mentioned in text
     */
    async linkDocsToSymbols() {
        const res = await this.repo.query(`
      MATCH (sec:DocSection), (sym:Symbol)
      WHERE size(sym.name) >= 3 AND sec.content CONTAINS sym.name
      MERGE (sec)-[:DOCUMENTS]->(sym)
      RETURN count(*) AS cnt
    `);
        return res.data?.[0]?.cnt ?? 0;
    }
}
