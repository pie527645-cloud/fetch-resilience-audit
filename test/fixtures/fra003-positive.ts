import { request } from 'undici';

const moduleTimeoutSignal = AbortSignal.timeout(5_000);

export async function sharedModuleSignalInForOf(urls: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const url of urls) {
    const res = await fetch(url, { signal: moduleTimeoutSignal });
    results.push(await res.text());
  }
  return results;
}

export async function sharedLocalSignalInRetryLoop(url: string): Promise<unknown> {
  const signal = AbortSignal.timeout(2_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { signal });
    if (res.ok) {
      return await res.json();
    }
    await res.body?.cancel();
  }
  throw new Error('Failed after retries');
}

export async function sharedOptionsObjectInWhileLoop(urls: string[]): Promise<void> {
  const opts = { signal: AbortSignal.timeout(3_000) };
  let idx = 0;
  while (idx < urls.length) {
    const target = urls[idx]!;
    const { body } = await request(target, opts);
    await body.dump();
    idx += 1;
  }
}
