import z from '@deepseek-ai/schemastery';
export const KnowCodeConfig = z.object({
    falkordbUrl: z.string().description('External FalkorDB connection URL, or empty for embedded FalkorDB').default(''),
    daemonPort: z.number().description('Port for the background daemon HTTP/IPC server').default(48123),
    dataDir: z.string().description('Directory for persistent database files').default('.knowcode'),
    maxFileSize: z.number().description('Maximum file size to index in bytes').default(1024 * 1024),
    blastRadiusMaxDepth: z.number().description('Default depth for blast radius analysis').default(3),
    autoStartDaemon: z.boolean().description('Auto-start daemon if not running').default(true),
});
export function resolveConfig(raw) {
    return {
        falkordbUrl: raw.falkordbUrl ?? '',
        daemonPort: raw.daemonPort ?? 48123,
        dataDir: raw.dataDir ?? '.knowcode',
        maxFileSize: raw.maxFileSize ?? 1024 * 1024,
        blastRadiusMaxDepth: raw.blastRadiusMaxDepth ?? 3,
        autoStartDaemon: raw.autoStartDaemon ?? true,
    };
}
