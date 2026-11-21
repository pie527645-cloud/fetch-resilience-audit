import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { auditFile, auditSource } from '../src/index.js';

const fixturesDir = path.resolve('test', 'fixtures');

describe('FRA002 - Unconsumed Undici request() response body', () => {
  it('flags direct res.body, destructured { statusCode, body }, omitted { statusCode }, and Pool.request leaks', () => {
    const findings = auditFile(path.join(fixturesDir, 'fra002-positive.ts'));
    const fra002 = findings.filter((f) => f.ruleId === 'FRA002');
    assert.equal(fra002.length, 4);
    for (const f of fra002) {
      assert.equal(f.severity, 'medium');
    }
  });

  it('stays completely clean on fra002-clean.ts including body.dump() on error branch', () => {
    const findings = auditFile(path.join(fixturesDir, 'fra002-clean.ts'));
    assert.deepEqual(findings, []);
  });

  it('detects CommonJS require("undici") and namespace import undici.request leaks', () => {
    const code = `
      const undici = require('undici');
      export async function cjsLeak(url: string): Promise<number> {
        const { statusCode } = await undici.request(url);
        return statusCode;
      }
    `;
    const findings = auditSource(code, 'cjs-undici.ts');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.ruleId, 'FRA002');
  });

  it('detects Agent and Client .request() leaks and allows .resume() / .pipe()', () => {
    const leakyCode = `
      import { Agent } from 'undici';
      const agent = new Agent();
      export async function checkAgent(origin: string): Promise<void> {
        const res = await agent.request({ origin, path: '/ping', method: 'GET' });
        if (res.statusCode !== 200) {
          return;
        }
        await res.body.dump();
      }
    `;
    const cleanCode = `
      import { Agent } from 'undici';
      import type { Writable } from 'node:stream';
      const agent = new Agent();
      export async function pipeAgent(origin: string, out: Writable): Promise<void> {
        const { statusCode, body } = await agent.request({ origin, path: '/dl', method: 'GET' });
        if (statusCode !== 200) {
          body.resume();
          return;
        }
        body.pipe(out);
      }
    `;
    assert.equal(auditSource(leakyCode, 'agent-leak.ts').length, 1);
    assert.equal(auditSource(cleanCode, 'agent-clean.ts').length, 0);
  });
});
