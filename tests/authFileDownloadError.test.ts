import { describe, expect, spyOn, test } from 'bun:test';
import { AxiosError, AxiosHeaders, type AxiosInstance } from 'axios';
import { authFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import type { ApiError } from '@/types';

describe('credential download errors', () => {
  test('decodes the JSON error body that arrives as a Blob', async () => {
    const instance = (apiClient as unknown as { instance: AxiosInstance }).instance;
    const adapter = instance.defaults.adapter;
    const body = new Blob([JSON.stringify({ error: 'file not found' })], {
      type: 'application/json',
    });
    instance.defaults.adapter = async (config) => {
      expect(config.responseType).toBe('blob');
      throw new AxiosError(
        'Request failed with status code 404',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        { data: body, status: 404, statusText: 'Not Found', headers: new AxiosHeaders(), config }
      );
    };
    try {
      const error = await authFilesApi.download('gone.json').catch((err: ApiError) => err);
      expect(error).toMatchObject({
        name: 'ApiError',
        message: 'file not found',
        status: 404,
        code: 'ERR_BAD_REQUEST',
        apiCode: 'file not found',
      });
      await expect(authFilesApi.downloadText('gone.json')).rejects.toThrow('file not found');
    } finally {
      instance.defaults.adapter = adapter;
    }
  });

  test('keeps the original error for non-JSON or missing bodies', async () => {
    const raw = spyOn(apiClient, 'getRaw');
    try {
      for (const data of [undefined, new Blob(['<html>Bad gateway</html>']), new Blob([''])]) {
        const error = Object.assign(new Error('original'), { status: 502, data });
        raw.mockRejectedValue(error);
        await expect(authFilesApi.download('x.json')).rejects.toBe(error);
        expect(error.message).toBe('original');
      }
    } finally {
      raw.mockRestore();
    }
  });

  test('returns the file contents on success', async () => {
    const raw = spyOn(apiClient, 'getRaw').mockResolvedValue({
      data: new Blob(['{"error":"this is credential content"}']),
    } as never);
    try {
      expect(await authFilesApi.downloadText('ok.json')).toBe(
        '{"error":"this is credential content"}'
      );
    } finally {
      raw.mockRestore();
    }
  });
});
