/**
 * Email through Resend's HTTP API (owner: CORE). Used for sign-in codes and accountability
 * alerts. Only enabled when RESEND_API_KEY and EMAIL_FROM are set. Failures are logged by HTTP
 * status and message tag only: never the address, the subject or the body.
 */
import type { Config } from '../config';
import type { MailMessage, Mailer } from '../context';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const MAIL_TIMEOUT_MS = 10_000;

/** What the mailer logs with; a subset of pino's logger. */
export interface MailerLog {
  warn(obj: object, msg: string): void;
}

export class MailerError extends Error {
  readonly status: number | null;
  constructor(status: number | null) {
    super(status === null ? 'mail provider unreachable' : `mail provider answered ${status}`);
    this.name = 'MailerError';
    this.status = status;
  }
}

export interface ResendMailerOptions {
  fetch?: typeof fetch;
  log?: MailerLog;
  timeoutMs?: number;
}

/** A Resend mailer, or null when email is not configured. */
export function createResendMailer(
  email: Config['email'],
  options: ResendMailerOptions = {},
): Mailer | null {
  if (!email) return null;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? MAIL_TIMEOUT_MS;
  return {
    async send(message: MailMessage): Promise<void> {
      let res: Response;
      try {
        res = await doFetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${email.resendApiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: email.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        options.log?.warn(
          { tag: message.tag, type: err instanceof Error ? err.name : 'Error' },
          'mail not sent',
        );
        throw new MailerError(null);
      }
      // Drain the body so the connection can be reused; its content is not needed.
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok) {
        options.log?.warn({ tag: message.tag, status: res.status }, 'mail not sent');
        throw new MailerError(res.status);
      }
    },
  };
}
