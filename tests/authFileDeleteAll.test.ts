import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import ru from '@/i18n/locales/ru.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import { summarizeDeleteAll } from '@/features/authFiles/deleteAll';
import { authFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import type { AuthFileItem } from '@/types/authFile';

const file = (name: string, runtimeOnly = false): AuthFileItem => ({ name, runtimeOnly });
const locales = { en, ru, 'zh-CN': zhCN, 'zh-TW': zhTW };
const before = [file('a.json'), file('b.json'), file('c.json'), file('virtual', true)];

describe('delete all credentials', () => {
  test('reports success when the fresh listing has only runtime-only credentials', () => {
    expect(summarizeDeleteAll(before, 3, [file('virtual', true)])).toEqual({ kind: 'success' });
    expect(summarizeDeleteAll(before, undefined, [])).toEqual({ kind: 'success' });
  });

  test('reports a partial deletion when files remain after a 200 response', () => {
    expect(summarizeDeleteAll(before, 1, [file('b.json'), file('c.json')])).toEqual({
      kind: 'partial',
      deleted: 1,
      expected: 3,
    });
    // An older server without the count: derive it from what remains.
    expect(summarizeDeleteAll(before, undefined, [file('c.json')])).toEqual({
      kind: 'partial',
      deleted: 2,
      expected: 3,
    });
  });

  test('is unverified when the listing could not be reloaded, whatever the count', () => {
    // The count covers every removable file in the auth directory, listed or not, so even
    // a count that covers the listed files does not prove they are gone.
    expect(summarizeDeleteAll(before, 3, null)).toEqual({ kind: 'unverified', deleted: 3 });
    expect(summarizeDeleteAll(before, 2, null)).toEqual({ kind: 'unverified', deleted: 2 });
    expect(summarizeDeleteAll([file('a.json')], undefined, null)).toEqual({
      kind: 'unverified',
      deleted: null,
    });
  });

  test('says an unverified deletion is unconfirmed in every locale', async () => {
    for (const [lng, translation] of Object.entries(locales)) {
      const i18n = createInstance();
      await i18n.init({ lng, resources: { [lng]: { translation } } });
      const counted = i18n.t('auth_files.delete_all_unverified', { count: 2 });
      expect(counted).toContain('2');
      expect(counted).not.toContain('auth_files.');
      expect(i18n.t('auth_files.delete_all_unverified', { count: 1 })).not.toContain('auth_files.');
      expect(i18n.t('auth_files.delete_all_unverified_unknown')).not.toContain('auth_files.');
    }
  });

  test('the API returns the backend deleted count', async () => {
    const del = spyOn(apiClient, 'delete');
    try {
      del.mockResolvedValue({ status: 'ok', deleted: 2 });
      expect(await authFilesApi.deleteAll()).toEqual({ deleted: 2 });
      expect(del).toHaveBeenCalledWith('/credentials', { params: { all: true } });
      for (const payload of [{ status: 'ok' }, { deleted: '2' }, { deleted: -1 }, '']) {
        del.mockResolvedValue(payload);
        expect(await authFilesApi.deleteAll()).toEqual({});
      }
    } finally {
      del.mockRestore();
    }
  });

  test('the page reconciles from a fresh listing instead of clearing rows locally', () => {
    const source = readFileSync(
      new URL('../src/features/authFiles/hooks/useAuthFilesData.ts', import.meta.url),
      'utf8'
    );
    const branch = source.split('authFilesApi.deleteAll()')[1].split('const filesToDelete')[0];
    expect(branch).toContain('summarizeDeleteAll(');
    expect(branch).toContain('await fetchFiles({ background: true })');
    expect(branch).toContain("t('auth_files.delete_all_partial'");
    expect(branch).toContain("t('auth_files.delete_all_unverified'");
    expect(branch).not.toContain('setFiles(');
  });
});
