import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * Single source of truth for "what gets indexed".
 *
 * The daemon's discovery glob and the file watcher previously decided this
 * independently, which is how they drifted: the glob only ever offered code and
 * documentation, while the watcher accepted any file chokidar reported and read
 * it in full before discovering it had nothing to parse. A SQLite database being
 * written by a running application was therefore read into memory and hashed on
 * every change, only to be discarded.
 */

/** Extensions whose contents are parsed as code or documentation. */
export const INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.kt',
  '.scala',
  '.swift',
  '.lua',
  '.zig',
  '.sh',
  '.bash',
  '.sol',
  '.ex',
  '.exs',
  '.ml',
  '.res',
  '.m',
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
]);

/** fast-glob pattern covering exactly {@link INDEXABLE_EXTENSIONS}. */
export const INDEXABLE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,cpp,h,hpp,cs,rb,php,kt,scala,swift,lua,zig,sh,bash,sol,ex,exs,ml,res,m,md,mdx,markdown,txt}';

/**
 * Text formats that describe a schema or DDL.
 *
 * These are read **only** as repository source: a `.sql` migration, a `.proto`
 * contract or a Prisma schema is text a developer wrote and committed. The running
 * database is never consulted — its files are binaries and stay excluded below.
 */
export const SCHEMA_EXTENSIONS: ReadonlySet<string> = new Set([
  '.sql',
  '.cql',
  '.prisma',
  '.proto',
  '.xsd',
  '.graphql',
  '.gql',
  '.avsc',
]);

/**
 * fast-glob pattern for schema sources.
 *
 * JSON and YAML are included because OpenAPI documents and Elasticsearch mappings
 * live there; `isSchemaPath` then accepts only names that look like a schema, so
 * lockfiles and CI configuration are discovered but never read.
 */
export const SCHEMA_GLOB = '**/*.{sql,cql,prisma,proto,xsd,graphql,gql,avsc,json,yaml,yml}';

/**
 * JSON/YAML documents that carry a schema or mapping, matched by file name so
 * lockfiles and CI configuration are not pulled in.
 */
const SCHEMA_JSON_NAME =
  /(^|\/)(openapi|swagger|[^/]*\.schema|[^/]*-schema|[^/]*mapping[^/]*|[^/]*elasticsearch[^/]*)\.(json|ya?ml)$/i;

/** Whether a path describes a schema or DDL in source form. */
export function isSchemaPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  if (SCHEMA_EXTENSIONS.has(extname(norm).toLowerCase())) return true;
  return SCHEMA_JSON_NAME.test(norm);
}

/**
 * Whether a file may be read at all.
 *
 * Anything outside this set — every database binary, archive, media file and
 * extensionless data file — is never opened, so a running MySQL, MongoDB, Redis or
 * Elasticsearch instance cannot have its files read by the indexer or the watcher.
 */
export function isReadableTextPath(relPath: string): boolean {
  if (isIgnoredPath(relPath)) return false;
  if (isNonTextPath(relPath)) return false;
  const ext = extname(relPath).toLowerCase();
  return INDEXABLE_EXTENSIONS.has(ext) || isSchemaPath(relPath);
}

/**
 * Whether a file looks binary, by the same NUL-byte heuristic git uses.
 *
 * A last line of defence for a data file whose name gives nothing away: it is
 * applied before the content is read as text.
 */
export function looksBinary(absPath: string, sniffBytes = 512): boolean {
  try {
    const fd = openSync(absPath, 'r');
    try {
      const buffer = Buffer.alloc(sniffBytes);
      const read = readSync(fd, buffer, 0, sniffBytes, 0);
      for (let i = 0; i < read; i++) {
        if (buffer[i] === 0) return true;
      }
      return false;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Directory path fragments never indexed and never watched. */
export const IGNORED_DIR_FRAGMENTS: readonly string[] = [
  '/node_modules',
  '/.git',
  '/.knowcode',
  '/dist',
  '/lib',
  '/build',
  '/.next',
  '/coverage',
  '/bin',
  '/target',
  '/vendor',
  '/.venv',
  '/venv',
  '/__pycache__',
];

/** fast-glob ignore patterns covering exactly {@link IGNORED_DIR_FRAGMENTS}. */
export const IGNORE_GLOBS: readonly string[] = IGNORED_DIR_FRAGMENTS.map((f) => `**${f}/**`);

/**
 * Database and binary extensions that must never be read as text.
 *
 * Indexing already excludes these through the extension allowlist; this list
 * exists so the intent is explicit and testable, and so a future allowlist change
 * cannot silently start reading a database file.
 */
export const NON_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.db',
  '.db3',
  '.sqlite',
  '.sqlite3',
  '.duckdb',
  '.mdb',
  '.accdb',
  '.rdb',
  '.aof',
  '.realm',
  '.db-wal',
  '.db-shm',
  '.db-journal',
  '.sqlite-wal',
  '.sqlite-shm',
  '.sqlite3-wal',
  '.sqlite3-shm',
  // MySQL / MariaDB data files
  '.ibd',
  '.frm',
  '.myd',
  '.myi',
  '.arm',
  // MongoDB / WiredTiger
  '.wt',
  '.bson',
  '.ns',
  '.turtle',
  // Elasticsearch / Lucene index segments
  '.cfs',
  '.cfe',
  '.si',
  '.del',
  '.fdt',
  '.fdx',
  '.fnm',
  '.nvd',
  '.nvm',
  '.tim',
  '.tip',
  '.kdd',
  '.kdi',
  '.liv',
  // LevelDB / RocksDB
  '.sst',
  '.ldb',
  // Misc database and binary payloads
  '.bin',
  '.dat',
  '.pack',
  '.idx',
  '.node',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.class',
  '.jar',
  '.pyc',
  '.pyo',
  '.wasm',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
]);

/** SQLite sidecar files, which end in `-wal`/`-shm`/`-journal` rather than a plain extension. */
const SQLITE_SIDECAR = /\.(db|db3|sqlite|sqlite3)(-(wal|shm|journal))$/i;

/** Whether a path sits under an ignored directory. */
export function isIgnoredPath(relPath: string): boolean {
  const norm = `/${relPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  return IGNORED_DIR_FRAGMENTS.some((frag) => norm.includes(`${frag}/`) || norm.endsWith(frag));
}

/** Whether an extension should never be read as text. */
export function isNonTextPath(relPath: string): boolean {
  const base = relPath.replace(/\\/g, '/').split('/').pop() ?? '';
  if (SQLITE_SIDECAR.test(base)) return true;
  return NON_TEXT_EXTENSIONS.has(extname(base).toLowerCase());
}

/** Whether a path's contents are worth reading at all. */
export function isIndexablePath(relPath: string): boolean {
  return isReadableTextPath(relPath);
}

/** Largest file read and indexed when no limit is configured. */
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

/** Why a file was not indexed. */
export type SkipReason =
  | 'ignored'
  | 'not-text'
  | 'extension'
  | 'too-large'
  | 'unreadable'
  | 'binary';

export interface IndexDecision {
  ok: boolean;
  reason?: SkipReason;
  /** Size in bytes, when it could be read. */
  size?: number;
}

/**
 * Decide whether a file should be read and indexed.
 *
 * `maxFileSize` is enforced here, before any read: the option was documented and
 * resolved but never consulted, so a multi-megabyte file was read and parsed in
 * full no matter what the user configured.
 *
 * @param absPath - absolute path to inspect.
 * @param maxFileSize - largest file to read, in bytes.
 * @param relPath - workspace-relative path used for extension checks; defaults to `absPath`.
 */
export function decideIndexing(
  absPath: string,
  maxFileSize: number,
  relPath: string = absPath
): IndexDecision {
  if (isIgnoredPath(relPath)) return { ok: false, reason: 'ignored' };
  if (isNonTextPath(relPath)) return { ok: false, reason: 'not-text' };
  if (!isReadableTextPath(relPath)) return { ok: false, reason: 'extension' };

  let size: number;
  try {
    size = statSync(absPath).size;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  if (size > maxFileSize) return { ok: false, reason: 'too-large', size };

  // Never decode a binary payload as text, whatever its name.
  if (looksBinary(absPath)) return { ok: false, reason: 'binary', size };

  return { ok: true, size };
}
