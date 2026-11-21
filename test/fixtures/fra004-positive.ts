import { request } from 'undici';

export async function unboundedPromiseAllFetch(urls: string[]): Promise<Response[]> {
  return await Promise.all(urls.map((url) => fetch(url)));
}

export async function unboundedPromiseAllSettledUndici(urls: string[]): Promise<unknown[]> {
  return await Promise.allSettled(urls.map((url) => request(url)));
}

export async function literalOverTenUrls(): Promise<Response[]> {
  const elevenUrls = [
    'https://api.example.test/1',
    'https://api.example.test/2',
    'https://api.example.test/3',
    'https://api.example.test/4',
    'https://api.example.test/5',
    'https://api.example.test/6',
    'https://api.example.test/7',
    'https://api.example.test/8',
    'https://api.example.test/9',
    'https://api.example.test/10',
    'https://api.example.test/11'
  ];
  return await Promise.all(elevenUrls.map((url) => fetch(url)));
}

export async function spreadArrayLiteral(extraUrls: string[]): Promise<Response[]> {
  const urls = ['https://api.example.test/base', ...extraUrls];
  return await Promise.all(urls.map((url) => fetch(url)));
}

export async function mutatedConstArray(items: Array<{ endpoint: string }>): Promise<Response[]> {
  const urls: string[] = [];
  for (const item of items) {
    urls.push(item.endpoint);
  }
  return await Promise.all(urls.map((url) => fetch(url)));
}
