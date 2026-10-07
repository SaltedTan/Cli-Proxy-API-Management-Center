/**
 * Per client API key usage reported by `GET /observability/usage/clients`.
 * Field names are normalized to camelCase at the API boundary.
 */

/** Known Claude plan ids; other plan names may appear with `planSource` "weight". */
export type ClaudePlanId = 'pro' | 'team' | 'max_5x' | 'max_20x' | 'unknown';

export interface ClientUsageTokens {
  /** Includes cache reads and writes. */
  input: number;
  /** Includes reasoning. */
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ClientUsageCounters {
  /** Successful upstream responses; a request retried on another credential counts once. */
  requests: number;
  /** Failed upstream attempts, including ones that were retried. */
  failed: number;
  tokens: ClientUsageTokens;
}

export interface ClientUsageDay extends ClientUsageCounters {
  /** `YYYY-MM-DD` in the server's local time zone. */
  date: string;
}

export interface ClientUsageModel extends ClientUsageCounters {
  model: string;
}

export interface ClaudeCredentialRef {
  authId: string;
  authIndex?: string;
  label?: string;
  plan: ClaudePlanId | string;
  /** Weekly allowance in Claude Pro units (Pro 1, Team 1.25, Max 5x 2, Max 20x 10). */
  planProUnits: number;
  /** `weight` when the allowance falls back to the credential weight. */
  planSource: string;
}

/** One key's share of one credential's weekly limit; fractions are of that limit. */
export interface ClientKeyClaudeCredentialUsage extends ClaudeCredentialRef {
  windowResetsAtMs: number | null;
  currentFraction: number;
  currentProUnits: number;
  totalFraction: number;
  totalProUnits: number;
}

export interface ClientKeyClaudeUsage {
  /** Claude Pro units used in each credential's open weekly window. */
  currentProUnits: number;
  totalProUnits: number;
  credentials: ClientKeyClaudeCredentialUsage[];
}

export interface ClientKeyUsage {
  /** First 16 hex characters of the key's SHA-256, or `anonymous`. */
  id: string;
  /** Display name from `access.api-key-names`. */
  name?: string;
  /** Masked key; only present for keys still in `access.api-keys`. */
  key?: string;
  configured: boolean;
  firstUsedAtMs: number | null;
  lastUsedAtMs: number | null;
  totals: ClientUsageCounters;
  models: ClientUsageModel[];
  /** Oldest first; covers the last 31 server-local days. */
  daily: ClientUsageDay[];
  claude: ClientKeyClaudeUsage | null;
}

export interface ClaudeCredentialUsage extends ClaudeCredentialRef {
  /** Fraction of the plan's weekly limit used; 0 once the observed window has reset. */
  weeklyUtilization: number;
  /** Null when the last observed window has already reset. */
  windowResetsAtMs: number | null;
  observedAtMs: number | null;
  unattributedCurrentFraction: number;
  unattributedTotalFraction: number;
}

export interface ClientUsageSnapshot {
  generatedAtMs: number | null;
  /**
   * The server's local date when the snapshot was generated (`YYYY-MM-DD`), which is
   * the calendar `daily` buckets use. Null when it could not be determined.
   */
  serverDate: string | null;
  sinceMs: number | null;
  keys: ClientKeyUsage[];
  claudeCredentials: ClaudeCredentialUsage[];
}
