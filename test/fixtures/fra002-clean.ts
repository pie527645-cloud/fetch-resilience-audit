import { Client, Pool, request } from 'undici';

declare function handleBodyStream(body: unknown): Promise<string>;

export async function cleanDestructuredDumpOnError(url: string): Promise<unknown> {
  const { statusCode, body } = await request(url);
  if (!statusCode) {
    await body.dump();
    throw new Error('Missing status code');
  }
  if (statusCode >= 400) {
    await body.dump();
    throw new Error(`Unexpected status ${statusCode}`);
  }
  return await body.json();
}

export async function cleanDirectResBodyDump(url: string): Promise<string | null> {
  const res = await request(url);
  if (res.statusCode !== 200) {
    await res.body.dump();
    return null;
  }
  return await res.body.text();
}

export async function cleanHeadOmittedBody(url: string): Promise<boolean> {
  const { statusCode } = await request(url, { method: 'HEAD' });
  return statusCode === 200;
}

export async function cleanPoolFinallyDestroy(origin: string): Promise<unknown> {
  const pool = new Pool(origin);
  const { statusCode, body } = await pool.request({ path: '/items', method: 'GET' });
  try {
    if (statusCode !== 200) {
      throw new Error('Failed');
    }
    return await body.json();
  } finally {
    await body.destroy();
  }
}

export async function cleanClientHelper(client: Client): Promise<string> {
  const { body } = await client.request({ path: '/stream', method: 'GET' });
  return await handleBodyStream(body);
}

export async function cleanFinallyUnguardedDump(url: string): Promise<unknown> {
  const { statusCode, body } = await request(url);
  try {
    if (statusCode !== 200) {
      throw new Error(`HTTP ${statusCode}`);
    }
    return await body.json();
  } finally {
    await body.dump();
  }
}

export async function cleanFinallyGuardedDump(url: string): Promise<unknown> {
  const { statusCode, body } = await request(url);
  let done = false;
  try {
    if (statusCode !== 200) {
      throw new Error(`HTTP ${statusCode}`);
    }
    const parsed = await body.json();
    done = true;
    return parsed;
  } finally {
    if (!done) await body.dump();
  }
}
