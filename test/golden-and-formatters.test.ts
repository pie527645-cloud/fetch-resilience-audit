import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  auditTarget,
  formatJson,
  formatSarif,
  formatText,
  RULE_IDS,
  shouldFailOn
} from '../src/index.js';

const fixturesDir = path.resolve('test', 'fixtures');

describe('Golden clean service, formatters, SARIF v2.1.0 schema, and privacy invariants', () => {
  it('produces 0 findings on golden-clean-service.ts', () => {
    const result = auditTarget(path.join(fixturesDir, 'golden-clean-service.ts'));
    assert.equal(result.summary.filesScanned, 1);
    assert.equal(result.summary.totalFindings, 0);
    assert.deepEqual(result.findings, []);
    assert.ok(formatText(result).includes('0 findings across 1 file(s)'));
  });

  it('emits valid SARIF v2.1.0 containing all 4 rules FRA001-FRA004 and accurate locations', () => {
    const result = auditTarget(fixturesDir);
    assert.ok(result.summary.totalFindings >= 16);

    const sarifRaw = formatSarif(result);
    const sarif = JSON.parse(sarifRaw) as {
      $schema: string;
      version: string;
      runs: Array<{
        tool: {
          driver: {
            name: string;
            version: string;
            rules: Array<{ id: string; defaultConfiguration: { level: string } }>;
          };
        };
        results: Array<{
          ruleId: string;
          level: string;
          message: { text: string };
          locations: Array<{
            physicalLocation: {
              artifactLocation: { uri: string };
              region: { startLine: number; startColumn: number };
            };
          }>;
        }>;
      }>;
    };

    assert.equal(sarif.version, '2.1.0');
    assert.ok(sarif.$schema.includes('sarif-2.1.0'));
    assert.equal(sarif.runs.length, 1);

    const run = sarif.runs[0]!;
    assert.equal(run.tool.driver.name, '@pie527645-cloud/fetch-resilience-audit');
    assert.deepEqual(
      run.tool.driver.rules.map((r) => r.id),
      [...RULE_IDS]
    );
    assert.equal(run.results.length, result.findings.length);

    for (const item of run.results) {
      assert.ok(RULE_IDS.includes(item.ruleId as (typeof RULE_IDS)[number]));
      const loc = item.locations[0]!.physicalLocation;
      assert.ok(!loc.artifactLocation.uri.includes('\\'));
      assert.ok(loc.region.startLine >= 1);
      assert.ok(loc.region.startColumn >= 1);
    }
  });

  it('emits structured JSON output and evaluates shouldFailOn thresholds accurately', () => {
    const lowOnly = auditTarget(path.join(fixturesDir, 'fra004-positive.ts'));
    assert.equal(shouldFailOn(lowOnly.findings, 'high'), false);
    assert.equal(shouldFailOn(lowOnly.findings, 'medium'), false);
    assert.equal(shouldFailOn(lowOnly.findings, 'low'), true);
    assert.equal(shouldFailOn(lowOnly.findings, 'info'), true);
    assert.equal(shouldFailOn(lowOnly.findings, 'none'), false);

    const parsedJson = JSON.parse(formatJson(lowOnly)) as {
      summary: { totalFindings: number; byRule: Record<string, number> };
    };
    assert.equal(parsedJson.summary.totalFindings, 5);
    assert.equal(parsedJson.summary.byRule['FRA004'], 5);
  });

  it('never references user home-directory APIs anywhere in src/', () => {
    const srcRoot = path.resolve('src');
    const forbiddenApi = ['home', 'dir'].join('');
    function checkDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          assert.equal(text.includes(forbiddenApi), false, `Unexpected API in ${entry.name}`);
        }
      }
    }
    checkDir(srcRoot);
  });
});
