import test from 'node:test';
import assert from 'node:assert';
import { CodeParser } from '../lib/parser/code-parser.js';
import { DocParser } from '../lib/parser/doc-parser.js';

test('CodeParser correctly detects languages and test files', () => {
  assert.strictEqual(CodeParser.detectLanguage('src/app.ts'), 'typescript');
  assert.strictEqual(CodeParser.detectLanguage('scripts/deploy.py'), 'python');
  assert.strictEqual(CodeParser.detectLanguage('server/main.go'), 'go');
  assert.strictEqual(CodeParser.detectLanguage('engine/lib.rs'), 'rust');
  assert.strictEqual(CodeParser.detectLanguage('image.png'), null);

  assert.strictEqual(CodeParser.isTestFile('src/auth.test.ts'), true);
  assert.strictEqual(CodeParser.isTestFile('src/auth.spec.js'), true);
  assert.strictEqual(CodeParser.isTestFile('tests/unit.py'), true);
  assert.strictEqual(CodeParser.isTestFile('src/auth.ts'), false);
});

test('CodeParser extracts classes, methods, calls, and heritage from TypeScript', () => {
  const tsCode = `
import { BaseService } from './base';
import { ILogger } from './logger';

/**
 * User authentication service
 */
export class UserService extends BaseService implements ILogger {
  public async authenticate(username: string, passwordHash: string): Promise<boolean> {
    const valid = this.verifyHash(passwordHash);
    this.log('User authenticated');
    return valid;
  }

  private verifyHash(hash: string): boolean {
    return hash.length > 10;
  }

  public log(msg: string): void {
    console.log(msg);
  }
}

export function createUserService(): UserService {
  return new UserService();
}
  `;

  const parsed = CodeParser.parseFile('src/user.ts', tsCode);
  assert.ok(parsed, 'Parsed result should not be null');
  assert.strictEqual(parsed.symbols.length, 5);

  const cls = parsed.symbols.find((s) => s.kind === 'class');
  assert.ok(cls);
  assert.strictEqual(cls.name, 'UserService');
  assert.strictEqual(cls.isExported, true);

  const authMethod = parsed.symbols.find((s) => s.name === 'authenticate');
  assert.ok(authMethod);
  assert.strictEqual(authMethod.kind, 'method');
  assert.strictEqual(authMethod.qname, 'UserService.authenticate');

  // Verify heritage
  assert.strictEqual(parsed.heritage.length, 2);
  assert.strictEqual(parsed.heritage[0].superSymbolName, 'BaseService');
  assert.strictEqual(parsed.heritage[0].kind, 'extends');
  assert.strictEqual(parsed.heritage[1].superSymbolName, 'ILogger');
  assert.strictEqual(parsed.heritage[1].kind, 'implements');

  // Verify calls
  assert.ok(parsed.calls.some((c) => c.calleeName === 'verifyHash'));
  assert.ok(parsed.calls.some((c) => c.calleeName === 'log'));
});

test('DocParser extracts sections, rules, and referenced code symbols', () => {
  const markdown = `
# Architecture Decision Record: Authentication Architecture

Category: Security

## Overview
This document specifies how \`UserService\` interacts with the database.
All requests MUST use bearer token validation.

## Security Constraints
- **Rule**: Passwords MUST NEVER be stored in plain text.
- Developers SHOULD use \`verifyHash\` before database lookups.
- AVOID plain MD5 hashing.
  `;

  const parsed = DocParser.parseDoc('docs/adr/001-auth.md', markdown);
  assert.ok(parsed);
  assert.strictEqual(parsed.title, 'Architecture Decision Record: Authentication Architecture');
  assert.strictEqual(parsed.category, 'ADR');
  assert.strictEqual(parsed.sections.length, 3);

  // Check referenced symbols
  assert.ok(parsed.referencedSymbols.includes('UserService'));
  assert.ok(parsed.referencedSymbols.includes('verifyHash'));

  // Check rules
  assert.strictEqual(parsed.rules.length, 4);
  const mustRules = parsed.rules.filter((r) => r.priority === 'must');
  assert.ok(mustRules.length >= 2);
});
