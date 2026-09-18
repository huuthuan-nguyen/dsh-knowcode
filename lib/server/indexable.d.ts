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
export declare const INDEXABLE_EXTENSIONS: ReadonlySet<string>;
/** fast-glob pattern covering exactly {@link INDEXABLE_EXTENSIONS}. */
export declare const INDEXABLE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,cpp,h,hpp,md,mdx,markdown,txt}";
/** Directory path fragments never indexed and never watched. */
export declare const IGNORED_DIR_FRAGMENTS: readonly string[];
/** fast-glob ignore patterns covering exactly {@link IGNORED_DIR_FRAGMENTS}. */
export declare const IGNORE_GLOBS: readonly string[];
/**
 * Database and binary extensions that must never be read as text.
 *
 * Indexing already excludes these through the extension allowlist; this list
 * exists so the intent is explicit and testable, and so a future allowlist change
 * cannot silently start reading a database file.
 */
export declare const NON_TEXT_EXTENSIONS: ReadonlySet<string>;
/** Whether a path sits under an ignored directory. */
export declare function isIgnoredPath(relPath: string): boolean;
/** Whether an extension should never be read as text. */
export declare function isNonTextPath(relPath: string): boolean;
/** Whether a path's contents are worth reading at all. */
export declare function isIndexablePath(relPath: string): boolean;
/** Largest file read and indexed when no limit is configured. */
export declare const DEFAULT_MAX_FILE_SIZE: number;
/** Why a file was not indexed. */
export type SkipReason = 'ignored' | 'not-text' | 'extension' | 'too-large' | 'unreadable';
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
export declare function decideIndexing(absPath: string, maxFileSize: number, relPath?: string): IndexDecision;
