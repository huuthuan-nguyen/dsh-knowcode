export declare function runServeCommand(targetDir?: string, options?: {
    port?: number;
    dataDir?: string;
    trace?: boolean;
    forceIndex?: boolean;
    maxFileSize?: number;
}): Promise<void>;
