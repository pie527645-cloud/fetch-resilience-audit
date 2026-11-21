export type Severity = 'high' | 'medium' | 'low' | 'info';

export type FailOnThreshold = Severity | 'none';

export type OutputFormat = 'text' | 'json' | 'sarif';

export type RuleId = 'FRA001' | 'FRA002' | 'FRA003' | 'FRA004';

export interface RuleMetadata {
  id: RuleId;
  name: string;
  severity: Severity;
  sarifLevel: 'error' | 'warning' | 'note';
  shortDescription: string;
  fullDescription: string;
  helpUri: string;
}

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface AuditSummary {
  filesScanned: number;
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  byRule: Record<RuleId, number>;
}

export interface AuditResult {
  target: string;
  findings: Finding[];
  summary: AuditSummary;
}

export interface AuditOptions {
  rootDir?: string;
  includeTests?: boolean;
  platform?: NodeJS.Platform;
}
