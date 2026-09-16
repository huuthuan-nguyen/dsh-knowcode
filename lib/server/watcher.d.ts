import type { KnowCodeRepository } from '../db/client.js';
export interface WatcherOptions {
    workdir: string;
    repo: KnowCodeRepository;
    onUpdate?: (event: string, path: string) => void;
    debounceMs?: number;
}
export declare class CodeWatcher {
    private options;
    private watcher;
    private hashes;
    private pendingChanges;
    private pendingDeletions;
    private debounceTimer;
    private linkEngine;
    constructor(options: WatcherOptions);
    start(): void;
    stop(): Promise<void>;
    private queueChange;
    private queueDelete;
    private scheduleBatch;
    private processBatch;
}
