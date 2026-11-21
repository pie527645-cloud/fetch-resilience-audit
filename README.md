# @pie527645-cloud/fetch-resilience-audit

Static TypeScript AST auditor for Node.js `fetch()` and Undici `request()` resilience defects: unconsumed response body socket/pool leaks, loop-shared `AbortSignal.timeout()` instances, and unbounded `Promise.all` / `Promise.allSettled` network fan-out.

## Requirements

- Node.js `>= 20.18.1`

## Installation

```bash
npm install --save-dev @pie527645-cloud/fetch-resilience-audit
```

## CLI Usage

```bash
fetch-resilience-audit check [target] [--format text|json|sarif] [--fail-on high|medium|low|info|none] [--include-tests]
```

### Options

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `[target]` | Path | `.` | File or directory to audit. |
| `--format` | `text`, `json`, `sarif` | `text` | Output format (`sarif` emits SARIF v2.1.0). |
| `--fail-on` | `high`, `medium`, `low`, `info`, `none` | `medium` | Minimum finding severity that triggers exit code `1`. |
| `--include-tests` | Boolean flag | `false` | Include `test/`, `tests/`, `__tests__/`, `*.test.*`, and `*.spec.*` when scanning directories. |
| `-h`, `--help` | Boolean flag | - | Print CLI usage information. |
| `-v`, `--version` | Boolean flag | - | Print package version. |

### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Clean scan, `--fail-on none`, or all findings are strictly below the `--fail-on` severity threshold. |
| `1` | One or more findings meet or exceed the `--fail-on` severity threshold. |
| `2` | Invalid CLI arguments, missing target path, blocked path traversal, or `SYMLINK_ESCAPE_BLOCKED`. |

## Rules

| Rule ID | Severity | Summary |
| --- | --- | --- |
| `FRA001` | `medium` | `fetch()` response body is neither consumed nor cancelled (`await res.body?.cancel()`) on an early `return`/`throw` branch or before function exit. |
| `FRA002` | `medium` | Undici `request()` (including `Client`/`Pool`/`Agent` `.request()`) response `body` is omitted in destructuring or neither consumed nor drained (`await body.dump()`) on an exit or error branch. |
| `FRA003` | `medium` | `AbortSignal.timeout(...)` assigned outside a loop (`for`, `for..of`, `for..in`, `while`, `do..while`) or inside an outer options object is reused inside that loop in `fetch()` / `request()`. |
| `FRA004` | `low` | `Promise.all` / `Promise.allSettled` maps over an unbounded array performing `fetch()` / `request()` calls without a concurrency limiter (`p-limit`, `p-map`, `p-queue`, `semaphore`, `throat`, `bottleneck`) or `.slice(...)` batching. |

### Resilient Examples

#### `FRA001` — Cancel unconsumed `fetch()` error responses

```ts
export async function fetchUserProfile(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}
```

#### `FRA002` — Drain unconsumed Undici `request()` bodies

```ts
import { request } from 'undici';

export async function getStatusPayload(url: string): Promise<unknown> {
  const { statusCode, body } = await request(url);
  if (statusCode !== 200) {
    await body.dump();
    throw new Error(`Unexpected status ${statusCode}`);
  }
  return await body.json();
}
```

#### `FRA003` — Create `AbortSignal.timeout()` per loop iteration

```ts
export async function fetchWithRetry(url: string, attempts = 3): Promise<unknown> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      return await res.json();
    }
    await res.body?.cancel();
  }
  throw new Error('Exhausted retries');
}
```

#### `FRA004` — Bound concurrent fan-out

```ts
import pLimit from 'p-limit';

const limit = pLimit(8);

export async function fetchMany(urls: string[]): Promise<string[]> {
  return await Promise.all(
    urls.map((url) =>
      limit(async () => {
        const res = await fetch(url);
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`Failed ${url}`);
        }
        return await res.text();
      })
    )
  );
}
```

## Programmatic API

```ts
import { auditSource, auditTarget, formatSarif, shouldFailOn } from '@pie527645-cloud/fetch-resilience-audit';

const inlineFindings = auditSource(sourceCode, 'src/client.ts');
const result = auditTarget('./src');
const sarifJson = formatSarif(result);
const failed = shouldFailOn(result.findings, 'medium');
```

## Prior Art

`@pie527645-cloud/fetch-resilience-audit` intentionally narrows its scope to decidable AST dataflow gaps rather than duplicating existing lint rules:

- **`eslint-plugin-unicorn` (`prefer-abort-signal-timeout`)**, **`eslint-plugin-reliability` (`require-network-timeout`)**, and **Bun lint rules (`prefer-timeout-signal`, `no-unbounded-requests`)**: Existing ecosystem linters already check whether a timeout signal is present on network calls or prefer `AbortSignal.timeout()` syntax. Therefore, generic "missing timeout / missing `AbortSignal`" checks are excluded here. Instead, this tool targets control-flow and lifecycle bugs those rules leave open: unconsumed response streams across error/early-return branches (`FRA001`, `FRA002`), reusing a single outer `AbortSignal.timeout()` instance across retry/loop iterations where subsequent iterations inherit a decaying or already-aborted signal (`FRA003`), and unbounded `Promise.all` / `Promise.allSettled` array `.map(...)` fan-out (`FRA004`, complementing Bun's `no-unbounded-requests` in standard Node.js TypeScript codebases with awareness of `p-limit`, `p-queue`, `bottleneck`, `throat`, semaphores, bounded literals, and `.slice()` batching).
- **Undici response body socket & memory leaks (`GHSA-9f24-jqhm-jfcw`, `nodejs/undici#3353`)**: Undici's HTTP client architecture requires callers of `request()` (and `fetch()` on non-consumed branches) to either consume or explicitly drain/cancel response bodies (`await body.dump()` / `await res.body?.cancel()`). As documented in `nodejs/undici#3353` and related Undici security/resource advisories such as `GHSA-9f24-jqhm-jfcw`, leaving response bodies unread on `!res.ok` throws, early `return` paths, or destructured `{ statusCode }` calls without `body` can pin underlying sockets, stall connection pools, and retain buffered response chunks in memory until garbage collection.

## License

MIT
