import z from '@deepseek-ai/schemastery';

export interface KnowCodeConfig {
  /** Optional custom FalkorDB URL (e.g. redis://127.0.0.1:6379). Defaults to embedded FalkorDB. */
  falkordbUrl?: string;
  /** Port for the KnowCode daemon server. Defaults to 48123. */
  daemonPort?: number;
  /** Directory for local database and index storage. Defaults to '.knowcode'. */
  dataDir?: string;
  /** Maximum file size in bytes to index (default: 1,048,576 / 1MB). */
  maxFileSize?: number;
  /** Default traversal depth for blast radius / impact analysis (default: 3). */
  blastRadiusMaxDepth?: number;
  /** Auto-start daemon when DSH launches if not running (default: true). */
  autoStartDaemon?: boolean;
}

export const KnowCodeConfig: z<KnowCodeConfig> = z.object({
  falkordbUrl: z.string().description('External FalkorDB connection URL, or empty for embedded FalkorDB').default(''),
  daemonPort: z.number().description('Port for the background daemon HTTP/IPC server').default(48123),
  dataDir: z.string().description('Directory for persistent database files').default('.knowcode'),
  maxFileSize: z.number().description('Maximum file size to index in bytes').default(1024 * 1024),
  blastRadiusMaxDepth: z.number().description('Default depth for blast radius analysis').default(3),
  autoStartDaemon: z.boolean().description('Auto-start daemon if not running').default(true),
});

export interface ResolvedKnowCodeConfig {
  falkordbUrl: string;
  daemonPort: number;
  dataDir: string;
  maxFileSize: number;
  blastRadiusMaxDepth: number;
  autoStartDaemon: boolean;
}

export function resolveConfig(raw: KnowCodeConfig): ResolvedKnowCodeConfig {
  return {
    falkordbUrl: raw.falkordbUrl ?? '',
    daemonPort: raw.daemonPort ?? 48123,
    dataDir: raw.dataDir ?? '.knowcode',
    maxFileSize: raw.maxFileSize ?? 1024 * 1024,
    blastRadiusMaxDepth: raw.blastRadiusMaxDepth ?? 3,
    autoStartDaemon: raw.autoStartDaemon ?? true,
  };
}
