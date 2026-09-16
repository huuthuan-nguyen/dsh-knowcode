import type { ContractEntityDef, ContractFieldDef, StorageContainerDef, StorageAttributeDef, StorageEngine } from '../types.js';
export declare class StorageParser {
    /**
     * Parse a Protocol Buffer file (*.proto)
     */
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
