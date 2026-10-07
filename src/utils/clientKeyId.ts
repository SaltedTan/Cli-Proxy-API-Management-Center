import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Requests without a client API key are grouped under this id. */
export const ANONYMOUS_CLIENT_KEY_ID = 'anonymous';

// Go's strings.TrimSpace (unicode.IsSpace). Unlike String.prototype.trim it strips U+0085
// and keeps U+FEFF, so key ids match the backend for every configured key.
const GO_SPACE =
  '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'g');

/** Trims like Go's strings.TrimSpace, which is how the backend normalizes config keys. */
export function trimSpaceLikeGo(text: string): string {
  return text.replace(GO_TRIM, '');
}

/**
 * The backend's `KeyID`: the first 8 bytes of the SHA-256 of the trimmed key as 16
 * lowercase hex characters, or `anonymous` for an empty key. Shared by the dashboard
 * (usage rows) and the config API (`access.api-key-limits` entries keyed by full key).
 */
export function clientKeyId(rawKey: string): string {
  const key = trimSpaceLikeGo(rawKey);
  if (!key) return ANONYMOUS_CLIENT_KEY_ID;
  return bytesToHex(sha256(new TextEncoder().encode(key)).subarray(0, 8));
}
