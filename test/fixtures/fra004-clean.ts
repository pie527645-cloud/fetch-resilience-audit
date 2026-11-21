import pLimit from 'p-limit';
import pMap from 'p-map';
import PQueue from 'p-queue';
import throat from 'throat';
import Bottleneck from 'bottleneck';

const runLimited = pLimit(6);
const workQueue = new PQueue({ concurrency: 4 });
const apiBottleneck = new Bottleneck({ maxConcurrent: 5 });

declare const semaphore: {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
};

declare function limit<T>(fn: () => Promise<T>): Promise<T>;

export async function cleanWithPLimit(urls: string[]): Promise<Response[]> {
  return await Promise.all(urls.map((url) => runLimited(() => fetch(url))));
}

export async function cleanWithPMap(groups: string[][]): Promise<Response[][]> {
  return await Promise.all(
    groups.map((group) => pMap(group, (url: string) => fetch(url), { concurrency: 4 }))
  );
}

export async function cleanWithPQueue(urls: string[]): Promise<unknown[]> {
  return await Promise.all(urls.map((url) => workQueue.add(() => fetch(url))));
}

export async function cleanWithGenericLimitWrapper(urls: string[]): Promise<Response[]> {
  return await Promise.all(urls.map((url) => limit(() => fetch(url))));
}

export async function cleanWithSemaphore(urls: string[]): Promise<Response[]> {
  return await Promise.allSettled(urls.map((url) => semaphore.runExclusive(() => fetch(url))));
}

export async function cleanWithThroat(urls: string[]): Promise<Response[]> {
  return await Promise.all(urls.map(throat(5, (url: string) => fetch(url))));
}

export async function cleanWithBottleneck(urls: string[]): Promise<Response[]> {
  return await Promise.all(urls.map((url) => apiBottleneck.schedule(() => fetch(url))));
}

export async function cleanDirectSmallLiteral(): Promise<Response[]> {
  return await Promise.all(
    ['https://a.example.test', 'https://b.example.test', 'https://c.example.test'].map((u) =>
      fetch(u)
    )
  );
}

export async function cleanConstSmallLiteral(): Promise<Response[]> {
  const urls = ['https://one.example.test', 'https://two.example.test'] as const;
  return await Promise.all(urls.map((u) => fetch(u)));
}

export async function cleanSliceBatching(urls: string[]): Promise<Response[]> {
  const collected: Response[] = [];
  for (let i = 0; i < urls.length; i += 5) {
    const batch = await Promise.all(urls.slice(i, i + 5).map((u) => fetch(u)));
    collected.push(...batch);
  }
  return collected;
}
