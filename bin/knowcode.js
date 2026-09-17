#!/usr/bin/env node

import { Command } from 'commander';
import { runIndexCommand } from '../lib/cli/index-cmd.js';
import { runServeCommand } from '../lib/cli/serve-cmd.js';
import { runStatusCommand } from '../lib/cli/status-cmd.js';
import { runQueryCommand } from '../lib/cli/query-cmd.js';
import { KnowCodeRpcClient } from '../lib/server/client-rpc.js';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const program = new Command();

program
  .name('knowcode')
  .description('Embedded FalkorDB Code Graph & Knowledge Base for DeepSeek Harness')
  .version(pkg.version);

program
  .command('index [dir]')
  .description('Index codebase and documentation into FalkorDB graph')
  .option('-p, --port <number>', 'Daemon port', (v) => parseInt(v, 10))
  .option('-d, --data-dir <path>', 'Data directory', '.knowcode')
  .option('-t, --trace', 'Emit tgrep-style [trace] logs to stderr')
  .action(async (dir = '.', options) => {
    try {
      await runIndexCommand(dir, options);
    } catch (err) {
      console.error('[KnowCode Index Error]:', err);
      process.exit(1);
    }
  });

program
  .command('serve [dir]')
  .description('Start background daemon with live file watcher and incremental re-indexing')
  .option('-p, --port <number>', 'Daemon port', (v) => parseInt(v, 10), 48123)
  .option('-d, --data-dir <path>', 'Data directory', '.knowcode')
  .option('-t, --trace', 'Emit tgrep-style [trace] logs to stderr')
  .option('-f, --force-index', 'Skip the stale check and always run a full re-index')
  .action(async (dir = '.', options) => {
    try {
      await runServeCommand(dir, options);
    } catch (err) {
      console.error('[KnowCode Serve Error]:', err);
      process.exit(1);
    }
  });

program
  .command('status [dir]')
  .description('Check index health, file statistics, and daemon status')
  .option('-p, --port <number>', 'Daemon port', (v) => parseInt(v, 10))
  .action(async (dir = '.', options) => {
    try {
      await runStatusCommand(dir, options);
    } catch (err) {
      console.error('[KnowCode Status Error]:', err);
      process.exit(1);
    }
  });

program
  .command('query <cypher>')
  .description('Execute raw Cypher query against FalkorDB code graph')
  .option('-p, --port <number>', 'Daemon port', (v) => parseInt(v, 10))
  .option('-d, --dir <path>', 'Target directory', '.')
  .action(async (cypher, options) => {
    try {
      await runQueryCommand(cypher, options.dir, options);
    } catch (err) {
      console.error('[KnowCode Query Error]:', err);
      process.exit(1);
    }
  });

program
  .command('stop [dir]')
  .description('Stop running KnowCode daemon')
  .option('-p, --port <number>', 'Daemon port', (v) => parseInt(v, 10))
  .action(async (dir = '.', options) => {
    const workdir = resolve(dir);
    const client = new KnowCodeRpcClient({ workdir, port: options.port });
    try {
      await client.shutdown();
      console.log('[KnowCode] Sent shutdown signal to daemon.');
    } catch (err) {
      console.error('[KnowCode Stop Error]:', err);
    }
  });

program.parse(process.argv);
