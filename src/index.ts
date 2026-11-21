import fs from 'node:fs';
import path from 'node:path';
import { auditSource } from './analyzer/auditSource.js';
import { formatJson } from './formatters/json.js';
import { formatSarif } from './formatters/sarif.js';
import { formatText } from './formatters/text.js';
import { PACKAGE_NAME, PACKAGE_VERSION, RULES, RULE_IDS, shouldFailOn } from './rules/metadata.js';
import {
  IGNORED_BUILD_DIRS,
  PathGuardError,
  TEST_DIR_NAMES,
  discoverSourceFiles,
  hasWindowsBackslashTraversal,
  isSupportedSourceFile,
  isTestFileName,
  isWithinCanonicalRoot,
  resolveContainedPath,
  toPosixRelativePath,
  type DiscoverOptions,
  type DiscoveredFiles,
  type PathGuardErrorCode,
  type PathGuardOptions
} from './security/pathGuard.js';
import type {
  AuditOptions,
  AuditResult,
  AuditSummary,
  FailOnThreshold,
  Finding,
  OutputFormat,
  RuleId,
  RuleMetadata,
  Severity
} from './types.js';

export function buildAuditSummary(filesScanned: number, findings: readonly Finding[]): AuditSummary {
  const bySeverity: Record<Severity, number> = {
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  };
  const byRule: Record<RuleId, number> = {
    FRA001: 0,
    FRA002: 0,
    FRA003: 0,
    FRA004: 0
  };

  for (const f of findings) {
    bySeverity[f.severity] += 1;
    byRule[f.ruleId] += 1;
  }

  return {
    filesScanned,
    totalFindings: findings.length,
    bySeverity,
    byRule
  };
}

export function auditFile(filePath: string, options?: AuditOptions): Finding[] {
  const effectiveRoot = options?.rootDir ?? path.dirname(path.resolve(filePath));
  const canonicalFile = resolveContainedPath(effectiveRoot, filePath, {
    platform: options?.platform
  });
  const canonicalRoot = fs.realpathSync.native(path.resolve(effectiveRoot));
  const label = toPosixRelativePath(canonicalRoot, canonicalFile);
  const content = fs.readFileSync(canonicalFile, 'utf8');
  return auditSource(content, label);
}

export function auditTarget(targetInput = '.', options?: AuditOptions): AuditResult {
  const discovered = discoverSourceFiles(targetInput, {
    rootDir: options?.rootDir,
    includeTests: options?.includeTests,
    platform: options?.platform
  });

  const allFindings: Finding[] = [];

  for (const filePath of discovered.files) {
    const label = discovered.singleFileTarget
      ? path.basename(filePath).replaceAll('\\', '/')
      : toPosixRelativePath(discovered.rootDir, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const fileFindings = auditSource(content, label);
    allFindings.push(...fileFindings);
  }

  allFindings.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    if (a.column !== b.column) {
      return a.column - b.column;
    }
    return a.ruleId.localeCompare(b.ruleId);
  });

  const displayTarget =
    targetInput === '.'
      ? '.'
      : path.basename(path.resolve(targetInput)).replaceAll('\\', '/') || '.';

  return {
    target: displayTarget,
    findings: allFindings,
    summary: buildAuditSummary(discovered.files.length, allFindings)
  };
}

export {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  RULES,
  RULE_IDS,
  IGNORED_BUILD_DIRS,
  TEST_DIR_NAMES,
  PathGuardError,
  auditSource,
  shouldFailOn,
  formatText,
  formatJson,
  formatSarif,
  discoverSourceFiles,
  resolveContainedPath,
  isWithinCanonicalRoot,
  hasWindowsBackslashTraversal,
  isSupportedSourceFile,
  isTestFileName,
  toPosixRelativePath
};

export type {
  AuditOptions,
  AuditResult,
  AuditSummary,
  DiscoverOptions,
  DiscoveredFiles,
  FailOnThreshold,
  Finding,
  OutputFormat,
  PathGuardErrorCode,
  PathGuardOptions,
  RuleId,
  RuleMetadata,
  Severity
};
