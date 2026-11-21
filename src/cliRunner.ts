import { auditTarget, formatJson, formatSarif, formatText, PACKAGE_VERSION, PathGuardError, shouldFailOn } from './index.js';
import type { FailOnThreshold, OutputFormat } from './types.js';

const VALID_FORMATS: ReadonlySet<string> = new Set(['text', 'json', 'sarif']);
const VALID_FAIL_ON: ReadonlySet<string> = new Set(['high', 'medium', 'low', 'info', 'none']);

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface ParsedCliArgs {
  kind: 'help' | 'version' | 'check';
  target: string;
  format: OutputFormat;
  failOn: FailOnThreshold;
  includeTests: boolean;
}

const HELP_TEXT = `Usage: fetch-resilience-audit check [target] [options]

Static AST auditor for Node.js fetch() and Undici request() resilience hazards.

Options:
  --format <text|json|sarif>          Output format (default: text)
  --fail-on <high|medium|low|info|none>  Minimum severity for exit code 1 (default: medium)
  --include-tests                     Include test directories and *.test.* / *.spec.* files
  -h, --help                          Show help message
  -v, --version                       Show package version

Exit codes:
  0  Clean or all findings strictly below --fail-on threshold
  1  At least one finding at or above --fail-on threshold
  2  Invalid CLI arguments, missing target, or SYMLINK_ESCAPE_BLOCKED`;

class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function parseArgs(argv: readonly string[]): ParsedCliArgs {
  if (argv.length === 0) {
    throw new CliUsageError('Missing command. Expected "check". Run with --help for usage.');
  }

  const first = argv[0];
  if (first === '--help' || first === '-h') {
    return {
      kind: 'help',
      target: '.',
      format: 'text',
      failOn: 'medium',
      includeTests: false
    };
  }
  if (first === '--version' || first === '-v') {
    return {
      kind: 'version',
      target: '.',
      format: 'text',
      failOn: 'medium',
      includeTests: false
    };
  }

  if (first !== 'check') {
    throw new CliUsageError(`Unknown command "${first}". Expected "check".`);
  }

  let target: string | null = null;
  let format: OutputFormat = 'text';
  let failOn: FailOnThreshold = 'medium';
  let includeTests = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      return {
        kind: 'help',
        target: '.',
        format: 'text',
        failOn: 'medium',
        includeTests: false
      };
    }

    if (arg === '--include-tests') {
      includeTests = true;
      continue;
    }

    if (arg === '--format' || arg.startsWith('--format=')) {
      let val: string | undefined;
      if (arg === '--format') {
        i += 1;
        val = argv[i];
      } else {
        val = arg.slice('--format='.length);
      }
      if (!val || !VALID_FORMATS.has(val)) {
        throw new CliUsageError(
          `Invalid --format value "${val ?? ''}". Expected one of: text, json, sarif.`
        );
      }
      format = val as OutputFormat;
      continue;
    }

    if (arg === '--fail-on' || arg.startsWith('--fail-on=')) {
      let val: string | undefined;
      if (arg === '--fail-on') {
        i += 1;
        val = argv[i];
      } else {
        val = arg.slice('--fail-on='.length);
      }
      if (!val || !VALID_FAIL_ON.has(val)) {
        throw new CliUsageError(
          `Invalid --fail-on value "${val ?? ''}". Expected one of: high, medium, low, info, none.`
        );
      }
      failOn = val as FailOnThreshold;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new CliUsageError(`Unknown option "${arg}".`);
    }

    if (target !== null) {
      throw new CliUsageError(`Unexpected extra argument "${arg}". Only one target path is allowed.`);
    }
    target = arg;
  }

  return {
    kind: 'check',
    target: target ?? '.',
    format,
    failOn,
    includeTests
  };
}

export function runCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`)
  }
): number {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}`);
    return 2;
  }

  if (parsed.kind === 'help') {
    io.stdout(HELP_TEXT);
    return 0;
  }
  if (parsed.kind === 'version') {
    io.stdout(PACKAGE_VERSION);
    return 0;
  }

  try {
    const result = auditTarget(parsed.target, {
      includeTests: parsed.includeTests
    });

    switch (parsed.format) {
      case 'json':
        io.stdout(formatJson(result));
        break;
      case 'sarif':
        io.stdout(formatSarif(result));
        break;
      case 'text':
      default:
        io.stdout(formatText(result));
        break;
    }

    return shouldFailOn(result.findings, parsed.failOn) ? 1 : 0;
  } catch (err) {
    if (err instanceof PathGuardError) {
      io.stderr(`Error [${err.code}]: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}`);
    return 2;
  }
}
