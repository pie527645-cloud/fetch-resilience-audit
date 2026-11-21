import { Pool, request } from 'undici';

export async function leakDirectUndiciBody(url: string): Promise<unknown> {
  const res = await request(url);
  if (res.statusCode >= 400) {
    throw new Error(`HTTP ${res.statusCode}`);
  }
  return await res.body.json();
}

export async function leakDestructuredUndiciBody(url: string): Promise<string | null> {
  const { statusCode, body } = await request(url);
  if (statusCode !== 200) {
    return null;
  }
  return await body.text();
}

export async function leakOmittedUndiciBody(url: string): Promise<boolean> {
  const { statusCode } = await request(url);
  return statusCode === 200;
}

export async function leakPoolRequest(origin: string): Promise<unknown> {
  const pool = new Pool(origin);
  const { statusCode, body } = await pool.request({ path: '/health', method: 'GET' });
  if (statusCode !== 200) {
    throw new Error('Unhealthy upstream');
  }
  return await body.json();
}
