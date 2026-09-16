import type { GitFileDiff } from '../types.js';
/**
 * Parses raw git unified diff output and returns modified files with changed line ranges.
 */
export declare function parseUnifiedDiff(rawDiff: string): GitFileDiff[];
/**
 * Execute git diff in the specified directory and parse the result.
 */
export declare function getWorkspaceGitDiff(workdir: string, baseRef?: string): GitFileDiff[];
