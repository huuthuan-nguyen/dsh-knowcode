import { statSync } from 'node:fs';
/**
 * Read a file's modification time in epoch milliseconds.
 *
 * Shared by the daemon's stale check and the file watcher: both compare an
 * indexed file's recorded `mtimeMs` against the filesystem, and a missing or
 * unstattable file must report `0` rather than throw.
 *
 * Extracted after `code_find_similar_duplicate_functions` flagged the two
 * byte-identical copies as a Type-1 clone.
 *
 * @param absPath - absolute path to stat.
 * @returns the mtime in epoch milliseconds, or 0 when unavailable.
 */
export function readMtimeMs(absPath) {
    try {
        return statSync(absPath).mtimeMs;
    }
    catch {
        return 0;
    }
}
