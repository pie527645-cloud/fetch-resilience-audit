import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { runCli } from '../src/cliRunner.js';

const fixturesDir = path.resolve('test', 'fixtures');
const createdTempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdTempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function captureCli(argv: readonly string[]): { code: number; out: string; err: string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const code = runCli(argv, {
    stdout: (msg) => outChunks.push(msg),
    stderr: (msg) => errChunks.push(msg)
  });
  return {
    code,
    out: outChunks.join('\n'),
    err: errChunks.join('\n')
  };
}

describe('CLI exit codes (0, 1, 2), flags, and subprocess execution', () => {
  it('returns exit code 0 on golden-clean-service.ts and --help / --version', () => {
    const cleanRun = captureCli([
      'check',
      path.join(fixturesDir, 'golden-clean-service.ts'),
      '--format',
      'json'
    ]);
    assert.equal(cleanRun.code, 0);
    assert.equal(cleanRun.err, '');
    const parsed = JSON.parse(cleanRun.out) as { summary: { totalFindings: number } };
    assert.equal(parsed.summary.totalFindings, 0);

    assert.equal(captureCli(['--help']).code, 0);
    assert.equal(captureCli(['--version']).code, 0);
  });

  it('returns exit code 0 when findings are below --fail-on threshold or --fail-on none, and 1 when >= threshold', () => {
    const fra004Path = path.join(fixturesDir, 'fra004-positive.ts');

    const defaultMedium = captureCli(['check', fra004Path]);
    assert.equal(defaultMedium.code, 0);

    const failOnLow = captureCli(['check', fra004Path, '--fail-on', 'low']);
    assert.equal(failOnLow.code, 1);

    const fra001Path = path.join(fixturesDir, 'fra001-positive.ts');
    const failMediumDefault = captureCli(['check', fra001Path]);
    assert.equal(failMediumDefault.code, 1);

    const failHighOnly = captureCli(['check', fra001Path, '--fail-on=high']);
    assert.equal(failHighOnly.code, 0);

    const failNone = captureCli(['check', fra001Path, '--fail-on', 'none', '--format=sarif']);
    assert.equal(failNone.code, 0);
    const sarif = JSON.parse(failNone.out) as { version: string };
    assert.equal(sarif.version, '2.1.0');
  });

  it('returns exit code 2 on invalid args, missing target, and SYMLINK_ESCAPE_BLOCKED', () => {
    assert.equal(captureCli([]).code, 2);
    assert.equal(captureCli(['unknown-cmd']).code, 2);
    assert.equal(captureCli(['check', '--unknown-flag']).code, 2);
    assert.equal(captureCli(['check', '.', '--format', 'xml']).code, 2);
    assert.equal(captureCli(['check', '.', '--fail-on', 'critical']).code, 2);
    assert.equal(captureCli(['check', 'a', 'b']).code, 2);

    const missingTarget = captureCli(['check', path.join(fixturesDir, 'does-not-exist-xyz.ts')]);
    assert.equal(missingTarget.code, 2);

    const ws = makeTempDir('fra-cli-sym-');
    const proj = path.join(ws, 'proj');
    const secret = path.join(ws, 'secret');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(secret, { recursive: true });
    fs.writeFileSync(path.join(secret, 'outside.ts'), 'export const s = 1;\n', 'utf8');
    fs.symlinkSync(
      secret,
      path.join(proj, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const symlinkEscape = captureCli(['check', proj]);
    assert.equal(symlinkEscape.code, 2);
    assert.ok(symlinkEscape.err.includes('SYMLINK_ESCAPE_BLOCKED'));
  });

  it('executes built dist/cli.js cleanly via execFileSync and preserves LF shebang', () => {
    const builtCli = path.resolve('dist', 'cli.js');
    if (!fs.existsSync(builtCli)) {
      return;
    }

    const rawBytes = fs.readFileSync(builtCli, 'utf8');
    assert.ok(rawBytes.startsWith('#!/usr/bin/env node\n'));
    assert.equal(rawBytes.includes('\r'), false);

    const stdout = execFileSync(
      process.execPath,
      [builtCli, 'check', path.join(fixturesDir, 'golden-clean-service.ts'), '--format', 'json'],
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(stdout) as { summary: { totalFindings: number } };
    assert.equal(parsed.summary.totalFindings, 0);
  });
});
