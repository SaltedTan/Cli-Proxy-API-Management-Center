import { describe, expect, test } from 'bun:test';
import { createListingLoader } from '@/features/quota/listingLoader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const loader = createListingLoader();
  const state = { files: [] as string[], loading: false, error: '' };
  const load = (fetch: () => Promise<string[]>, background = false) =>
    loader.load({
      background,
      fetch,
      isSessionCurrent: () => true,
      commit: (files) => {
        state.files = files;
      },
      setLoading: (loading) => {
        state.loading = loading;
      },
      setError: (error) => {
        state.error = error;
      },
      errorMessage: (err) => (err instanceof Error ? err.message : 'failed'),
    });
  return { load, state };
}

describe('quota listing loader', () => {
  test('a background load that supersedes a pending foreground load reports its failure', async () => {
    const { load, state } = setup();
    const foreground = deferred<string[]>();
    const background = deferred<string[]>();
    const foregroundDone = load(() => foreground.promise);
    const backgroundDone = load(() => background.promise, true);

    foreground.resolve(['dropped']);
    await foregroundDone;
    expect(state.loading).toBe(true);

    background.reject(new Error('listing unavailable'));
    await backgroundDone;
    expect(state.files).toEqual([]);
    expect(state.error).toBe('listing unavailable');
    expect(state.loading).toBe(false);
  });

  test('a background load that supersedes a pending foreground load ends its loading state', async () => {
    const { load, state } = setup();
    const foreground = deferred<string[]>();
    const foregroundDone = load(() => foreground.promise);
    await load(async () => ['fresh'], true);
    expect(state.files).toEqual(['fresh']);
    expect(state.loading).toBe(false);

    foreground.resolve(['stale']);
    await foregroundDone;
    expect(state.files).toEqual(['fresh']);
  });

  test('a lone background failure keeps the list and stays silent', async () => {
    const { load, state } = setup();
    await load(async () => ['current']);
    await load(async () => {
      throw new Error('listing unavailable');
    }, true);
    expect(state.files).toEqual(['current']);
    expect(state.error).toBe('');
    expect(state.loading).toBe(false);
  });

  test('a lone background load does not show the loading state', async () => {
    const { load, state } = setup();
    await load(async () => ['current']);
    const background = deferred<string[]>();
    const backgroundDone = load(() => background.promise, true);
    expect(state.loading).toBe(false);
    background.resolve(['fresh']);
    await backgroundDone;
    expect(state.files).toEqual(['fresh']);
  });

  test('a successful background load clears an earlier listing error', async () => {
    const { load, state } = setup();
    await load(async () => {
      throw new Error('listing unavailable');
    });
    expect(state.error).toBe('listing unavailable');

    await load(async () => ['fresh'], true);
    expect(state.files).toEqual(['fresh']);
    expect(state.error).toBe('');
  });
});
