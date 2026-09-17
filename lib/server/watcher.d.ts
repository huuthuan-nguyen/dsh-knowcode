import type { KnowCodeRepository } from '../db/client.js';
import { type TraceSink } from './trace.js';
export interface WatcherOptions {
    workdir: string;
    repo: KnowCodeRepository;
    onUpdate?: (event: string, path: string) => void;
    debounceMs?: number;
    /** Enable `[trace] watch:` output. */
    trace?: boolean;
    /** Destination for trace lines. Defaults to stderr when `trace` is true. */
    onTrace?: TraceSink;
}
export declare class CodeWatcher {
    private options;
    private watcher;
    private hashes;
    private pendingChanges;
    private pendingDeletions;
    private debounceTimer;
    private linkEngine;
    private tracer;
    constructor(options: WatcherOptions);
    start(): void;
    stop(): Promise<void>;
    private queueChange;
    private queueDelete;
    private scheduleBatch;
    private processBatch;
}
