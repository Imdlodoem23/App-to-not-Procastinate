/**
 * Partner emails (docs/API.md §9): minimal Spanish text, times in the partner's zone, never a
 * reason, domain, task or points. Only for partners who turned `partnerEmails` on, only for the
 * kinds below, at most `PARTNER_EMAILS_PER_DAY` per partner and `PARTNER_EMAILS_PER_DAY_GLOBAL`
 * for everybody per UTC day (counted in Postgres, so a restart does not reset them). The
 * global cap keeps partner emails inside their share of the Resend plan, which sign-in codes
 * share (`SIGNIN_EMAILS_PER_DAY`): alerts can never use up the room for codes.
 *
 * Sending happens in the background: the owner's app never waits on the mail provider. One
 * message at a time (Resend limits requests per second), each retried once after a 429 when
 * the provider asks for a short wait; a failure is logged by type only.
 */
import type { AccountabilityKind } from '@centrate/shared/cloud-api';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import { deriveCapabilities } from '../config';
import type { AppContext, MailMessage, Mailer } from '../context';
import type { Db } from '../db/client';
import { profiles, usageCounters, user } from '../db/schema';
import { isCounterExhausted, takeFromCounter } from '../lib/counters';
import type { CounterLimit } from '../lib/counters';
import { MailerError } from '../lib/mailer';

export const PARTNER_EMAILS_PER_DAY = 10;
export const PARTNER_EMAIL_COUNTER = 'partner_email';
/** `rate_counters` key of the global daily cap (no user in it). */
export const PARTNER_EMAIL_GLOBAL_KEY = 'partner_email:global';

/** Wait before the one retry when a 429 carries no `Retry-After`. */
export const MAIL_RETRY_DEFAULT_MS = 1_000;
/** Longest `Retry-After` honoured: Resend's per-second limit asks for about a second, and a
 *  longer wait means a spent daily or monthly quota, where retrying only wastes a request. */
export const MAIL_RETRY_MAX_MS = 5_000;

const DAY_MS = 86_400_000;

/** Kinds that also go by email; the inbox lists every kind. */
const EMAIL_KINDS: ReadonlySet<AccountabilityKind> = new Set<AccountabilityKind>([
  'emergency_requested',
  'emergency_confirmed',
  'study_abandoned',
]);

/** Events older than this (queued offline for a long time) reach the inbox only. */
const STALE_EMAIL_MS = 24 * 3_600_000;

interface Recipient {
  userId: string;
  email: string;
  timeZone: string;
}

/** Display names go into subjects and text: drop control and format characters. */
function cleanName(name: string): string {
  const cleaned = name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return cleaned || 'Tu amigo';
}

function clock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone, day: '2-digit', month: '2-digit' }).format(
    at,
  );
}

/** «18:40» today in the partner's zone, «27/09, 18:40» another day. */
function when(at: Date, now: Date, timeZone: string): string {
  const sameDay = localDate(at, timeZone) === localDate(now, timeZone);
  return sameDay ? clock(at, timeZone) : `${localDate(at, timeZone)}, ${clock(at, timeZone)}`;
}

function footer(ownerName: string): string {
  return (
    `Recibes este correo porque eres compañero de responsabilidad de ${ownerName} en Céntrate ` +
    'y activaste los avisos por email. Puedes desactivarlos en tu cuenta, desde la app.'
  );
}

const HEADLINES: Partial<Record<AccountabilityKind, (name: string) => string>> = {
  emergency_requested: (name) => `${name} ha pedido el desbloqueo de emergencia`,
  emergency_confirmed: (name) => `${name} ha usado el desbloqueo de emergencia`,
  study_abandoned: (name) => `${name} ha abandonado una sesión de estudio`,
};

export interface AlertInput {
  kind: AccountabilityKind;
  ownerName: string;
  occurredAt: Date;
  /** Set when the partner can still approve or deny. */
  approvalDeadline: Date | null;
  /** Public API URL, for the link to /cuenta/avisos. */
  baseUrl: string;
}

/** The alert email for one partner, or null for kinds that never go by email. */
export function composeAlert(
  input: AlertInput,
  to: string,
  timeZone: string,
  now: Date,
): MailMessage | null {
  const headline = HEADLINES[input.kind];
  if (!headline) return null;
  const name = cleanName(input.ownerName);
  const lines = [`${headline(name)} (${when(input.occurredAt, now, timeZone)}).`];
  if (input.approvalDeadline) {
    lines.push(
      `Puedes aprobarlo o rechazarlo hasta las ${clock(input.approvalDeadline, timeZone)} ` +
        `en Céntrate o en ${input.baseUrl}/cuenta/avisos. Si no respondes, se aprueba solo.`,
    );
  }
  lines.push('', footer(name));
  return { to, subject: headline(name), text: lines.join('\n'), html: null, tag: 'partner_alert' };
}

/** The «te ha propuesto como compañero» email. */
export function composeLinkProposal(ownerName: string, to: string): MailMessage {
  const name = cleanName(ownerName);
  const text = [
    `${name} te ha propuesto como compañero de responsabilidad en Céntrate.`,
    'Si aceptas, verás un aviso cuando use el desbloqueo de emergencia o abandone una sesión ' +
      'de estudio. Puedes aceptar o rechazar la propuesta en la app, en Amigos.',
    '',
    footer(name),
  ].join('\n');
  return {
    to,
    subject: `${name} quiere que seas su compañero de responsabilidad`,
    text,
    html: null,
    tag: 'partner_link',
  };
}

/** Partners among `userIds` who turned partner emails on, with their address and zone. */
async function recipients(db: Db, userIds: string[]): Promise<Recipient[]> {
  if (userIds.length === 0) return [];
  return db
    .select({ userId: user.id, email: user.email, timeZone: profiles.timeZone })
    .from(user)
    .innerJoin(profiles, eq(profiles.userId, user.id))
    .where(and(inArray(user.id, userIds), eq(profiles.partnerEmails, true)));
}

const globalLimit = (config: Config): CounterLimit => ({
  key: PARTNER_EMAIL_GLOBAL_KEY,
  windowMs: DAY_MS,
  max: config.email?.partnerEmailsPerDay ?? 0,
});

/**
 * Takes one email from the global and the recipient's daily allowance; false when either is
 * used up. A spent global cap is checked first so it does not also use up the recipient's
 * allowance, and the recipient's is taken before the global one so a partner past their own
 * 10 never spends the global cap on emails that are not sent.
 */
export async function reservePartnerEmail(
  db: Db,
  config: Config,
  userId: string,
  now: Date,
): Promise<boolean> {
  const global = globalLimit(config);
  if (await isCounterExhausted(db, global, now)) return false;
  const rows = await db
    .insert(usageCounters)
    .values({ userId, day: now.toISOString().slice(0, 10), key: PARTNER_EMAIL_COUNTER, count: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.userId, usageCounters.day, usageCounters.key],
      set: { count: sql`${usageCounters.count} + 1` },
      setWhere: sql`${usageCounters.count} < ${PARTNER_EMAILS_PER_DAY}`,
    })
    .returning({ count: usageCounters.count });
  if (rows.length === 0) return false;
  return (await takeFromCounter(db, global, now)).ok;
}

function emailsEnabled(ctx: AppContext): boolean {
  return ctx.mailer !== null && deriveCapabilities(ctx.config).partnerEmails.enabled;
}

/** How long to wait before retrying after `err`, or null when it is not worth a retry. */
function retryDelayMs(err: unknown): number | null {
  if (!(err instanceof MailerError) || err.status !== 429) return null;
  const wait = err.retryAfterMs ?? MAIL_RETRY_DEFAULT_MS;
  return wait <= MAIL_RETRY_MAX_MS ? wait : null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Sends `messages` one after another, each retried once after a short 429. Never rejects. */
async function sendInTurn(
  mailer: Mailer,
  log: FastifyBaseLogger,
  messages: readonly MailMessage[],
): Promise<void> {
  for (const message of messages) {
    try {
      try {
        await mailer.send(message);
      } catch (err) {
        const delay = retryDelayMs(err);
        if (delay === null) throw err;
        await sleep(delay);
        await mailer.send(message);
      }
    } catch (err) {
      log.warn(
        { tag: message.tag, type: err instanceof Error ? err.name : 'Error' },
        'partner email failed',
      );
    }
  }
}

/** The last batch queued per app: batches go out one after another, never side by side. */
const queues = new WeakMap<AppContext, Promise<void>>();

/**
 * Sends without making the request wait, after any batch still going out (Resend's
 * per-second limit is per account, not per request); `app.close()` waits for it (ctx.inFlight).
 */
function dispatch(ctx: AppContext, log: FastifyBaseLogger, messages: MailMessage[]): void {
  const mailer = ctx.mailer;
  if (!mailer || messages.length === 0) return;
  const previous = queues.get(ctx) ?? Promise.resolve();
  // `sendInTurn` never rejects, so one failed batch never stops the next.
  const next = previous.then(() => sendInTurn(mailer, log, messages));
  queues.set(ctx, next);
  void ctx.inFlight.track(next);
}

/** A partner who hears about the event; `canDecide` when their link asks for approval. */
export interface EventRecipient {
  userId: string;
  canDecide: boolean;
}

/**
 * Emails the partners who hear about an owner's event (the counters are taken first). Only
 * partners who can answer the approval get the «puedes aprobarlo o rechazarlo» line.
 */
export async function emailPartnersAboutEvent(
  ctx: AppContext,
  db: Db,
  log: FastifyBaseLogger,
  partners: readonly EventRecipient[],
  alert: Omit<AlertInput, 'baseUrl'>,
): Promise<void> {
  if (!emailsEnabled(ctx) || !EMAIL_KINDS.has(alert.kind) || partners.length === 0) return;
  const now = ctx.now();
  if (alert.occurredAt.getTime() < now.getTime() - STALE_EMAIL_MS) return;
  const input: AlertInput = { ...alert, baseUrl: ctx.config.auth?.url ?? '' };
  const deciders = new Set(partners.filter((p) => p.canDecide).map((p) => p.userId));
  const messages: MailMessage[] = [];
  const wanting = await recipients(
    db,
    partners.map((p) => p.userId),
  );
  for (const r of wanting) {
    const forThem = deciders.has(r.userId) ? input : { ...input, approvalDeadline: null };
    const message = composeAlert(forThem, r.email, r.timeZone, now);
    if (message && (await reservePartnerEmail(db, ctx.config, r.userId, now))) {
      messages.push(message);
    }
  }
  dispatch(ctx, log, messages);
}

/** Tells a proposed partner (if they want partner emails) that someone asked them. */
export async function emailLinkProposal(
  ctx: AppContext,
  db: Db,
  log: FastifyBaseLogger,
  partnerId: string,
  ownerName: string,
): Promise<void> {
  if (!emailsEnabled(ctx)) return;
  const [r] = await recipients(db, [partnerId]);
  if (!r || !(await reservePartnerEmail(db, ctx.config, r.userId, ctx.now()))) return;
  dispatch(ctx, log, [composeLinkProposal(ownerName, r.email)]);
}
