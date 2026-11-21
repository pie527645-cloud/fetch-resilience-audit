import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { auditFile, auditSource } from '../src/index.js';

const fixturesDir = path.resolve('test', 'fixtures');

describe('FRA004 - Unbounded Promise.all / Promise.allSettled fan-out', () => {
  it('flags unbounded Promise.all, Promise.allSettled, >10 literals, spread literals, and mutated const arrays', () => {
    const findings = auditFile(path.join(fixturesDir, 'fra004-positive.ts'));
    const fra004 = findings.filter((f) => f.ruleId === 'FRA004');
    assert.equal(fra004.length, 5);
    for (const f of fra004) {
      assert.equal(f.severity, 'low');
    }
  });

  it('stays clean for p-limit, p-queue, limit wrapper, semaphore, throat, bottleneck, <=10 literals, and .slice()', () => {
    const findings = auditFile(path.join(fixturesDir, 'fra004-clean.ts'));
    assert.deepEqual(findings, []);
  });

  it('allows exact 10-element const array literal without spreads', () => {
    const code = `
      export async function tenItems(): Promise<Response[]> {
        const urls = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
        return await Promise.all(urls.map((u) => fetch(u)));
      }
    `;
    assert.deepEqual(auditSource(code, 'ten.ts'), []);
  });
});
