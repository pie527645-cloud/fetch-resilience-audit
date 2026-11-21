import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';

declare function consumeHelper(res: Response): Promise<string>;
declare function forwardStream(stream: ReadableStream<Uint8Array> | null): Promise<void>;

export async function cleanCancelOnError(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

export async function cleanReturnResponseDirectly(url: string): Promise<Response> {
  const res = await fetch(url);
  return res;
}

export async function cleanTryFinally(url: string): Promise<unknown> {
  const res = await fetch(url);
  try {
    if (!res.ok) {
      throw new Error('Bad response');
    }
    return await res.json();
  } finally {
    await res.body?.cancel();
  }
}

export async function cleanGuardedBodyUsedTryFinally(u: string): Promise<unknown> {
  const res = await fetch(u);
  try { if (!res.ok) throw new Error('x'); return await res.json(); }
  finally { if (!res.bodyUsed) await res.body?.cancel(); }
}

export async function cleanHelperPass(url: string): Promise<string> {
  const res = await fetch(url);
  return await consumeHelper(res);
}

export async function cleanBodyHelperPass(url: string): Promise<void> {
  const res = await fetch(url);
  await forwardStream(res.body);
}

export async function cleanHeadRequest(url: string): Promise<string | null> {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) {
    throw new Error('HEAD check failed');
  }
  return res.headers.get('etag');
}

export async function cleanAsyncIterator(url: string): Promise<number> {
  const res = await fetch(url);
  if (!res.body) {
    return 0;
  }
  let bytes = 0;
  for await (const chunk of res.body) {
    bytes += chunk.byteLength;
  }
  return bytes;
}

export async function cleanPipeline(url: string, dest: Writable): Promise<void> {
  const res = await fetch(url);
  if (!res.body) {
    return;
  }
  await pipeline(res.body, dest);
}
