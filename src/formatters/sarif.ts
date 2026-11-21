import { PACKAGE_NAME, PACKAGE_VERSION, REPO_URI, RULES, RULE_IDS } from '../rules/metadata.js';
import type { AuditResult, Severity } from '../types.js';

function severityToSarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
    case 'info':
      return 'note';
  }
}

export function formatSarif(result: AuditResult): string {
  const ruleIndexMap = new Map<string, number>();
  const driverRules = RULE_IDS.map((id, idx) => {
    ruleIndexMap.set(id, idx);
    const meta = RULES[id];
    return {
      id: meta.id,
      name: meta.name,
      shortDescription: { text: meta.shortDescription },
      fullDescription: { text: meta.fullDescription },
      helpUri: meta.helpUri,
      defaultConfiguration: {
        level: meta.sarifLevel
      },
      properties: {
        severity: meta.severity
      }
    };
  });

  const sarifResults = result.findings.map((f) => ({
    ruleId: f.ruleId,
    ruleIndex: ruleIndexMap.get(f.ruleId) ?? 0,
    level: severityToSarifLevel(f.severity),
    message: {
      text: f.message
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: f.file,
            uriBaseId: '%SRCROOT%'
          },
          region: {
            startLine: f.line,
            startColumn: f.column,
            endLine: f.endLine,
            endColumn: f.endColumn
          }
        }
      }
    ]
  }));

  const sarifLog = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: PACKAGE_NAME,
            version: PACKAGE_VERSION,
            informationUri: REPO_URI,
            rules: driverRules
          }
        },
        results: sarifResults
      }
    ]
  };

  return JSON.stringify(sarifLog, null, 2);
}
