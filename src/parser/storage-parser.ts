import type {
  ContractEntityDef,
  ContractFieldDef,
  ContractFormat,
  StorageContainerDef,
  StorageAttributeDef,
  StorageEngine,
  FieldStorageMapping,
} from '../types.js';

export class StorageParser {
  /**
   * Parse a Protocol Buffer file (*.proto)
   */
  /**
   * Parse a Prisma schema (`schema.prisma`), the model definitions a project keeps
   * in source. The datasource provider decides the storage engine.
   */
  public static parsePrismaSchema(file: string, content: string): StorageContainerDef[] {
    const containers: StorageContainerDef[] = [];

    const providerMatch = content.match(/datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s);
    const provider = (providerMatch?.[1] ?? 'sql').toLowerCase();
    const engine: StorageEngine =
      provider.includes('mongo')
        ? 'mongodb'
        : provider.includes('postgres') || provider.includes('mysql') || provider.includes('sqlite') || provider.includes('sqlserver')
        ? 'sql'
        : 'sql';

    const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;
    let model: RegExpExecArray | null;
    while ((model = modelRe.exec(content)) !== null) {
      const name = model[1];
      const attributes: StorageAttributeDef[] = [];

      for (const raw of model[2].split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('//') || line.startsWith('@@')) continue;

        const field = line.match(/^(\w+)\s+([\w\[\]?]+)(.*)$/);
        if (!field) continue;

        const rawType = field[2];
        const modifiers = field[3] ?? '';
        attributes.push({
          name: field[1],
          dataType: rawType,
          attributeRole: /@id\b/.test(modifiers)
            ? 'primary_key'
            : /@relation\b/.test(modifiers)
            ? 'foreign_key'
            : 'column',
          isNullable: rawType.endsWith('?'),
        });
      }

      if (attributes.length > 0) {
        containers.push({
          name,
          engine,
          file,
          attributes,
          description: `Prisma model '${name}' (provider: ${provider})`,
        });
      }
    }

    return containers;
  }

  /**
   * Parse a GraphQL SDL document into contract entities.
   *
   * Root operation types are skipped: `Query`/`Mutation`/`Subscription` describe the
   * API surface rather than a data shape.
   */
  public static parseGraphqlSdl(file: string, content: string): ContractEntityDef[] {
    const entities: ContractEntityDef[] = [];
    const typeRe = /(?:^|\n)\s*(?:type|input|interface)\s+(\w+)[^{\n]*\{([\s\S]*?)\}/g;

    let type: RegExpExecArray | null;
    while ((type = typeRe.exec(content)) !== null) {
      const name = type[1];
      if (['Query', 'Mutation', 'Subscription'].includes(name)) continue;

      const fields: ContractFieldDef[] = [];
      for (const raw of type[2].split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('}')) continue;

        const field = line.match(/^(\w+)\s*(?:\([^)]*\))?\s*:\s*([\[\]!\w]+)/);
        if (!field) continue;

        const rawType = field[2];
        fields.push({
          name: field[1],
          rawType,
          isRequired: rawType.endsWith('!'),
          isList: rawType.startsWith('['),
        });
      }

      if (fields.length > 0) {
        entities.push({
          name,
          format: 'graphql_sdl',
          file,
          fields,
          description: `GraphQL SDL type '${name}'`,
        });
      }
    }

    return entities;
  }

  /**
   * Parse a schema or DDL file **from the repository**.
   *
   * The graph is never populated from a live database: this only ever receives text
   * read from a tracked file — a migration, a `.proto` contract, a Prisma schema, an
   * OpenAPI document or an Elasticsearch mapping held in source. A running MySQL,
   * MongoDB, Redis or Elasticsearch instance is never contacted, and its data files
   * are rejected before being read at all (see `indexable.ts`).
   *
   * @param file - workspace-relative path, used to choose the dialect and recorded on the nodes.
   * @param content - the file's text.
   * @returns contract entities and storage containers found in that file.
   */
  public static parseSchemaFile(
    file: string,
    content: string
  ): { entities: ContractEntityDef[]; containers: StorageContainerDef[] } {
    const lower = file.toLowerCase();
    const empty = { entities: [], containers: [] };

    try {
      if (lower.endsWith('.proto')) {
        return { entities: StorageParser.parseProtobuf(file, content), containers: [] };
      }
      if (lower.endsWith('.xsd') || lower.endsWith('.xml')) {
        return { entities: StorageParser.parseXmlXsd(file, content), containers: [] };
      }
      if (lower.endsWith('.sql') || lower.endsWith('.cql')) {
        return { entities: [], containers: StorageParser.parseSqlDdl(file, content) };
      }
      if (lower.endsWith('.prisma')) {
        return { entities: [], containers: StorageParser.parsePrismaSchema(file, content) };
      }
      if (lower.endsWith('.graphql') || lower.endsWith('.gql')) {
        return { entities: StorageParser.parseGraphqlSdl(file, content), containers: [] };
      }
      if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        // An OpenAPI/JSON-Schema document describes a contract; an Elasticsearch
        // mapping describes storage. Try both — each parser is tolerant of the other.
        return {
          entities: StorageParser.parseOpenApiOrJsonSchema(file, content),
          containers: StorageParser.parseElasticMapping(file, content),
        };
      }
    } catch {
      // A malformed schema must not abort indexing of the rest of the workspace.
      return empty;
    }

    return empty;
  }

  public static parseProtobuf(file: string, content: string): ContractEntityDef[] {
    const entities: ContractEntityDef[] = [];
    const messageRegex = /message\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}/g;

    let match: RegExpExecArray | null;
    while ((match = messageRegex.exec(content)) !== null) {
      const messageName = match[1];
      const body = match[2];
      const fields: ContractFieldDef[] = [];

      const fieldLines = body.split('\n');
      for (const line of fieldLines) {
        const trimmed = line.replace(/\/\/.*$/, '').trim();
        if (!trimmed || trimmed.startsWith('//')) continue;

        // e.g. optional string email = 1; or repeated int64 item_ids = 2;
        const fieldMatch = trimmed.match(
          /^(?:(required|optional|repeated)\s+)?([A-Za-z0-9_.]+)\s+([A-Za-z0-9_]+)\s*=\s*(\d+)/
        );

        if (fieldMatch) {
          const modifier = fieldMatch[1] ?? 'optional';
          const rawType = fieldMatch[2];
          const name = fieldMatch[3];
          const tagNumber = parseInt(fieldMatch[4], 10);

          fields.push({
            name,
            rawType,
            isRequired: modifier === 'required',
            isList: modifier === 'repeated',
            tagNumber,
          });
        }
      }

      entities.push({
        name: messageName,
        format: 'grpc_proto',
        file,
        fields,
        description: `Protobuf message '${messageName}' with ${fields.length} fields`,
      });
    }

    return entities;
  }

  /**
   * Parse XML Schema Definition (*.xsd)
   */
  public static parseXmlXsd(file: string, content: string): ContractEntityDef[] {
    const entities: ContractEntityDef[] = [];

    // ComplexType matching
    const complexTypeRegex = /<xs:complexType\s+name="([A-Za-z0-9_]+)"[\s\S]*?>([\s\S]*?)<\/xs:complexType>/g;
    let match: RegExpExecArray | null;

    while ((match = complexTypeRegex.exec(content)) !== null) {
      const typeName = match[1];
      const body = match[2];
      const fields: ContractFieldDef[] = [];

      const elemMatches = body.matchAll(
        /<xs:element\s+name="([A-Za-z0-9_]+)"(?:\s+type="([A-Za-z0-9_:]+)")?(?:[^>]*?(?:minOccurs="(\d+)")?)?(?:[^>]*?(?:maxOccurs="([^"]+)")?)?[^>]*\/>/g
      );

      for (const em of elemMatches) {
        const fieldName = em[1];
        const rawType = em[2] ?? 'xs:string';
        const minOccurs = em[3] ? parseInt(em[3], 10) : 1;
        const maxOccurs = em[4] ?? '1';

        fields.push({
          name: fieldName,
          rawType,
          isRequired: minOccurs > 0,
          isList: maxOccurs === 'unbounded' || parseInt(maxOccurs, 10) > 1,
          namespace: 'xs',
        });
      }

      entities.push({
        name: typeName,
        format: 'xml_xsd',
        file,
        fields,
        description: `XML XSD ComplexType '${typeName}' with ${fields.length} elements`,
      });
    }

    return entities;
  }

  /**
   * Parse OpenAPI / JSON Schema definition
   */
  public static parseOpenApiOrJsonSchema(file: string, content: string): ContractEntityDef[] {
    const entities: ContractEntityDef[] = [];

    try {
      const parsed = JSON.parse(content);
      const schemas = parsed.components?.schemas ?? parsed.definitions ?? (parsed.properties ? { [parsed.title ?? 'Root']: parsed } : {});

      for (const [schemaName, schemaObj] of Object.entries<any>(schemas)) {
        if (!schemaObj || typeof schemaObj !== 'object') continue;
        const properties = schemaObj.properties ?? {};
        const requiredList = new Set<string>(Array.isArray(schemaObj.required) ? schemaObj.required : []);

        const fields: ContractFieldDef[] = [];
        for (const [propName, propDef] of Object.entries<any>(properties)) {
          const rawType = propDef.type ?? (propDef.$ref ? propDef.$ref.split('/').pop() : 'object');
          fields.push({
            name: propName,
            rawType,
            isRequired: requiredList.has(propName),
            isList: rawType === 'array',
          });
        }

        entities.push({
          name: schemaName,
          format: file.endsWith('.json') ? 'openapi_json' : 'openapi_yaml',
          file,
          fields,
          description: schemaObj.description ?? `OpenAPI/JSON Schema '${schemaName}'`,
        });
      }
    } catch {
      // Not raw JSON, might be handled by YAML or simplified regex if needed
    }

    return entities;
  }

  /**
   * Parse SQL DDL (PostgreSQL, MySQL, SQLite)
   */
  public static parseSqlDdl(file: string, content: string): StorageContainerDef[] {
    const containers: StorageContainerDef[] = [];
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_"`.]+)\s*\(([\s\S]*?)\);/gi;

    let match: RegExpExecArray | null;
    while ((match = tableRegex.exec(content)) !== null) {
      const rawTableName = match[1].replace(/["`]/g, '').split('.').pop()!;
      const body = match[2];
      const attributes: StorageAttributeDef[] = [];

      const lines = body.split('\n');
      for (const line of lines) {
        const trimmed = line.replace(/--.*$/, '').trim();
        if (!trimmed || trimmed.startsWith('--') || trimmed.toUpperCase().startsWith('CONSTRAINT') || trimmed.toUpperCase().startsWith('PRIMARY KEY (')) {
          continue;
        }

        const colMatch = trimmed.match(/^([A-Za-z0-9_"`]+)\s+([A-Za-z0-9_]+(?:\([0-9, ]+\))?)([\s\S]*)$/);
        if (colMatch) {
          const colName = colMatch[1].replace(/["`]/g, '');
          const dataType = colMatch[2].toUpperCase();
          const rest = colMatch[3].toUpperCase();

          const isPrimaryKey = rest.includes('PRIMARY KEY');
          const isNullable = !rest.includes('NOT NULL') && !isPrimaryKey;

          attributes.push({
            name: colName,
            dataType,
            attributeRole: isPrimaryKey ? 'primary_key' : 'column',
            isNullable,
          });
        }
      }

      containers.push({
        name: rawTableName,
        engine: 'sql',
        file,
        attributes,
        description: `SQL Table '${rawTableName}' with ${attributes.length} columns`,
      });
    }

    return containers;
  }

  /**
   * Parse MongoDB Mongoose or Document Collection definition
   */
  public static parseMongoSchema(file: string, content: string): StorageContainerDef[] {
    const containers: StorageContainerDef[] = [];
    const schemaRegex = /(?:const|let|var)\s+([A-Za-z0-9_]+Schema)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(\{([\s\S]*?)\}\s*(?:,|\))/g;

    let match: RegExpExecArray | null;
    while ((match = schemaRegex.exec(content)) !== null) {
      const schemaVar = match[1];
      const body = match[2];
      const collectionName = schemaVar.replace(/Schema$/, '').toLowerCase() + 's';
      const attributes: StorageAttributeDef[] = [
        {
          name: '_id',
          dataType: 'ObjectId',
          attributeRole: 'id',
          isNullable: false,
        },
      ];

      const propRegex = /([A-Za-z0-9_]+)\s*:\s*\{?([^,}\n]+)/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = propRegex.exec(body)) !== null) {
        const propName = pMatch[1];
        if (propName === 'type' || propName === 'required') continue;
        const typeRaw = pMatch[2].replace(/type\s*:\s*/, '').trim();

        attributes.push({
          name: propName,
          dataType: typeRaw.includes('String') ? 'String' : typeRaw.includes('Number') ? 'Number' : typeRaw.includes('Boolean') ? 'Boolean' : typeRaw.includes('Date') ? 'Date' : 'Mixed',
          attributeRole: 'field',
          isNullable: !pMatch[2].includes('required: true'),
        });
      }

      containers.push({
        name: collectionName,
        engine: 'mongodb',
        file,
        attributes,
        description: `MongoDB Collection '${collectionName}' with ${attributes.length} fields`,
      });
    }

    return containers;
  }

  /**
   * Parse Elasticsearch mapping definition
   */
  public static parseElasticMapping(file: string, content: string): StorageContainerDef[] {
    const containers: StorageContainerDef[] = [];

    try {
      const parsed = JSON.parse(content);

      // A mapping is an object nested under `mappings`, or a root `properties` in a
      // file whose name says so. Anything else — an OpenAPI document, a package
      // manifest — is not an index, and previously still produced an empty container
      // named after the file.
      const looksLikeMapping = /mapping/i.test(file);
      const properties =
        parsed.mappings?.properties ?? (looksLikeMapping ? parsed.properties : undefined);

      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        return containers;
      }

      const indexName = file.replace(/.*\/|\.mapping\.json|\.json/g, '') || 'index';

      const attributes: StorageAttributeDef[] = [];
      for (const [propName, propDef] of Object.entries<any>(properties)) {
        attributes.push({
          name: propName,
          dataType: propDef.type ?? 'text',
          attributeRole: propDef.type === 'dense_vector' ? 'vector' : propDef.type === 'keyword' ? 'keyword' : 'text',
          isNullable: true,
          vectorDimension: propDef.dims,
        });
      }

      if (attributes.length === 0) return containers;

      containers.push({
        name: indexName,
        engine: 'elasticsearch',
        file,
        attributes,
        description: `Elasticsearch Index '${indexName}' with ${attributes.length} properties`,
      });
    } catch {
      // Non-JSON
    }

    return containers;
  }

  /**
   * Normalizes names across conventions:
   * e.g. CustomerNumber -> customer_number, userId -> user_id
   */
  public static normalizeIdentifier(name: string): string {
    return name
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[-\s]/g, '_')
      .toLowerCase();
  }

  /**
   * Calculate matching confidence and alignment between contract field and storage attribute
   */
  public static matchFieldToAttribute(
    contractField: ContractFieldDef,
    storageAttr: StorageAttributeDef,
    engine: StorageEngine
  ): {
    matched: boolean;
    confidence: number;
    rule: string;
    typeStatus: 'compatible' | 'discrepancy' | 'conversion_required';
    note?: string;
  } {
    const cName = contractField.name;
    const sName = storageAttr.name;

    const normC = StorageParser.normalizeIdentifier(cName);
    const normS = StorageParser.normalizeIdentifier(sName);

    let confidence = 0;
    let rule = '';

    if (cName === sName) {
      confidence = 1.0;
      rule = 'exact_name';
    } else if (normC === normS) {
      confidence = 0.95;
      rule = 'case_normalized';
    } else if (
      (normC === 'id' && normS.endsWith('_id')) ||
      (normS === 'id' && normC.endsWith('_id')) ||
      (normS === '_id' && normC.endsWith('id')) ||
      (normS === '_id' && normC === 'id')
    ) {
      confidence = 0.90;
      rule = 'identifier_convention';
    } else if (normC.includes(normS) || normS.includes(normC)) {
      confidence = 0.70;
      rule = 'substring_heuristic';
    }

    if (confidence < 0.70) {
      return { matched: false, confidence: 0, rule: 'none', typeStatus: 'discrepancy' };
    }

    // Evaluate Type Compatibility
    const cType = contractField.rawType.toLowerCase();
    const sType = storageAttr.dataType.toLowerCase();
    let typeStatus: 'compatible' | 'discrepancy' | 'conversion_required' = 'compatible';
    let note = '';

    if (engine === 'mongodb' && sName === '_id') {
      typeStatus = 'conversion_required';
      note = 'UUID/String requires BSON ObjectId serialization conversion';
    } else if (engine === 'vector' || storageAttr.attributeRole === 'vector') {
      if (cType.includes('float') || cType.includes('array') || cType.includes('vector')) {
        typeStatus = 'compatible';
        note = `Dense vector embedding aligned (${storageAttr.vectorDimension ?? 1536} dims)`;
      } else {
        typeStatus = 'conversion_required';
        note = 'Text requires embedding inference model to project into vector space';
      }
    } else if (cType.includes('int') && sType.includes('bigint')) {
      typeStatus = 'compatible';
      note = 'Int32 expands safely into 64-bit BigInt';
    } else if (cType.includes('int') && sType.includes('smallint')) {
      typeStatus = 'discrepancy';
      note = 'SQL SmallInt is limited to 32,767 values; risk of numeric overflow';
    } else if (cType.includes('string') && sType.includes('varchar')) {
      typeStatus = 'compatible';
    } else if (cType.includes('bool') && (sType.includes('bool') || sType.includes('tinyint'))) {
      typeStatus = 'compatible';
    }

    return {
      matched: true,
      confidence,
      rule,
      typeStatus,
      note,
    };
  }
}
