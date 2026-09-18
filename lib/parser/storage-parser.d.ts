import type { ContractEntityDef, ContractFieldDef, StorageContainerDef, StorageAttributeDef, StorageEngine } from '../types.js';
export declare class StorageParser {
    /**
     * Parse a Protocol Buffer file (*.proto)
     */
    /**
     * Parse a Prisma schema (`schema.prisma`), the model definitions a project keeps
     * in source. The datasource provider decides the storage engine.
     */
    static parsePrismaSchema(file: string, content: string): StorageContainerDef[];
    /**
     * Parse a GraphQL SDL document into contract entities.
     *
     * Root operation types are skipped: `Query`/`Mutation`/`Subscription` describe the
     * API surface rather than a data shape.
     */
    static parseGraphqlSdl(file: string, content: string): ContractEntityDef[];
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
    static parseSchemaFile(file: string, content: string): {
        entities: ContractEntityDef[];
        containers: StorageContainerDef[];
    };
    static parseProtobuf(file: string, content: string): ContractEntityDef[];
    /**
     * Parse XML Schema Definition (*.xsd)
     */
    static parseXmlXsd(file: string, content: string): ContractEntityDef[];
    /**
     * Parse OpenAPI / JSON Schema definition
     */
    static parseOpenApiOrJsonSchema(file: string, content: string): ContractEntityDef[];
    /**
     * Parse SQL DDL (PostgreSQL, MySQL, SQLite)
     */
    static parseSqlDdl(file: string, content: string): StorageContainerDef[];
    /**
     * Parse MongoDB Mongoose or Document Collection definition
     */
    static parseMongoSchema(file: string, content: string): StorageContainerDef[];
    /**
     * Parse Elasticsearch mapping definition
     */
    static parseElasticMapping(file: string, content: string): StorageContainerDef[];
    /**
     * Normalizes names across conventions:
     * e.g. CustomerNumber -> customer_number, userId -> user_id
     */
    static normalizeIdentifier(name: string): string;
    /**
     * Calculate matching confidence and alignment between contract field and storage attribute
     */
    static matchFieldToAttribute(contractField: ContractFieldDef, storageAttr: StorageAttributeDef, engine: StorageEngine): {
        matched: boolean;
        confidence: number;
        rule: string;
        typeStatus: 'compatible' | 'discrepancy' | 'conversion_required';
        note?: string;
    };
}
