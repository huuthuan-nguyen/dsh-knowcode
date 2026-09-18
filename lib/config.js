const DEFAULT_DAEMON_PORT = 48123;
const DEFAULT_DATA_DIR = '.knowcode';
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
const DEFAULT_BLAST_RADIUS_DEPTH = 3;
/** Coerce to a finite number, or fall back to the default. */
function finiteNumber(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}
/** Coerce to a positive integer, or fall back to the default. */
function positiveInt(value, fallback) {
    const n = finiteNumber(value, fallback);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
/**
 * Normalize raw plugin config into fully-defaulted values.
 *
 * Exported (and used by the Standard Schema validator below) so there is exactly
 * one place that decides defaults.
 */
export function resolveConfig(raw) {
    const source = (raw && typeof raw === 'object' ? raw : {});
    return {
        falkordbUrl: typeof source.falkordbUrl === 'string' ? source.falkordbUrl : '',
        daemonPort: positiveInt(source.daemonPort, DEFAULT_DAEMON_PORT),
        dataDir: typeof source.dataDir === 'string' && source.dataDir.length > 0 ? source.dataDir : DEFAULT_DATA_DIR,
        maxFileSize: positiveInt(source.maxFileSize, DEFAULT_MAX_FILE_SIZE),
        blastRadiusMaxDepth: positiveInt(source.blastRadiusMaxDepth, DEFAULT_BLAST_RADIUS_DEPTH),
        autoStartDaemon: source.autoStartDaemon !== false,
        stopDaemonOnExit: source.stopDaemonOnExit !== false,
    };
}
/**
 * Standard Schema v1 validator consumed by Cordis at plugin load time.
 *
 * @see https://github.com/standard-schema/standard-schema
 */
export const KnowCodeConfig = {
    '~standard': {
        version: 1,
        vendor: 'dsh-knowcode',
        validate(value) {
            return { value: resolveConfig(value) };
        },
    },
};
