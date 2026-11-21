import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { auditFile, auditSource } from '../src/index.js';

const fixturesDir = path.resolve('test', 'fixtures');

describe('FRA003 - Shared AbortSignal.timeout() reused in loop', () => {
  it('flags module-scope, outer-variable, and outer options-object timeout signals in loops', () => {
    const findings = auditFile(path.join(fixturesDir, 'fra003-positive.ts'));
    const fra003 = findings.filter((f) => f.ruleId === 'FRA003');
    assert.equal(fra003.length, 3);
    for (const f of fra003) {
      assert.equal(f.severity, 'medium');
    }
  });

  it('stays completely clean when AbortSignal.timeout() is created per iteration, shadowed, or outside loops', () => {
    const findings = auditFile(path.join(fixturesDir, 'fra003-clean.ts'));
    assert.deepEqual(findings, []);
  });

  it('flags do..while and for..in loops reusing an outer timeout signal', () => {
    const code = `
      export async function doWhileShared(url: string): Promise<void> {
        const sig = AbortSignal.timeout(1000);
        let tries = 0;
        do {
          const res = await fetch(url, { signal: sig });
          await res.body?.cancel();
          tries += 1;
        } while (tries < 2);
      }

      export async function forInShared(endpoints: Record<string, string>): Promise<void> {
        const sharedOpts = { signal: AbortSignal.timeout(2000) };
        for (const key in endpoints) {
          const res = await fetch(endpoints[key]!, sharedOpts);
          await res.body?.cancel();
        }
      }
    `;
    const findings = auditSource(code, 'other-loops.ts');
    const fra003 = findings.filter((f) => f.ruleId === 'FRA003');
    assert.equal(fra003.length, 2);
  });
});
