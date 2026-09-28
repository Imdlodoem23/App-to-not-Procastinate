/**
 * Partner emails (docs/API.md §9): minimal Spanish text, times in the partner's zone, never a
 * reason, domain, task or points. Only for partners who turned `partnerEmails` on, only for the
 * kinds below, and at most `PARTNER_EMAILS_PER_DAY` per partner per UTC day (counted in
 * Postgres, so a restart does not reset it). Sending happens in the background: the owner's
 * app never waits on the mail provider, and a failure is logged by type only.
 */
import type { AccountabilityKind } from '@centrate/shared/cloud-api';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { deriveCapabilities } from '../config';
import type { AppContext, MailMessage } from '../context';
import type { Db } from '../db/client';
import { profiles, usageCounters, user } from '../db/schema';

export const PARTNER_EMAILS_PER_DAY = 10;
export const PARTNER_EMAIL_COUNTER = 'partner_email';

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

/** Takes one email from the recipient's daily allowance; false when it is used up. */
export async function reservePartnerEmail(db: Db, userId: string, now: Date): Promise<boolean> {
  const rows = await db
    .insert(usageCounters)
    .values({ userId, day: now.toISOString().slice(0, 10), key: PARTNER_EMAIL_COUNTER, count: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.userId, usageCounters.day, usageCounters.key],
      set: { count: sql`${usageCounters.count} + 1` },
      setWhere: sql`${usageCounters.count} < ${PARTNER_EMAILS_PER_DAY}`,
    })
    .returning({ count: usageCounters.count });
  return rows.length > 0;
}

function emailsEnabled(ctx: AppContext): boolean {
  return ctx.mailer !== null && deriveCapabilities(ctx.config).partnerEmails.enabled;
}

/** Sends without making the request wait; failures are logged by tag only. */
function dispatch(ctx: AppContext, log: FastifyBaseLogger, messages: MailMessage[]): void {
  const mailer = ctx.mailer;
  if (!mailer) return;
  for (const message of messages) {
    void mailer.send(message).catch((err: unknown) => {
      log.warn(
        { tag: message.tag, type: err instanceof Error ? err.name : 'Error' },
        'partner email failed',
      );
    });
  }
}

/** Emails the partners who hear about an owner's event (the counters are taken first). */
export async function emailPartnersAboutEvent(
  ctx: AppContext,
  db: Db,
  log: FastifyBaseLogger,
  partnerIds: string[],
  alert: Omit<AlertInput, 'baseUrl'>,
): Promise<void> {
  if (!emailsEnabled(ctx) || !EMAIL_KINDS.has(alert.kind) || partnerIds.length === 0) return;
  const now = ctx.now();
  if (alert.occurredAt.getTime() < now.getTime() - STALE_EMAIL_MS) return;
  const input: AlertInput = { ...alert, baseUrl: ctx.config.auth?.url ?? '' };
  const messages: MailMessage[] = [];
  for (const r of await recipients(db, partnerIds)) {
    const message = composeAlert(input, r.email, r.timeZone, now);
    if (message && (await reservePartnerEmail(db, r.userId, now))) messages.push(message);
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
  if (!r || !(await reservePartnerEmail(db, r.userId, ctx.now()))) return;
  dispatch(ctx, log, [composeLinkProposal(ownerName, r.email)]);
}
