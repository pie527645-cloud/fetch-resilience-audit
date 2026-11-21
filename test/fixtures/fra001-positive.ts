export async function leakOnNotOkThrow(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}`);
  }
  return await res.json();
}

export async function leakBeforeCheckingRes(url: string, aborted: boolean): Promise<unknown> {
  const res = await fetch(url);
  if (aborted) {
    throw new Error('Caller aborted before reading response');
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error('Bad status');
  }
  return await res.json();
}

export async function leakOnEarlyReturnNull(url: string): Promise<string | null> {
  const res = await globalThis.fetch(url);
  if (res.status === 404) {
    return null;
  }
  return await res.text();
}

export async function leakOnNeverConsumedExit(url: string): Promise<number> {
  const res = await fetch(url);
  return res.status;
}
