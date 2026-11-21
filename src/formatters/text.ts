import type { AuditResult } from '../types.js';

export function formatText(result: AuditResult): string {
  const { findings, summary } = result;
  if (findings.length === 0) {
    return `fetch-resilience-audit: 0 findings across ${summary.filesScanned} file(s).`;
  }

  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${f.file}:${f.line}:${f.column} [${f.severity}] ${f.ruleId}: ${f.message}`);
  }
  lines.push('');
  lines.push(
    `Summary: ${summary.totalFindings} finding(s) across ${summary.filesScanned} file(s) ` +
      `(high: ${summary.bySeverity.high}, medium: ${summary.bySeverity.medium}, ` +
      `low: ${summary.bySeverity.low}, info: ${summary.bySeverity.info}).`
  );
  return lines.join('\n');
}
