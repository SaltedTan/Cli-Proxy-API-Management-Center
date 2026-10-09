import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createElement, type KeyboardEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { apiClient } from '@/services/api/client';
import { clientUsageApi, normalizeClientUsage } from '@/services/api/clientUsage';
import { clientUsageLimitsApi } from '@/services/api/clientUsageLimits';
import {
  ClaudeLimitEditorForm,
  ClientUsagePanel,
  RemoveKeyConfirm,
  WindowResetConfirm,
} from '@/features/dashboard/components/ClientUsagePanel';
import {
  ClientKeyBusyError,
  clientKeyMutations,
  createClientKeyMutationLock,
  isClientKeyBusy,
} from '@/features/dashboard/clientKeyMutations';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

const REMOVED_ID = 'c0ffee00c0ffee00';
const OTHER_ID = 'ab1e00ab1e00ab1e';
const LIMITS = '/config/access/api-key-limits';
const HISTORY = `/observability/usage/clients?id=${REMOVED_ID}`;
const NOW = Date.parse('2026-10-07T12:00:00Z');

/** A promise settled from outside, to hold a mutation in flight. */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

describe('client key mutation lock', () => {
  test('refuses a second mutation of the same key without running it', async () => {
    const lock = createClientKeyMutationLock();
    const removal = deferred();
    const removing = lock.run(REMOVED_ID, 'remove', () => removal.promise);
    expect(lock.holder(REMOVED_ID)).toBe('remove');

    for (const mutation of ['save', 'reset', 'remove'] as const) {
      const task = mock(async () => undefined);
      const refused = await lock.run(REMOVED_ID, mutation, task).catch((error) => error);
      expect(refused).toBeInstanceOf(ClientKeyBusyError);
      expect(isClientKeyBusy(refused)).toBe(true);
      expect(refused).toMatchObject({ keyId: REMOVED_ID, holder: 'remove' });
      expect(task).not.toHaveBeenCalled();
    }
    // Other keys are not held up.
    expect(await lock.run(OTHER_ID, 'save', async () => 'saved')).toBe('saved');
    expect(lock.holder(OTHER_ID)).toBeNull();

    removal.resolve();
    await removing;
    expect(lock.holder(REMOVED_ID)).toBeNull();
    expect(await lock.run(REMOVED_ID, 'save', async () => 'saved')).toBe('saved');
  });

  test('is released when the mutation fails, and notifies subscribers both ways', async () => {
    const lock = createClientKeyMutationLock();
    const seen: Array<string | null> = [];
    const unsubscribe = lock.subscribe(() => seen.push(lock.holder(REMOVED_ID)));
    const failure = new Error('network');
    await expect(
      lock.run(REMOVED_ID, 'reset', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(lock.holder(REMOVED_ID)).toBeNull();
    expect(seen).toEqual(['reset', null]);
    unsubscribe();
    await lock.run(REMOVED_ID, 'save', async () => undefined);
    expect(seen).toHaveLength(2);
    expect(isClientKeyBusy(failure)).toBe(false);
  });

  test('a save made while a removal deletes the history is refused, so the key stays gone', async () => {
    // The audited race: clear the allowance, begin the history DELETE, save an allowance
    // of 2, then the DELETE finishes. The save used to leave `{id: 2}` behind, and the
    // backend lists allowance-only keys, so the removed row came back.
    let limits: Record<string, number> = { [REMOVED_ID]: 1, [OTHER_ID]: 0.25 };
    const history = deferred();
    let historyDeleteStarted = false;
    const spy = <M extends 'get' | 'put' | 'delete' | 'getConnectionRevision'>(method: M) => {
      const created = spyOn(apiClient, method);
      spies.push(created);
      return created;
    };
    spy('getConnectionRevision').mockReturnValue(1);
    spy('get').mockImplementation((async () => ({ ...limits })) as never);
    spy('put').mockImplementation((async (_url: string, body: Record<string, number>) => {
      limits = { ...body };
    }) as never);
    spy('delete').mockImplementation((async (url: string) => {
      if (url === LIMITS) limits = {};
      if (url === HISTORY) {
        historyDeleteStarted = true;
        await history.promise;
      }
    }) as never);

    const lock = createClientKeyMutationLock();
    const removing = lock.run(REMOVED_ID, 'remove', () =>
      clientUsageApi.removeKey(REMOVED_ID, true)
    );
    while (!historyDeleteStarted) await Promise.resolve();
    expect(limits).toEqual({ [OTHER_ID]: 0.25 });

    const save = await lock
      .run(REMOVED_ID, 'save', () => clientUsageLimitsApi.set(REMOVED_ID, 2))
      .catch((error) => error);
    expect(save).toBeInstanceOf(ClientKeyBusyError);

    history.resolve();
    await removing;
    expect(limits).toEqual({ [OTHER_ID]: 0.25 });
    expect(apiClient.put).toHaveBeenCalledTimes(1);
  });
});

describe('client usage panel while a key is locked', () => {
  const snapshot = normalizeClientUsage({
    generated_at: '2026-10-07T12:00:00Z',
    claude_limits_supported: true,
    keys: [
      {
        id: REMOVED_ID,
        configured: false,
        last_used_at: '2026-10-07T11:00:00Z',
        totals: { requests: 3, tokens: { total_tokens: 30 } },
        claude: {
          current_pro_units: 0.5,
          total_pro_units: 0.5,
          window_started_at: '2026-10-05T00:00:00Z',
          window_resets_at: '2026-10-12T00:00:00Z',
          limit_pro_units: 1,
          remaining_pro_units: 0.5,
          limit_reached: false,
          credentials: [],
        },
      },
    ],
  });
  const render = () =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          null,
          createElement(ClientUsagePanel, {
            usage: { status: 'ready', data: snapshot },
            localNames: new Map(),
            onSaveLimit: async () => undefined,
            onResetWindow: async () => undefined,
            onRemoveKey: async () => undefined,
            nowMs: NOW,
          })
        )
      )
    );
  const button = (markup: string, label: string) =>
    markup.match(new RegExp(`<button [^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
  const controls = [
    t('dashboard.client_usage_limit_edit', { name: REMOVED_ID }),
    t('dashboard.client_usage_window_reset_label', { name: REMOVED_ID }),
    t('dashboard.client_usage_remove_label', { name: REMOVED_ID }),
  ];

  test("disables the row's edit, reset and remove controls while one of them runs", async () => {
    const free = render();
    for (const label of controls) {
      expect(button(free, label)).not.toBe('');
      expect(button(free, label)).not.toContain('disabled=""');
    }
    const removal = deferred();
    const removing = clientKeyMutations.run(REMOVED_ID, 'remove', () => removal.promise);
    try {
      const locked = render();
      for (const label of controls) {
        expect(button(locked, label)).toContain('disabled=""');
      }
    } finally {
      removal.resolve();
      await removing;
    }
  });

  test('confirmations and the editor wait on the action but keep their way out', () => {
    const name = REMOVED_ID;
    const noop = () => undefined;
    const onKeyDown = (_event: KeyboardEvent<HTMLElement>) => undefined;
    const keepRef = { current: null };
    const withI18n = (element: ReturnType<typeof createElement>) =>
      renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));

    const remove = withI18n(
      createElement(RemoveKeyConfirm, {
        name,
        t,
        withLimit: true,
        removing: false,
        blocked: true,
        keepRef,
        onConfirm: noop,
        onCancel: noop,
        onKeyDown,
      })
    );
    expect(button(remove, t('dashboard.client_usage_remove_yes_label', { name }))).toContain(
      'disabled=""'
    );
    // Only Remove waits; Keep still closes the confirmation.
    expect(remove.match(/disabled=""/g)).toHaveLength(1);

    const reset = withI18n(
      createElement(WindowResetConfirm, {
        name,
        t,
        resetting: false,
        blocked: true,
        keepRef,
        onConfirm: noop,
        onCancel: noop,
        onKeyDown,
      })
    );
    expect(button(reset, t('dashboard.client_usage_window_reset_yes_label', { name }))).toContain(
      'disabled=""'
    );
    expect(reset.match(/disabled=""/g)).toHaveLength(1);

    const editor = withI18n(
      createElement(ClaudeLimitEditorForm, {
        name,
        t,
        draft: '1',
        invalid: false,
        saving: false,
        blocked: true,
        hintId: 'hint',
        inputRef: { current: null },
        onDraftChange: noop,
        onSubmit: noop,
        onCancel: noop,
        onKeyDown,
      })
    );
    expect(button(editor, t('dashboard.client_usage_limit_save', { name }))).toContain(
      'disabled=""'
    );
    expect(editor.match(/disabled=""/g)).toHaveLength(1);
    // The input's description says why Save is unavailable.
    expect(editor).toContain(t('dashboard.client_usage_key_busy'));
    expect(editor).not.toContain(t('dashboard.client_usage_limit_hint'));
  });
});
