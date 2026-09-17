/**
 * KnowCode plugin configuration.
 *
 * Cordis validates a plugin's `Config` through Standard Schema v1
 * (`ctx` reads `Config['~standard'].validate(raw)`), so the schema is declared
 * by hand instead of pulling in `@deepseek-ai/schemastery`.
 *
 * This keeps the plugin free of runtime harness imports. A plugin should not
 * load harness internals at runtime: it can add yet another evaluated copy of a
 * package the host already owns. (Defense-in-depth only — the harness's
 * "reading 'prepare'" defect comes from its own private `Symbol()` scheduler key
 * and reproduces with zero plugins installed.)
 */
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

export interface ResolvedKnowCodeConfig {
  falkordbUrl: string;
  daemonPort: number;
  dataDir: string;
  maxFileSize: number;
  blastRadiusMaxDepth: number;
  autoStartDaemon: boolean;
}

const DEFAULT_DAEMON_PORT = 48123;
const DEFAULT_DATA_DIR = '.knowcode';
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
const DEFAULT_BLAST_RADIUS_DEPTH = 3;

/** Coerce to a finite number, or fall back to the default. */
function finiteNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a positive integer, or fall back to the default. */
function positiveInt(value: unknown, fallback: number): number {
  const n = finiteNumber(value, fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Normalize raw plugin config into fully-defaulted values.
 *
 * Exported (and used by the Standard Schema validator below) so there is exactly
 * one place that decides defaults.
 */
export function resolveConfig(raw: KnowCodeConfig | undefined | null): ResolvedKnowCodeConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as KnowCodeConfig;
  return {
    falkordbUrl: typeof source.falkordbUrl === 'string' ? source.falkordbUrl : '',
    daemonPort: positiveInt(source.daemonPort, DEFAULT_DAEMON_PORT),
    dataDir:
      typeof source.dataDir === 'string' && source.dataDir.length > 0 ? source.dataDir : DEFAULT_DATA_DIR,
    maxFileSize: positiveInt(source.maxFileSize, DEFAULT_MAX_FILE_SIZE),
    blastRadiusMaxDepth: positiveInt(source.blastRadiusMaxDepth, DEFAULT_BLAST_RADIUS_DEPTH),
    autoStartDaemon: source.autoStartDaemon !== false,
  };
}

/**
 * Standard Schema v1 validator consumed by Cordis at plugin load time.
 *
 * @see https://github.com/standard-schema/standard-schema
 */
export const KnowCodeConfig = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-knowcode',
    validate(value: unknown): { value: ResolvedKnowCodeConfig } {
      return { value: resolveConfig(value as KnowCodeConfig) };
    },
  },
};
