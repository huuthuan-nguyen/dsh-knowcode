import { execSync } from 'node:child_process';
/**
 * Parses raw git unified diff output and returns modified files with changed line ranges.
 */
export function parseUnifiedDiff(rawDiff) {
    const fileDiffs = [];
    const lines = rawDiff.split('\n');
    let currentFile = null;
    let currentChangeType = 'modified';
    let currentRanges = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('diff --git ')) {
            // Flush previous file
            if (currentFile && (currentRanges.length > 0 || currentChangeType !== 'modified')) {
                fileDiffs.push({
                    file: currentFile,
                    changeType: currentChangeType,
                    changedLines: currentRanges,
                });
            }
            currentFile = null;
            currentChangeType = 'modified';
            currentRanges = [];
            // Extract b/ path: diff --git a/foo/bar.ts b/foo/bar.ts
            const parts = line.split(' ');
            if (parts.length >= 4) {
                const bPath = parts[3].replace(/^[a|b]\//, '');
                currentFile = bPath;
            }
        }
        else if (line.startsWith('new file mode ')) {
            currentChangeType = 'added';
        }
        else if (line.startsWith('deleted file mode ')) {
            currentChangeType = 'deleted';
        }
        else if (line.startsWith('--- /dev/null')) {
            currentChangeType = 'added';
        }
        else if (line.startsWith('+++ /dev/null')) {
            currentChangeType = 'deleted';
        }
        else if (line.startsWith('+++ b/')) {
            currentFile = line.substring(6).trim();
        }
        else if (line.startsWith('@@ ')) {
            // Unified hunk header: @@ -oldStart,oldCount +newStart,newCount @@
            const match = line.match(/@@\s+-[0-9]+(?:,[0-9]+)?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/);
            if (match) {
                const newStart = parseInt(match[1], 10);
                const newCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
                if (newCount > 0) {
                    currentRanges.push({
                        start: newStart,
                        end: newStart + newCount - 1,
                    });
                }
            }
        }
    }
    // Flush final file
    if (currentFile && (currentRanges.length > 0 || currentChangeType !== 'modified')) {
        fileDiffs.push({
            file: currentFile,
            changeType: currentChangeType,
            changedLines: currentRanges,
        });
    }
    return fileDiffs;
}
/**
 * Execute git diff in the specified directory and parse the result.
 */
export function getWorkspaceGitDiff(workdir, baseRef) {
    let rawDiff = '';
    try {
        if (baseRef) {
            rawDiff = execSync(`git diff ${baseRef}`, {
                cwd: workdir,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                maxBuffer: 10 * 1024 * 1024,
            });
        }
        else {
            // First try diff against HEAD (covers staged & unstaged changes)
            try {
                rawDiff = execSync('git diff HEAD', {
                    cwd: workdir,
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    maxBuffer: 10 * 1024 * 1024,
                });
            }
            catch {
                // If repo has no commits yet (empty repo), fall back to git diff
                rawDiff = execSync('git diff', {
                    cwd: workdir,
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    maxBuffer: 10 * 1024 * 1024,
                });
            }
        }
    }
    catch {
        // Not a git repo or git not found
        return [];
    }
    const fileDiffs = parseUnifiedDiff(rawDiff);
    // Also discover newly created untracked files
    if (!baseRef) {
        try {
            const statusOutput = execSync('git status --porcelain', {
                cwd: workdir,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const existingFiles = new Set(fileDiffs.map((f) => f.file));
            for (const line of statusOutput.split('\n')) {
                if (line.startsWith('?? ')) {
                    const file = line.substring(3).trim();
                    if (!existingFiles.has(file) && !file.includes('.knowcode') && !file.includes('node_modules')) {
                        fileDiffs.push({
                            file,
                            changeType: 'added',
                            changedLines: [],
                        });
                    }
                }
            }
        }
        catch { }
    }
    return fileDiffs;
}
