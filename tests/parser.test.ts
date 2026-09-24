import test from 'node:test';
import assert from 'node:assert';
import { CodeParser } from '../lib/parser/code-parser.js';
import { DocParser } from '../lib/parser/doc-parser.js';
import { TreeSitterEngine } from '../lib/parser/tree-sitter.js';

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

test('TreeSitterEngine parses Python with AST symbols, heritage and calls', () => {
  assert.strictEqual(TreeSitterEngine.isReady(), true);

  const pyCode = `
from base import BaseController

class UserController(BaseController):
    """Handles user operations"""
    def get_profile(self, user_id):
        self.log_access(user_id)
        return self.find_user(user_id)

def create_controller():
    return UserController()
  `;

  const parsed = CodeParser.parseFile('controllers/user.py', pyCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'python');
  assert.strictEqual(parsed.symbols.length, 3);

  const cls = parsed.symbols.find((s) => s.name === 'UserController')!;
  assert.ok(cls);
  assert.strictEqual(cls.kind, 'class');
  assert.strictEqual(cls.docstring, 'Handles user operations');

  assert.strictEqual(parsed.heritage.length, 1);
  assert.strictEqual(parsed.heritage[0].superSymbolName, 'BaseController');
  assert.strictEqual(parsed.heritage[0].kind, 'extends');

  const method = parsed.symbols.find((s) => s.name === 'get_profile')!;
  assert.ok(method);
  assert.strictEqual(method.kind, 'method');
  assert.strictEqual(method.qname, 'UserController.get_profile');

  assert.ok(parsed.calls.some((c) => c.calleeName === 'log_access'));
  assert.ok(parsed.calls.some((c) => c.calleeName === 'find_user'));
});

test('TreeSitterEngine parses Go with AST structs, methods and calls', () => {
  const goCode = `
package service

import "fmt"

type Service struct {
    name string
}

func (s *Service) Execute(cmd string) error {
    fmt.Println(cmd)
    return nil
}

func NewService(name string) *Service {
    return &Service{name: name}
}
  `;

  const parsed = CodeParser.parseFile('service/main.go', goCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'go');

  const structSym = parsed.symbols.find((s) => s.name === 'Service')!;
  assert.ok(structSym);
  assert.strictEqual(structSym.kind, 'struct');

  const method = parsed.symbols.find((s) => s.name === 'Execute')!;
  assert.ok(method);
  assert.strictEqual(method.kind, 'method');
  assert.strictEqual(method.qname, 'Service.Execute');

  assert.ok(parsed.calls.some((c) => c.calleeName === 'Println'));
});

test('TreeSitterEngine parses Rust with AST traits, structs, impl and calls', () => {
  const rsCode = `
use std::io;

pub struct Engine {
    pub id: u32,
}

pub trait Runner {
    fn run(&self);
}

impl Runner for Engine {
    fn run(&self) {
        self.step();
    }
}

pub fn start() {
    let e = Engine { id: 1 };
    e.run();
}
  `;

  const parsed = CodeParser.parseFile('src/lib.rs', rsCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'rust');

  const structSym = parsed.symbols.find((s) => s.name === 'Engine')!;
  assert.ok(structSym);
  assert.strictEqual(structSym.kind, 'struct');

  const traitSym = parsed.symbols.find((s) => s.name === 'Runner')!;
  assert.ok(traitSym);
  assert.strictEqual(traitSym.kind, 'trait');

  assert.strictEqual(parsed.heritage.length, 1);
  assert.strictEqual(parsed.heritage[0].superSymbolName, 'Runner');
  assert.strictEqual(parsed.heritage[0].kind, 'implements');

  const method = parsed.symbols.find((s) => s.name === 'run')!;
  assert.ok(method);
  assert.strictEqual(method.kind, 'method');
  assert.strictEqual(method.qname, 'Engine.run');
});

test('TreeSitterEngine parses C++ with AST classes, functions and calls', () => {
  const cppCode = `
#include "engine.h"

class Processor {
public:
    void process() {
        compute();
    }
};

int main() {
    Processor p;
    p.process();
    return 0;
}
  `;

  const parsed = CodeParser.parseFile('src/main.cpp', cppCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'cpp');

  const cls = parsed.symbols.find((s) => s.name === 'Processor')!;
  assert.ok(cls);
  assert.strictEqual(cls.kind, 'class');

  const method = parsed.symbols.find((s) => s.name === 'process')!;
  assert.ok(method);
  assert.strictEqual(method.kind, 'method');
  assert.strictEqual(method.qname, 'Processor.process');

  assert.ok(parsed.calls.some((c) => c.calleeName === 'compute'));
  assert.ok(parsed.calls.some((c) => c.calleeName === 'process'));
});

test('TreeSitterEngine parses C# with classes, heritage, methods and calls', async () => {
  await TreeSitterEngine.ensureLanguage('c_sharp');

  const csCode = `
using System;
using System.Threading.Tasks;

namespace MyApp.Services {
    public interface IPaymentService {
        Task<bool> Charge(decimal amount);
    }

    public class StripePaymentService : BaseService, IPaymentService {
        private readonly ILogger logger;

        public async Task<bool> Charge(decimal amount) {
            this.logger.Info("Starting charge");
            return await ExecuteCharge(amount);
        }
    }
}
  `;

  const parsed = await CodeParser.parseFileAsync('services/Payment.cs', csCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'c_sharp');

  const iface = parsed.symbols.find((s) => s.name === 'IPaymentService')!;
  assert.ok(iface);
  assert.strictEqual(iface.kind, 'interface');

  const cls = parsed.symbols.find((s) => s.name === 'StripePaymentService')!;
  assert.ok(cls);
  assert.strictEqual(cls.kind, 'class');

  // Verify heritage
  assert.ok(parsed.heritage.some((h) => h.superSymbolName === 'BaseService'));
  assert.ok(parsed.heritage.some((h) => h.superSymbolName === 'IPaymentService'));

  const method = parsed.symbols.find((s) => s.name === 'Charge' && s.kind === 'method')!;
  assert.ok(method);

  assert.ok(parsed.calls.some((c) => c.calleeName === 'Info' || c.calleeName === 'ExecuteCharge'));
});

test('TreeSitterEngine parses Ruby with modules, classes, methods and calls', async () => {
  await TreeSitterEngine.ensureLanguage('ruby');

  const rbCode = `
require 'net/http'

module Billing
  class InvoiceService < BaseService
    def process_invoice(invoice_id)
      validate_invoice(invoice_id)
      send_receipt(invoice_id)
    end
  end
end
  `;

  const parsed = await CodeParser.parseFileAsync('app/services/invoice_service.rb', rbCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'ruby');

  const mod = parsed.symbols.find((s) => s.name === 'Billing')!;
  assert.ok(mod);
  assert.strictEqual(mod.kind, 'module');

  const cls = parsed.symbols.find((s) => s.name === 'InvoiceService')!;
  assert.ok(cls);
  assert.strictEqual(cls.kind, 'class');

  assert.strictEqual(parsed.heritage.length, 1);
  assert.strictEqual(parsed.heritage[0].superSymbolName, 'BaseService');

  const method = parsed.symbols.find((s) => s.name === 'process_invoice')!;
  assert.ok(method);
  assert.strictEqual(method.kind, 'method');
  assert.strictEqual(method.qname, 'Billing.InvoiceService.process_invoice');

  assert.ok(parsed.calls.some((c) => c.calleeName === 'validate_invoice'));
  assert.ok(parsed.calls.some((c) => c.calleeName === 'send_receipt'));
});

test('TreeSitterEngine parses PHP with namespaces, classes, interfaces and calls', async () => {
  await TreeSitterEngine.ensureLanguage('php');

  const phpCode = `<?php
namespace App\\Domain;

use App\\Infrastructure\\BaseRepository;
use App\\Contracts\\UserRepositoryInterface;

class UserRepository extends BaseRepository implements UserRepositoryInterface {
    public function findById(int $id) {
        $this->connect();
        return $this->query($id);
    }
}
  `;

  const parsed = await CodeParser.parseFileAsync('src/Domain/UserRepository.php', phpCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'php');

  const cls = parsed.symbols.find((s) => s.name === 'UserRepository')!;
  assert.ok(cls);
  assert.strictEqual(cls.kind, 'class');

  assert.ok(parsed.heritage.some((h) => h.superSymbolName === 'BaseRepository'));
  assert.ok(parsed.heritage.some((h) => h.superSymbolName === 'UserRepositoryInterface'));

  const method = parsed.symbols.find((s) => s.name === 'findById')!;
  assert.ok(method);
  assert.strictEqual(method.kind, 'method');

  assert.ok(parsed.calls.some((c) => c.calleeName === 'connect' || c.calleeName === 'query'));
});

test('TreeSitterEngine parses Kotlin with classes, delegation and functions', async () => {
  await TreeSitterEngine.ensureLanguage('kotlin');

  const ktCode = `
package com.app.orders

open class BaseOrderHandler
interface IOrderNotification

class OrderProcessor : BaseOrderHandler(), IOrderNotification {
    fun process(orderId: String) {
        notifyCustomer(orderId)
    }
}
  `;

  const parsed = await CodeParser.parseFileAsync('src/OrderProcessor.kt', ktCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'kotlin');

  const cls = parsed.symbols.find((s) => s.name === 'OrderProcessor')!;
  assert.ok(cls);
  assert.strictEqual(cls.kind, 'class');

  assert.ok(parsed.heritage.some((h) => h.superSymbolName === 'BaseOrderHandler'));
  assert.ok(parsed.heritage.some((h) => h.superSymbolName === 'IOrderNotification'));

  const fn = parsed.symbols.find((s) => s.name === 'process')!;
  assert.ok(fn);
  assert.strictEqual(fn.kind, 'method');
  assert.strictEqual(fn.qname, 'OrderProcessor.process');
});

test('TreeSitterEngine parses Solidity with contracts, functions and inheritance', async () => {
  await TreeSitterEngine.ensureLanguage('solidity');

  const solCode = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Ownable.sol";

contract TokenVault is Ownable {
    function withdraw(uint256 amount) public onlyOwner {
        transferFunds(amount);
    }
}
  `;

  const parsed = await CodeParser.parseFileAsync('contracts/Vault.sol', solCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.language, 'solidity');

  const contract = parsed.symbols.find((s) => s.name === 'TokenVault')!;
  assert.ok(contract);
  assert.strictEqual(contract.kind, 'class');

  assert.strictEqual(parsed.heritage.length, 1);
  assert.strictEqual(parsed.heritage[0].superSymbolName, 'Ownable');

  const fn = parsed.symbols.find((s) => s.name === 'withdraw')!;
  assert.ok(fn);
  assert.strictEqual(fn.kind, 'method');
  assert.strictEqual(fn.qname, 'TokenVault.withdraw');
});

test('TreeSitterEngine parses Lua and Zig code files', async () => {
  await TreeSitterEngine.ensureLanguages(['lua', 'zig']);

  const luaCode = `
function calculate_score(points)
    local total = apply_bonus(points)
    return total
end
  `;
  const parsedLua = await CodeParser.parseFileAsync('scripts/score.lua', luaCode);
  assert.ok(parsedLua);
  assert.strictEqual(parsedLua.language, 'lua');
  const luaFn = parsedLua.symbols.find((s) => s.name === 'calculate_score')!;
  assert.ok(luaFn);
  assert.strictEqual(luaFn.kind, 'function');

  const zigCode = `
pub fn computeTotal(a: u32, b: u32) u32 {
    return add(a, b);
}
  `;
  const parsedZig = await CodeParser.parseFileAsync('src/math.zig', zigCode);
  assert.ok(parsedZig);
  assert.strictEqual(parsedZig.language, 'zig');
  const zigFn = parsedZig.symbols.find((s) => s.name === 'computeTotal')!;
  assert.ok(zigFn);
  assert.strictEqual(zigFn.kind, 'function');
});

test('TreeSitterEngine supports dynamic grammar and custom extension registration', async () => {
  // Test registering a custom extension mapping
  TreeSitterEngine.registerExtension('.pycustom', 'python');
  assert.strictEqual(CodeParser.detectLanguage('scripts/workflow.pycustom'), 'python');

  const pyCode = 'def custom_task():\n    return 42\n';
  const parsed = CodeParser.parseFile('scripts/workflow.pycustom', pyCode);
  assert.ok(parsed);
  assert.strictEqual(parsed.symbols.length, 1);
  assert.strictEqual(parsed.symbols[0].name, 'custom_task');
});
