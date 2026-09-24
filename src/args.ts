import type { RunMode, RunOptions } from './workflow.js';

function parseDate(value: string, flag: string): string {
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    ) {
        throw new Error(`${flag} requires a valid YYYY-MM-DD date`);
    }
    return value;
}

export function parseArgs(args: readonly string[]): RunOptions & { dataDir: string; help: boolean } {
    let mode: RunMode | undefined;
    const options: RunOptions & { dataDir: string; help: boolean } = {
        mode: 'interactive',
        threshold: 0.9,
        account: undefined,
        from: undefined,
        to: undefined,
        dataDir: '.actual-data',
        help: false,
    };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        function value(): string {
            const next = args[++index];
            if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
            return next;
        }
        switch (arg) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--auto':
            case '--interactive':
            case '--dry-run':
                if (mode) throw new Error('Choose only one mode');
                mode = arg.slice(2) as RunMode;
                options.mode = mode;
                break;
            case '--threshold':
                options.threshold = Number(value());
                if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1)
                    throw new Error('--threshold must be between 0 and 1');
                break;
            case '--account':
                options.account = value();
                break;
            case '--from':
                options.from = parseDate(value(), arg);
                break;
            case '--to':
                options.to = parseDate(value(), arg);
                break;
            case '--data-dir':
                options.dataDir = value();
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }
    if (options.from && options.to && options.from > options.to) throw new Error('--from must be on or before --to');
    return options;
}
