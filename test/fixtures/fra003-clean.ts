import { request } from 'undici';

export async function cleanFreshSignalInsideLoop(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const signal = AbortSignal.timeout(2_000);
    const res = await fetch(url, { signal });
    if (res.ok) {
      return await res.json();
    }
    await res.body?.cancel();
  }
  throw new Error('Exhausted retries');
}

export async function cleanInlineSignalInsideLoop(urls: string[]): Promise<void> {
  for (const url of urls) {
    const { body } = await request(url, { signal: AbortSignal.timeout(2_500) });
    await body.dump();
  }
}

export async function cleanShadowedSignalInsideLoop(urls: string[]): Promise<string[]> {
  const signal = AbortSignal.timeout(10_000);
  const firstRes = await fetch('https://status.example.test', { signal });
  await firstRes.body?.cancel();

  const out: string[] = [];
  for (const url of urls) {
    const signal = AbortSignal.timeout(1_500);
    const res = await fetch(url, { signal });
    out.push(await res.text());
  }
  return out;
}

export async function cleanSignalOutsideAnyLoop(url: string): Promise<unknown> {
  const opts = { signal: AbortSignal.timeout(4_000) };
  const res = await fetch(url, opts);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error('Request failed');
  }
  return await res.json();
}
