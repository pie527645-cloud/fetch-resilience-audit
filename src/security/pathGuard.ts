import fs from 'node:fs';
import path from 'node:path';

export type PathGuardErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'SYMLINK_ESCAPE_BLOCKED'
  | 'WINDOWS_TRAVERSAL_BLOCKED'
  | 'PATH_TRAVERSAL_BLOCKED';

export class PathGuardError extends Error {
  public readonly code: PathGuardErrorCode;

  public constructor(message: string, code: PathGuardErrorCode) {
    super(message);
    this.name = 'PathGuardError';
    this.code = code;
  }
}

export const IGNORED_BUILD_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-test',
  'dist-tests',
  'build',
  'coverage',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo'
]);

export const TEST_DIR_NAMES: ReadonlySet<string> = new Set(['test', 'tests', '__tests__']);

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]);

export interface PathGuardOptions {
  platform?: NodeJS.Platform;
}

export interface DiscoverOptions extends PathGuardOptions {
  rootDir?: string;
  includeTests?: boolean;
}

export interface DiscoveredFiles {
  rootDir: string;
  files: string[];
  singleFileTarget: boolean;
}

export function hasWindowsBackslashTraversal(rawInput: string): boolean {
  if (!rawInput.includes('\\')) {
    return false;
  }
  const segments = rawInput.split('\\');
  for (const seg of segments) {
    if (seg === '..') {
      return true;
    }
    const slashParts = seg.split('/');
    if (slashParts.includes('..')) {
      return true;
    }
  }
  return false;
}

export function isWithinCanonicalRoot(
  canonicalRoot: string,
  candidateCanonical: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') {
    const normRoot = path.win32.resolve(canonicalRoot).toLowerCase();
    const normCandidate = path.win32.resolve(candidateCanonical).toLowerCase();
    if (normRoot === normCandidate) {
      return true;
    }
    const rel = path.win32.relative(normRoot, normCandidate);
    if (rel === '' || (!rel.startsWith('..\\') && rel !== '..' && !path.win32.isAbsolute(rel))) {
      return true;
    }
    return false;
  }

  const normRoot = path.posix.resolve(canonicalRoot);
  const normCandidate = path.posix.resolve(candidateCanonical);
  if (normRoot === normCandidate) {
    return true;
  }
  const rel = path.posix.relative(normRoot, normCandidate);
  if (rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.posix.isAbsolute(rel))) {
    return true;
  }
  return false;
}

function hasSymlinkBetween(stopDir: string, leafPath: string): boolean {
  let current = path.resolve(leafPath);
  const resolvedStop = path.resolve(stopDir);
  while (true) {
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) {
        return true;
      }
    } catch {
      return false;
    }
    if (current.toLowerCase() === resolvedStop.toLowerCase()) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return false;
}

export function resolveContainedPath(
  rootDir: string,
  inputPath: string,
  options?: PathGuardOptions
): string {
  const platform = options?.platform ?? process.platform;

  if (platform !== 'win32' && hasWindowsBackslashTraversal(inputPath)) {
    throw new PathGuardError(
      `Windows-style backslash traversal is rejected on POSIX: ${inputPath}`,
      'WINDOWS_TRAVERSAL_BLOCKED'
    );
  }

  const resolvedRoot = path.resolve(rootDir);
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(resolvedRoot);
  } catch {
    throw new PathGuardError(`Root directory does not exist: ${rootDir}`, 'TARGET_NOT_FOUND');
  }

  const resolvedInput = path.resolve(resolvedRoot, inputPath);

  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolvedInput);
  } catch {
    throw new PathGuardError(`Target path does not exist: ${inputPath}`, 'TARGET_NOT_FOUND');
  }

  const isRootItself =
    platform === 'win32'
      ? resolvedInput.toLowerCase() === resolvedRoot.toLowerCase()
      : resolvedInput === resolvedRoot;

  let canonicalParent: string;
  try {
    canonicalParent = fs.realpathSync.native(path.dirname(resolvedInput));
  } catch {
    throw new PathGuardError(`Target parent directory does not exist: ${inputPath}`, 'TARGET_NOT_FOUND');
  }

  if (!isRootItself && !isWithinCanonicalRoot(canonicalRoot, canonicalParent, platform)) {
    const isSymlink = lstat.isSymbolicLink() || hasSymlinkBetween(resolvedRoot, path.dirname(resolvedInput));
    const code: PathGuardErrorCode = isSymlink ? 'SYMLINK_ESCAPE_BLOCKED' : 'PATH_TRAVERSAL_BLOCKED';
    throw new PathGuardError(
      `${code}: Path escapes root directory (${inputPath})`,
      code
    );
  }

  if (lstat.isSymbolicLink()) {
    let canonicalTarget: string;
    try {
      canonicalTarget = fs.realpathSync.native(resolvedInput);
    } catch {
      const rawLink = fs.readlinkSync(resolvedInput);
      const tentativeTarget = path.resolve(canonicalParent, rawLink);
      if (!isWithinCanonicalRoot(canonicalRoot, tentativeTarget, platform)) {
        throw new PathGuardError(
          `SYMLINK_ESCAPE_BLOCKED: Broken symlink points outside root directory (${inputPath})`,
          'SYMLINK_ESCAPE_BLOCKED'
        );
      }
      throw new PathGuardError(`Target symlink points to missing file: ${inputPath}`, 'TARGET_NOT_FOUND');
    }

    if (!isWithinCanonicalRoot(canonicalRoot, canonicalTarget, platform)) {
      throw new PathGuardError(
        `SYMLINK_ESCAPE_BLOCKED: Symlink target escapes root directory (${inputPath})`,
        'SYMLINK_ESCAPE_BLOCKED'
      );
    }
    return canonicalTarget;
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = fs.realpathSync.native(resolvedInput);
  } catch {
    throw new PathGuardError(`Target path cannot be canonicalized: ${inputPath}`, 'TARGET_NOT_FOUND');
  }

  if (!isWithinCanonicalRoot(canonicalRoot, canonicalTarget, platform)) {
    const isSymlink = hasSymlinkBetween(resolvedRoot, resolvedInput);
    const code: PathGuardErrorCode = isSymlink ? 'SYMLINK_ESCAPE_BLOCKED' : 'PATH_TRAVERSAL_BLOCKED';
    throw new PathGuardError(
      `${code}: Canonical target escapes root directory (${inputPath})`,
      code
    );
  }

  return canonicalTarget;
}

export function isSupportedSourceFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) {
    return false;
  }
  const ext = path.extname(lower);
  return SOURCE_EXTENSIONS.has(ext);
}

export function isTestFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.includes('.test.') || lower.includes('.spec.');
}

export function toPosixRelativePath(rootDir: string, filePath: string): string {
  const rel = path.relative(rootDir, filePath);
  if (rel === '') {
    return path.basename(filePath).replaceAll('\\', '/');
  }
  return rel.replaceAll('\\', '/');
}

export function discoverSourceFiles(
  targetInput: string,
  options?: DiscoverOptions
): DiscoveredFiles {
  const platform = options?.platform ?? process.platform;
  const includeTests = options?.includeTests ?? false;

  if (platform !== 'win32' && hasWindowsBackslashTraversal(targetInput)) {
    throw new PathGuardError(
      `Windows-style backslash traversal is rejected on POSIX: ${targetInput}`,
      'WINDOWS_TRAVERSAL_BLOCKED'
    );
  }

  let effectiveRoot: string;
  if (options?.rootDir !== undefined) {
    effectiveRoot = options.rootDir;
  } else {
    const tentative = path.resolve(targetInput);
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(tentative);
    } catch {
      throw new PathGuardError(`Target path does not exist: ${targetInput}`, 'TARGET_NOT_FOUND');
    }

    if (lstat.isSymbolicLink() || lstat.isFile()) {
      effectiveRoot = path.dirname(tentative);
    } else if (lstat.isDirectory()) {
      effectiveRoot = tentative;
    } else {
      throw new PathGuardError(`Unsupported target file type: ${targetInput}`, 'TARGET_NOT_FOUND');
    }
  }

  const canonicalTarget = resolveContainedPath(effectiveRoot, targetInput, { platform });
  const canonicalRoot = fs.realpathSync.native(path.resolve(effectiveRoot));
  const targetStat = fs.statSync(canonicalTarget);

  if (targetStat.isFile()) {
    const files = isSupportedSourceFile(path.basename(canonicalTarget)) ? [canonicalTarget] : [];
    return {
      rootDir: canonicalRoot,
      files,
      singleFileTarget: true
    };
  }

  const discovered: string[] = [];
  const visitedDirs = new Set<string>();
  const dirKey = platform === 'win32' ? canonicalTarget.toLowerCase() : canonicalTarget;
  visitedDirs.add(dirKey);

  function walk(currentDir: string): void {
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (IGNORED_BUILD_DIRS.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);
      const resolvedEntry = resolveContainedPath(canonicalTarget, entryPath, { platform });
      const resolvedStat = fs.statSync(resolvedEntry);

      if (resolvedStat.isDirectory()) {
        if (!includeTests && TEST_DIR_NAMES.has(entry.name)) {
          continue;
        }
        const key = platform === 'win32' ? resolvedEntry.toLowerCase() : resolvedEntry;
        if (visitedDirs.has(key)) {
          continue;
        }
        visitedDirs.add(key);
        walk(resolvedEntry);
      } else if (resolvedStat.isFile()) {
        if (!isSupportedSourceFile(entry.name)) {
          continue;
        }
        if (!includeTests && isTestFileName(entry.name)) {
          continue;
        }
        discovered.push(resolvedEntry);
      }
    }
  }

  walk(canonicalTarget);

  return {
    rootDir: canonicalTarget,
    files: discovered,
    singleFileTarget: false
  };
}
