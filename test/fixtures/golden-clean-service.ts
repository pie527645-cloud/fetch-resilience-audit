import { Pool, request } from 'undici';
import pLimit from 'p-limit';

const concurrency = pLimit(8);

export class ResilientGatewayService {
  private readonly pool: Pool;

  public constructor(origin: string) {
    this.pool = new Pool(origin);
  }

  public async getJsonWithRetry<T>(url: string, maxAttempts = 3): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const signal = AbortSignal.timeout(4_000);
      const res = await fetch(url, { signal });
      if (res.ok) {
        return (await res.json()) as T;
      }
      await res.body?.cancel();
      if (res.status < 500) {
        throw new Error(`Non-retryable status ${res.status}`);
      }
    }
    throw new Error('Retries exhausted');
  }

  public async queryPoolEndpoint(pathname: string): Promise<string> {
    const { statusCode, body } = await this.pool.request({
      path: pathname,
      method: 'GET',
      signal: AbortSignal.timeout(3_000)
    });
    if (statusCode !== 200) {
      await body.dump();
      throw new Error(`Pool error ${statusCode}`);
    }
    return await body.text();
  }

  public async checkUpstreamHead(url: string): Promise<boolean> {
    const { statusCode } = await request(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2_000)
    });
    return statusCode === 200;
  }

  public async fetchBatchWithLimit(urls: string[]): Promise<string[]> {
    return await Promise.all(
      urls.map((url) =>
        concurrency(async () => {
          const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
          if (!res.ok) {
            await res.body?.cancel();
            throw new Error(`Batch item failed: ${res.status}`);
          }
          return await res.text();
        })
      )
    );
  }

  public async fetchInSlices(urls: string[]): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < urls.length; i += 6) {
      const sliceResults = await Promise.all(
        urls.slice(i, i + 6).map(async (url) => {
          const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
          if (!res.ok) {
            await res.body?.cancel();
            return '';
          }
          return await res.text();
        })
      );
      out.push(...sliceResults);
    }
    return out;
  }
}
