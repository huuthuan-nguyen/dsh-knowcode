import test from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { FalkorDBManager } from '../lib/db/falkor-manager.js';
import { initGraphSchema } from '../lib/db/schema.js';
import { KnowCodeRepository } from '../lib/db/client.js';
import { StorageParser } from '../lib/parser/storage-parser.js';

const TEST_DIR = '/tmp/knowcode-polyglot-test';

test('StorageParser extracts Protobuf, XML XSD, SQL DDL and Mongo Schemas', () => {
  const protoContent = `
    syntax = "proto3";
    message UserProfile {
      string user_id = 1;
      string full_name = 2;
      string email = 3;
      repeated float embedding = 4;
    }
  `;
  const protoEntities = StorageParser.parseProtobuf('proto/user.proto', protoContent);
  assert.strictEqual(protoEntities.length, 1);
  assert.strictEqual(protoEntities[0].name, 'UserProfile');
  assert.strictEqual(protoEntities[0].fields.length, 4);

  const xsdContent = `
    <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
      <xs:complexType name="CustomerRecord">
        <xs:sequence>
          <xs:element name="CustomerNumber" type="xs:string"/>
          <xs:element name="Email" type="xs:string"/>
          <xs:element name="Balance" type="xs:decimal"/>
        </xs:sequence>
      </xs:complexType>
    </xs:schema>
  `;
  const xsdEntities = StorageParser.parseXmlXsd('schemas/customer.xsd', xsdContent);
  assert.strictEqual(xsdEntities.length, 1);
  assert.strictEqual(xsdEntities[0].name, 'CustomerRecord');
  assert.strictEqual(xsdEntities[0].fields.length, 3);

  const sqlContent = `
    CREATE TABLE users (
      id VARCHAR(36) PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  const sqlContainers = StorageParser.parseSqlDdl('schema.sql', sqlContent);
  assert.strictEqual(sqlContainers.length, 1);
  assert.strictEqual(sqlContainers[0].name, 'users');
  assert.strictEqual(sqlContainers[0].attributes.length, 4);
});

test('Polyglot Contract-to-Storage Mapping & Migration Impact in FalkorDB', async () => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }

  const mgr = new FalkorDBManager();
  const instance = await mgr.start({ dataDir: TEST_DIR, preferredPort: 48196 });
  const graph = instance.client.selectGraph('knowcode-polyglot');

  try {
    await initGraphSchema(graph);
    const repo = new KnowCodeRepository(graph);

    // 1. Ingest Contracts (Protobuf + XML XSD)
    await repo.ingestContractEntity({
      name: 'UserProfile',
      format: 'grpc_proto',
      file: 'proto/user.proto',
      fields: [
        { name: 'user_id', rawType: 'string', isRequired: true, isList: false, tagNumber: 1 },
        { name: 'full_name', rawType: 'string', isRequired: false, isList: false, tagNumber: 2 },
        { name: 'email', rawType: 'string', isRequired: true, isList: false, tagNumber: 3 },
        { name: 'embedding', rawType: 'float', isRequired: false, isList: true, tagNumber: 4 },
      ],
    });

    await repo.ingestContractEntity({
      name: 'CustomerRecord',
      format: 'xml_xsd',
      file: 'schemas/customer.xsd',
      fields: [
        { name: 'CustomerNumber', rawType: 'xs:string', isRequired: true, isList: false },
        { name: 'Email', rawType: 'xs:string', isRequired: true, isList: false },
        { name: 'Balance', rawType: 'xs:decimal', isRequired: false, isList: false },
      ],
    });

    // 2. Ingest Polyglot Storages (SQL + MongoDB + Vector DB)
    await repo.ingestStorageContainer({
      name: 'users',
      engine: 'sql',
      file: 'schema.sql',
      attributes: [
        { name: 'id', dataType: 'VARCHAR(36)', attributeRole: 'primary_key', isNullable: false },
        { name: 'full_name', dataType: 'VARCHAR(255)', attributeRole: 'column', isNullable: false },
        { name: 'email', dataType: 'VARCHAR(255)', attributeRole: 'column', isNullable: false },
      ],
    });

    await repo.ingestStorageContainer({
      name: 'customers',
      engine: 'mongodb',
      file: 'models/customer.js',
      attributes: [
        { name: '_id', dataType: 'ObjectId', attributeRole: 'id', isNullable: false },
        { name: 'customer_number', dataType: 'String', attributeRole: 'field', isNullable: false },
        { name: 'email', dataType: 'String', attributeRole: 'field', isNullable: false },
      ],
    });

    await repo.ingestStorageContainer({
      name: 'user_vectors',
      engine: 'vector',
      file: 'vectors/qdrant.json',
      attributes: [
        { name: 'user_id', dataType: 'String', attributeRole: 'payload', isNullable: false },
        { name: 'embedding', dataType: 'dense_vector', attributeRole: 'vector', isNullable: false, vectorDimension: 1536 },
      ],
    });

    // ====================================================
    // TEST 1: Map gRPC UserProfile -> SQL users
    // ====================================================
    const sqlMap = await repo.schemaMapContractToStorage('UserProfile', 'users', 'sql');
    assert.strictEqual(sqlMap.contractEntity, 'UserProfile');
    assert.strictEqual(sqlMap.storageContainer, 'users');
    assert.strictEqual(sqlMap.storageEngine, 'sql');
    assert.ok(sqlMap.mappings.some((m) => m.contractField === 'user_id' && m.storageAttribute === 'id'));
    assert.ok(sqlMap.mappings.some((m) => m.contractField === 'full_name' && m.storageAttribute === 'full_name'));
    assert.ok(sqlMap.mappings.some((m) => m.contractField === 'email' && m.storageAttribute === 'email'));

    // ====================================================
    // TEST 2: Map XML CustomerRecord -> MongoDB customers
    // ====================================================
    const mongoMap = await repo.schemaMapContractToStorage('CustomerRecord', 'customers', 'mongodb');
    assert.strictEqual(mongoMap.storageEngine, 'mongodb');
    assert.ok(mongoMap.mappings.some((m) => m.contractField === 'CustomerNumber' && m.storageAttribute === 'customer_number'));
    assert.ok(mongoMap.mappings.some((m) => m.contractField === 'Email' && m.storageAttribute === 'email'));

    // ====================================================
    // TEST 3: Map gRPC UserProfile -> Vector DB user_vectors
    // ====================================================
    const vectorMap = await repo.schemaMapContractToStorage('UserProfile', 'user_vectors', 'vector');
    assert.strictEqual(vectorMap.storageEngine, 'vector');
    const vecMapping = vectorMap.mappings.find((m) => m.contractField === 'embedding');
    assert.ok(vecMapping);
    assert.strictEqual(vecMapping.role, 'vector');
    assert.strictEqual(vecMapping.typeStatus, 'compatible');

    // ====================================================
    // TEST 4: Migration Blast Radius (dropping users.email)
    // ====================================================
    const blast = await repo.schemaAnalyzeStorageMigrationImpact('users', 'email', 'drop');
    assert.strictEqual(blast.containerName, 'users');
    assert.strictEqual(blast.attributeName, 'email');
    assert.strictEqual(blast.riskLevel, 'critical');
    // Both UserProfile and CustomerRecord have 'email' / 'Email'
    assert.ok(blast.impactedContracts.some((c) => c.entityName === 'UserProfile'));
    assert.ok(blast.recommendations.length >= 1);
  } finally {
    await mgr.stop();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }
});
