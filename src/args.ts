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

export type CliOptions = RunOptions & {
    maxExamplesPerCategory?: number;
    dataDir?: string;
    envFile?: string;
    help: boolean;
    command: 'run' | 'setup' | 'config-show';
};

export function parseArgs(args: readonly string[]): CliOptions {
    let command: CliOptions['command'] = 'run';
    if (args[0] === 'setup') {
        command = 'setup';
        args = args.slice(1);
    } else if (args[0] === 'config' && args[1] === 'show') {
        command = 'config-show';
        args = args.slice(2);
    }
    let mode: RunMode | undefined;
    const options: CliOptions = {
        command,
        mode: 'interactive',
        threshold: 0.9,
        account: undefined,
        from: undefined,
        to: undefined,
        dataDir: undefined,
        help: false,
    };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (command === 'setup' && arg !== '--help' && arg !== '-h')
            throw new Error('setup accepts only --help; it edits saved configuration');
        if (
            command === 'config-show' &&
            !['--env-file', '--threshold', '--max-examples-per-category', '--data-dir', '--help', '-h'].includes(arg!)
        )
            throw new Error(
                'config show accepts only --env-file, --threshold, --max-examples-per-category, --data-dir, and --help',
            );
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
            case '--max-examples-per-category':
                options.maxExamplesPerCategory = Number(value());
                if (
                    !Number.isSafeInteger(options.maxExamplesPerCategory) ||
                    options.maxExamplesPerCategory < 0 ||
                    options.maxExamplesPerCategory > 100
                )
                    throw new Error('--max-examples-per-category must be an integer between 0 and 100');
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
            case '--env-file':
                options.envFile = value();
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
