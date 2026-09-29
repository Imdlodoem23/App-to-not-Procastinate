import { describe, expect, it } from 'vitest';
import { signInCodeEmail } from '../src/auth/email';
import { createResendMailer, MailerError, RESEND_ENDPOINT } from '../src/lib/mailer';
import { testConfig } from './helpers/app';

const message = signInCodeEmail('https://api.example.com', 'ana@example.com', '123456');

function recorder(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{"id":"x"}', { status });
  }) as typeof fetch;
  return { calls, fetchStub };
}

describe('createResendMailer', () => {
  it('is null without Resend configured', () => {
    expect(createResendMailer(testConfig({ RESEND_API_KEY: undefined }).email)).toBeNull();
  });

  it('posts the message to Resend with the key as bearer', async () => {
    const { calls, fetchStub } = recorder();
    const mailer = createResendMailer(testConfig().email, { fetch: fetchStub });
    await mailer?.send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(RESEND_ENDPOINT);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-resend-key');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      from: 'Céntrate <hola@example.com>',
      to: ['ana@example.com'],
      subject: 'Tu código para entrar en Céntrate',
    });
    expect(body.text).toContain('123456');
    expect(body.html).toContain(
      'https://api.example.com/cuenta/codigo#email=ana%40example.com&amp;otp=123456',
    );
  });

  it('throws on errors and logs only status and tag', async () => {
    const logs: object[] = [];
    const log = { warn: (obj: object) => logs.push(obj) };
    const { fetchStub } = recorder(422);
    const mailer = createResendMailer(testConfig().email, { fetch: fetchStub, log });
    await expect(mailer?.send(message)).rejects.toBeInstanceOf(MailerError);

    const down = createResendMailer(testConfig().email, {
      fetch: (async () => {
        throw new TypeError('fetch failed for ana@example.com');
      }) as typeof fetch,
      log,
    });
    await expect(down?.send(message)).rejects.toMatchObject({ status: null });
    expect(logs).toEqual([
      { tag: 'sign_in_code', status: 422 },
      { tag: 'sign_in_code', type: 'TypeError' },
    ]);
    expect(JSON.stringify(logs)).not.toContain('ana@');
  });
});
