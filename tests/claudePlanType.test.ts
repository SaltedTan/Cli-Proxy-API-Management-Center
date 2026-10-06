import { describe, expect, test } from 'bun:test';
import { resolveClaudePlanType } from '@/features/quota/providers/claude/data';
import type { ClaudeProfileResponse } from '@/types';

describe('Claude plan type', () => {
  test.each([
    { has_claude_max: false, has_claude_pro: true },
    { has_claude_max: true, has_claude_pro: false },
    { has_claude_max: true, has_claude_pro: true },
    { has_claude_max: false, has_claude_pro: false },
    {},
  ])('prefers the active Team organization over account flags %j', (account) => {
    expect(
      resolveClaudePlanType({
        account,
        organization: { organization_type: 'claude_team', subscription_status: 'active' },
      })
    ).toBe('plan_team');
  });

  test.each([
    [{ has_claude_max: false, has_claude_pro: true }, 'plan_pro'],
    [{ has_claude_max: true, has_claude_pro: true }, 'plan_max'],
    [{ has_claude_max: false, has_claude_pro: false }, 'plan_free'],
    [{}, null],
  ] as const)('preserves personal plan detection for %j', (account, expected) => {
    expect(
      resolveClaudePlanType({
        account,
        organization: { organization_type: 'claude_pro', subscription_status: 'active' },
      })
    ).toBe(expected);
    expect(resolveClaudePlanType({ account })).toBe(expected);
  });

  test.each(['inactive', 'canceled', undefined])(
    'does not label a Team organization with status %s as active Team',
    (subscriptionStatus) => {
      expect(
        resolveClaudePlanType({
          account: { has_claude_pro: true },
          organization: {
            organization_type: 'claude_team',
            subscription_status: subscriptionStatus,
          },
        })
      ).toBe('plan_pro');
    }
  );

  test.each([
    ['default_claude_max_5x', 'plan_max5'],
    ['default_claude_max_20x', 'plan_max20'],
    ['DEFAULT_CLAUDE_MAX_20X', 'plan_max20'],
    ['default_claude_max', 'plan_max'],
    ['default_claude_max_15x', 'plan_max'],
    [undefined, 'plan_max'],
  ] as const)('sizes a Max plan from rate-limit tier %s', (rateLimitTier, expected) => {
    expect(
      resolveClaudePlanType({
        account: { has_claude_max: true },
        organization: { organization_type: 'claude_max', rate_limit_tier: rateLimitTier },
      })
    ).toBe(expected);
  });

  test('an active Team organization still wins over a Max tier', () => {
    expect(
      resolveClaudePlanType({
        account: { has_claude_max: true },
        organization: {
          organization_type: 'claude_team',
          subscription_status: 'active',
          rate_limit_tier: 'default_claude_max_5x',
        },
      })
    ).toBe('plan_team');
  });

  test('preserves case-insensitive organization matching', () => {
    expect(
      resolveClaudePlanType({
        account: { has_claude_pro: true },
        organization: { organization_type: 'CLAUDE_TEAM', subscription_status: 'ACTIVE' },
      })
    ).toBe('plan_team');
  });

  test.each([
    null,
    {},
    { account: { has_claude_max: false } },
  ] satisfies (ClaudeProfileResponse | null)[])(
    'returns unknown for an incomplete profile %j',
    (profile) => {
      expect(resolveClaudePlanType(profile)).toBeNull();
    }
  );
});
