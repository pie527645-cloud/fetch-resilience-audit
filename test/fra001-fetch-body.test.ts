import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { auditFile, auditSource } from '../src/index.js';

const fixturesDir = path.resolve('test', 'fixtures');

describe('FRA001 - Unconsumed fetch() response body', () => {
  it('flags all positive leak patterns in fra001-positive.ts', () => {
    const findings = auditFile(path.join(fixturesDir, 'fra001-positive.ts'));
    const fra001 = findings.filter((f) => f.ruleId === 'FRA001');
    assert.equal(fra001.length, 4);
    for (const f of fra001) {
      assert.equal(f.severity, 'medium');
    }
  });

  it('stays completely clean on fra001-clean.ts including res.body?.cancel() before throw', () => {
    const findings = auditFile(path.join(fixturesDir, 'fra001-clean.ts'));
    assert.deepEqual(findings, []);
  });

  it('flags undici fetch import when unconsumed on early return', () => {
    const code = `
      import { fetch } from 'undici';
      export async function check(url: string): Promise<string | null> {
        const res = await fetch(url);
        if (!res.ok) {
          return null;
        }
        return await res.text();
      }
    `;
    const findings = auditSource(code, 'undici-fetch.ts');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.ruleId, 'FRA001');
  });

  it('does not flag non-HTTP custom .fetch() methods or returned Response objects', () => {
    const code = `
      interface Cache { fetch(key: string): Promise<{ ok: boolean; value: string }>; }
      export async function fromCache(cache: Cache, key: string): Promise<string> {
        const res = await cache.fetch(key);
        if (!res.ok) {
          throw new Error('Cache miss');
        }
        return res.value;
      }

      export async function passthrough(url: string): Promise<Response> {
        const res = await fetch(url);
        if (!res.ok) {
          await res.body?.destroy();
          throw new Error('Upstream error');
        }
        return res;
      }
    `;
    const findings = auditSource(code, 'custom-fetch.ts');
    assert.deepEqual(findings, []);
  });

  it('recognizes all standard Response consumers (.bytes, .blob, .arrayBuffer, .formData, .pipeThrough, .getReader)', () => {
    const code = `
      export async function c1(u: string) { const r = await fetch(u); return await r.bytes(); }
      export async function c2(u: string) { const r = await fetch(u); return await r.blob(); }
      export async function c3(u: string) { const r = await fetch(u); return await r.arrayBuffer(); }
      export async function c4(u: string) { const r = await fetch(u); return await r.formData(); }
      export async function c5(u: string, t: TransformStream) {
        const r = await fetch(u);
        return r.body?.pipeThrough(t);
      }
      export async function c6(u: string) {
        const r = await fetch(u);
        return r.body?.getReader();
      }
    `;
    const findings = auditSource(code, 'consumers.ts');
    assert.deepEqual(findings, []);
  });

  it('flags try/catch that swallows throw without cancelling unconsumed fetch body', () => {
    const leaking = `
      export async function leakyTryCatch(url: string): Promise<unknown> {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error('Bad status');
          }
          return await res.json();
        } catch {
          return null;
        }
      }
    `;
    const clean = `
      export async function cleanTryCatch(url: string): Promise<unknown> {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            await res.body?.cancel();
            throw new Error('Bad status');
          }
          return await res.json();
        } catch {
          return null;
        }
      }
    `;
    assert.equal(auditSource(leaking, 'leaky.ts').length, 1);
    assert.equal(auditSource(clean, 'clean.ts').length, 0);
  });
});
