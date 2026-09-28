import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_AI_MODELS, deriveCapabilities, loadConfig } from '../src/config';
import { testEnv } from './helpers/app';

describe('loadConfig', () => {
  it('starts with an empty environment and every feature off', () => {
    const config = loadConfig({});
    expect(config.databaseUrl).toBeNull();
    expect(config.auth).toBeNull();
    expect(config.port).toBe(3000);
    expect(config.trustProxyHops).toBe(0);
    expect(config.appOrigins).toEqual([]);
    expect(config.ai.models).toEqual(DEFAULT_AI_MODELS);
    const caps = deriveCapabilities(config, { dbUp: null, aiBudgetExhausted: false });
    for (const cap of Object.values(caps)) {
      expect(cap).toEqual({ enabled: false, reason: 'missing_key' });
    }
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ DATABASE_URL: '', ANTHROPIC_API_KEY: '  ', PORT: '' });
    expect(config.databaseUrl).toBeNull();
    expect(config.ai.apiKey).toBeNull();
    expect(config.port).toBe(3000);
  });

  it('rejects malformed values without echoing them', () => {
    const secret = 'short-secret-value';
    let error: unknown;
    try {
      loadConfig({ BETTER_AUTH_SECRET: secret, DATABASE_URL: 'mysql://x' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain('BETTER_AUTH_SECRET');
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(secret);
  });

  it('needs https for BETTER_AUTH_URL in production', () => {
    expect(() => loadConfig(testEnv({ NODE_ENV: 'production' }))).toThrow(ConfigError);
    expect(() =>
      loadConfig(testEnv({ NODE_ENV: 'production', BETTER_AUTH_URL: 'https://api.example.com/' })),
    ).not.toThrow();
  });

  it('parses APP_ORIGINS and rejects paths', () => {
    const config = loadConfig({ APP_ORIGINS: 'https://a.example.com, http://localhost:4321' });
    expect(config.appOrigins).toEqual(['https://a.example.com', 'http://localhost:4321']);
    expect(() => loadConfig({ APP_ORIGINS: 'https://a.example.com/panel' })).toThrow(ConfigError);
  });

  it('ignores half a pair with a warning', () => {
    const config = loadConfig(testEnv({ GOOGLE_CLIENT_SECRET: undefined }));
    expect(config.google).toBeNull();
    expect(config.warnings.join(' ')).toContain('GOOGLE_CLIENT_SECRET');
  });
});

describe('deriveCapabilities', () => {
  it('turns accounts on with database, auth and a login method', () => {
    const caps = deriveCapabilities(loadConfig(testEnv()));
    expect(caps.accounts.enabled).toBe(true);
    expect(caps.googleLogin.enabled).toBe(true);
    expect(caps.emailLogin.enabled).toBe(true);
    expect(caps.coach).toEqual({ enabled: false, reason: 'missing_key' });
  });

  it('needs at least one login method', () => {
    const env = testEnv({ GOOGLE_CLIENT_ID: undefined, RESEND_API_KEY: undefined });
    expect(deriveCapabilities(loadConfig(env)).accounts).toEqual({
      enabled: false,
      reason: 'missing_key',
    });
  });

  it('reports the kill switch, the budget and a dead database', () => {
    const withKey = testEnv({ ANTHROPIC_API_KEY: 'test-key' });
    expect(deriveCapabilities(loadConfig(withKey)).coach.enabled).toBe(true);
    expect(deriveCapabilities(loadConfig({ ...withKey, AI_ENABLED: 'false' })).coach.reason).toBe(
      'kill_switch',
    );
    expect(
      deriveCapabilities(loadConfig(withKey), { dbUp: true, aiBudgetExhausted: true }).coach.reason,
    ).toBe('budget');
    const down = deriveCapabilities(loadConfig(withKey), { dbUp: false, aiBudgetExhausted: false });
    expect(down.accounts.reason).toBe('database_down');
    expect(down.coach.reason).toBe('database_down');
  });
});
