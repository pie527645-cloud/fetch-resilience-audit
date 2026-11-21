import { PACKAGE_NAME, PACKAGE_VERSION } from '../rules/metadata.js';
import type { AuditResult } from '../types.js';

export function formatJson(result: AuditResult): string {
  const payload = {
    tool: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    target: result.target,
    summary: result.summary,
    findings: result.findings
  };
  return JSON.stringify(payload, null, 2);
}
