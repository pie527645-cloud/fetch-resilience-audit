import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  discoverSourceFiles,
  hasWindowsBackslashTraversal,
  PathGuardError,
  resolveContainedPath
} from '../src/index.js';

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

describe('pathGuard security, canonicalization, and file discovery', () => {
  it('explicitly rejects Windows-style ..\\ traversal when platform is POSIX', () => {
    const root = makeTempDir('fra-pg-posix-');
    assert.equal(hasWindowsBackslashTraversal('..\\secret.ts'), true);
    assert.equal(hasWindowsBackslashTraversal('nested\\..\\escape.ts'), true);
    assert.equal(hasWindowsBackslashTraversal('nested/clean.ts'), false);

    assert.throws(
      () => resolveContainedPath(root, '..\\outside.ts', { platform: 'linux' }),
      (err: unknown) =>
        err instanceof PathGuardError && err.code === 'WINDOWS_TRAVERSAL_BLOCKED'
    );
  });

  it('canonicalizes both resolvedRoot and dirname(resolvedInput) via realpathSync.native (8.3 / alias safe)', () => {
    const workspace = makeTempDir('fra-pg-alias-');
    const realRoot = path.join(workspace, 'real-long-directory-name');
    const subDir = path.join(realRoot, 'src');
    fs.mkdirSync(subDir, { recursive: true });
    const targetFile = path.join(subDir, 'service.ts');
    fs.writeFileSync(targetFile, 'export const ok = 1;\n', 'utf8');

    const aliasRoot = path.join(workspace, 'alias-root');
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(realRoot, aliasRoot, symlinkType);

    const resolvedFromAlias = resolveContainedPath(aliasRoot, targetFile);
    assert.equal(resolvedFromAlias, fs.realpathSync.native(targetFile));

    const canonicalTmpFile = fs.realpathSync.native(targetFile);
    const resolvedFromTmp = resolveContainedPath(workspace, canonicalTmpFile);
    assert.equal(resolvedFromTmp, canonicalTmpFile);
  });

  it('blocks directory symlink/junction escapes with SYMLINK_ESCAPE_BLOCKED', () => {
    const workspace = makeTempDir('fra-pg-escape-');
    const rootDir = path.join(workspace, 'project');
    const outsideDir = path.join(workspace, 'outside-secrets');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'leak.ts'), 'export const x = 1;\n', 'utf8');

    const linkInsideRoot = path.join(rootDir, 'escaped-link');
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(outsideDir, linkInsideRoot, symlinkType);

    assert.throws(
      () => discoverSourceFiles(rootDir),
      (err: unknown) =>
        err instanceof PathGuardError && err.code === 'SYMLINK_ESCAPE_BLOCKED'
    );
  });

  it('skips build/artifact and test directories/files by default unless includeTests or targeted directly', () => {
    const rootDir = makeTempDir('fra-pg-walk-');
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'test'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, '__tests__'), { recursive: true });

    const prodFile = path.join(rootDir, 'src', 'client.ts');
    const colocatedSpec = path.join(rootDir, 'src', 'client.spec.ts');
    const testDirFile = path.join(rootDir, 'test', 'helper.ts');
    const ignoredBuildFile = path.join(rootDir, 'dist', 'client.js');
    const ignoredNodeMod = path.join(rootDir, 'node_modules', 'pkg', 'index.js');

    fs.writeFileSync(prodFile, 'export const a = 1;\n', 'utf8');
    fs.writeFileSync(colocatedSpec, 'export const b = 2;\n', 'utf8');
    fs.writeFileSync(testDirFile, 'export const c = 3;\n', 'utf8');
    fs.writeFileSync(ignoredBuildFile, 'export const d = 4;\n', 'utf8');
    fs.writeFileSync(ignoredNodeMod, 'export const e = 5;\n', 'utf8');

    const defaultScan = discoverSourceFiles(rootDir);
    assert.equal(defaultScan.files.length, 1);
    assert.ok(defaultScan.files[0]?.endsWith('client.ts'));

    const withTestsScan = discoverSourceFiles(rootDir, { includeTests: true });
    assert.equal(withTestsScan.files.length, 3);

    const directTestTarget = discoverSourceFiles(colocatedSpec);
    assert.equal(directTestTarget.singleFileTarget, true);
    assert.equal(directTestTarget.files.length, 1);
  });
});
