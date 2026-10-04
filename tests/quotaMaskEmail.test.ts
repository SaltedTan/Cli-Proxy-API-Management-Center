/**
 * Email masking for credential names. Auth files are usually named after the
 * account, so these are the strings a screen share would otherwise leak.
 */

import { describe, expect, test } from 'bun:test';
import { maskEmail, maskEmailsInText } from '@/features/quota/maskEmail';

describe('maskEmail', () => {
  test('keeps the first mailbox and domain letters plus the TLD', () => {
    expect(maskEmail('jane@example.com')).toBe('j•••@e•••.com');
    expect(maskEmail('tom@1bit.dev')).toBe('t•••@1•••.dev');
  });

  test('leaves strings that are not addresses alone', () => {
    expect(maskEmail('no-at-sign')).toBe('no-at-sign');
    expect(maskEmail('@example.com')).toBe('@example.com');
  });
});

describe('maskEmailsInText', () => {
  test('masks the address inside a provider-prefixed filename, not the .json suffix', () => {
    expect(maskEmailsInText('claude-jane@example.com.json')).toBe('claude-j•••@e•••.com.json');
    expect(maskEmailsInText('codex-team@pixel.gg.json')).toBe('codex-t•••@p•••.gg.json');
  });

  test('uses the known email for mailboxes the pattern cannot isolate', () => {
    expect(maskEmailsInText('claude-mary-jane@example.com.json', 'mary-jane@example.com')).toBe(
      'claude-m•••@e•••.com.json'
    );
  });

  test('masks identities appended to a display name', () => {
    expect(maskEmailsInText('devin.json · ops@example.org')).toBe('devin.json · o•••@e•••.org');
  });

  test('leaves names without an address unchanged', () => {
    expect(maskEmailsInText('kimi-main.json')).toBe('kimi-main.json');
    expect(maskEmailsInText('xai-key-1.json', '')).toBe('xai-key-1.json');
  });
});
