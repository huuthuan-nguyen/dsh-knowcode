import { readdirSync, existsSync, symlinkSync, rmSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const officialHarness = '/Users/kean/Projects/deepseek-harness';
const targetDir = resolve('node_modules/@deepseek-ai');

if (!existsSync(officialHarness)) {
  console.log('Official harness not found at:', officialHarness);
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

// Find all packages in a directory recursively
function findPackages(dir) {
  const pkgs = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (existsSync(join(full, 'package.json'))) {
        try {
          const pkg = JSON.parse(readFileSync(join(full, 'package.json'), 'utf8'));
          if (pkg.name && pkg.name.startsWith('@deepseek-ai/')) {
            pkgs.push({ name: pkg.name.replace('@deepseek-ai/', ''), path: full });
          }
        } catch {}
      }
      pkgs.push(...findPackages(full));
    }
  }
  return pkgs;
}

const searchDirs = ['packages', 'vendor']
  .map((d) => join(officialHarness, d))
  .filter(existsSync);

const packages = searchDirs.flatMap((dir) => findPackages(dir));
console.log(`Found ${packages.length} official packages in harness.`);

for (const p of packages) {
  const dest = join(targetDir, p.name);
  try {
    if (existsSync(dest) || lstatSync(dest).isSymbolicLink()) {
      rmSync(dest, { recursive: true, force: true });
    }
  } catch {}
  try {
    symlinkSync(p.path, dest, 'dir');
    console.log(`Linked @deepseek-ai/${p.name} -> ${p.path}`);
  } catch (err) {
    console.warn(`Failed linking ${p.name}:`, err.message);
  }
}
