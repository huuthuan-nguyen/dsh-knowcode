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
    /** Called once chokidar has finished its initial scan and is delivering events. */
    onReady?: () => void;
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
    private ready;
    constructor(options: WatcherOptions);
    start(): void;
    /** Whether chokidar finished its initial scan and is delivering events. */
    isReady(): boolean;
    /**
     * Resolve once the watcher is delivering events.
     *
     * @param timeoutMs - give up after this long, returning false.
     * @returns whether the watcher became ready.
     */
    waitUntilReady(timeoutMs?: number): Promise<boolean>;
    stop(): Promise<void>;
    private queueChange;
    private queueDelete;
    private scheduleBatch;
    private processBatch;
}
