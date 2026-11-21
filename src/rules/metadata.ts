import type { FailOnThreshold, Finding, RuleId, RuleMetadata, Severity } from '../types.js';

export const PACKAGE_NAME = '@pie527645-cloud/fetch-resilience-audit';
export const PACKAGE_VERSION = '1.0.0';
export const REPO_URI = 'https://github.com/pie527645-cloud/fetch-resilience-audit';

export const RULE_IDS: readonly RuleId[] = ['FRA001', 'FRA002', 'FRA003', 'FRA004'] as const;

export const RULES: Record<RuleId, RuleMetadata> = {
  FRA001: {
    id: 'FRA001',
    name: 'UnconsumedFetchResponseBody',
    severity: 'medium',
    sarifLevel: 'warning',
    shortDescription: 'Unconsumed fetch() response body on exit or error path',
    fullDescription:
      'A fetch() Response body is neither consumed nor cancelled before returning a non-Response value, throwing, or exiting the function, risking HTTP socket/connection pool retention and memory leaks.',
    helpUri: `${REPO_URI}#fra001`
  },
  FRA002: {
    id: 'FRA002',
    name: 'UnconsumedUndiciRequestBody',
    severity: 'medium',
    sarifLevel: 'warning',
    shortDescription: 'Unconsumed Undici request() response body',
    fullDescription:
      'An Undici request() response body is omitted in destructuring or neither consumed nor drained via body.dump()/cancel()/destroy() across all exit paths, risking connection pool starvation and socket leaks.',
    helpUri: `${REPO_URI}#fra002`
  },
  FRA003: {
    id: 'FRA003',
    name: 'SharedAbortSignalTimeoutInLoop',
    severity: 'medium',
    sarifLevel: 'warning',
    shortDescription: 'Shared AbortSignal.timeout() reused inside a loop',
    fullDescription:
      'An AbortSignal.timeout() signal created outside a loop is passed to fetch() or request() inside the loop, causing retries or later iterations to share a decaying or already-aborted timeout signal.',
    helpUri: `${REPO_URI}#fra003`
  },
  FRA004: {
    id: 'FRA004',
    name: 'UnboundedConcurrentFetchFanout',
    severity: 'low',
    sarifLevel: 'note',
    shortDescription: 'Unbounded Promise.all/allSettled fetch or request fan-out',
    fullDescription:
      'Promise.all() or Promise.allSettled() maps over an unbounded array performing fetch() or request() calls without a concurrency limiter or slice batching.',
    helpUri: `${REPO_URI}#fra004`
  }
};

const SEVERITY_RANK: Record<Severity, number> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1
};

export function shouldFailOn(findings: readonly Finding[], threshold: FailOnThreshold): boolean {
  if (threshold === 'none') {
    return false;
  }
  const minRank = SEVERITY_RANK[threshold];
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] >= minRank) {
      return true;
    }
  }
  return false;
}
