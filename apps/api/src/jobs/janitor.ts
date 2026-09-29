/**
 * Retention sweep (owner: CORE). docs/API.md §6. Runs at boot and every hour; with several
 * instances only one sweeps at a time (`pg_try_advisory_xact_lock`, released at commit). Reads
 * never depend on it: every route filters by time on its own, so the janitor only keeps the
 * database small and personal data short-lived.
 *
 * It also frees AI quota holds left by a coach call whose process died before settling
 * (`releaseDeadAiHolds`, docs/API.md §10.2), and drops the per-mailbox AI counters of past UTC
 * days (`ai_identity_daily`).
 */
import { addDays } from '@centrate/shared/cloud-api';
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { META_KEYS } from '../db/meta';
import {
  accountabilityEvents,
  aiGlobalDaily,
  aiIdentityDaily,
  aiUsage,
  appAuthCodes,
  dailyStats,
  friendInvites,
  meta,
  partnerLinks,
  presence,
  profiles,
  rateCounters,
  session,
  usageCounters,
  user,
  verification,
} from '../db/schema';

const DAY_MS = 86_400_000;
const JANITOR_LOCK_ID = 4_726_002;
export const JANITOR_INTERVAL_MS = 3_600_000;

/**
 * A live coach call settles before its `reserved_until` (its deadline plus a 30 s margin); a hold
 * still there this long after it belongs to a call whose process died.
 */
export const DEAD_AI_HOLD_AFTER_MS = 10 * 60_000;

/** How long each kind of data is kept (docs/API.md §6). */
export const RETENTION = Object.freeze({
  invitesAfterExpiryDays: 30,
  accountabilityEventsDays: 30,
  usageCountersDays: 7,
  aiUsageDays: 90,
  dailyStatsDays: 731, // two years, leap day included
});

export type JanitorReport = Record<
  | 'presence'
  | 'appAuthCodes'
  | 'verification'
  | 'sessions'
  | 'invites'
  | 'partnerLinksEnded'
  | 'partnerApprovalOff'
  | 'accountabilityEvents'
  | 'usageCounters'
  | 'rateCounters'
  | 'aiUsage'
  | 'aiGlobalDaily'
  | 'aiDeadHolds'
  | 'aiIdentityDaily'
  | 'dailyStats'
  | 'userNames',
  number
>;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Frees the quota holds of coach calls that never settled (the process died mid-call: a crash,
 * an out-of-memory kill, a shutdown that could not wait). Without this a user would keep the
 * worst case of that call held until 00:00 UTC, which with the default caps blocks every coach
 * endpoint for the rest of the day.
 *
 * A hold is dead when its row still holds tokens or cost and either `reserved_until` passed
 * more than `DEAD_AI_HOLD_AFTER_MS` ago, or it is null (a later call on the same row settled and
 * cleared it, so what is left can only be a dead call's).
 *
 * - The user's row gives the hold back. The request stays counted. The per-user cap exists so
 *   that one account cannot drain the shared budget, and a call our own process lost is not the
 *   user's spending.
 * - The global budget books the whole hold as spent. We cannot know what the provider billed
 *   before the process died, so the money side keeps the conservative upper bound.
 */
async function releaseDeadAiHolds(tx: Tx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DEAD_AI_HOLD_AFTER_MS);
  const dead = and(
    or(gt(aiUsage.reservedTokens, 0), gt(aiUsage.reservedMicroUsd, 0)),
    or(isNull(aiUsage.reservedUntil), lt(aiUsage.reservedUntil, cutoff)),
  );
  // Locks in the order a reservation takes them (the day's budget row, then the user row), so
  // a user calling again right now waits for this sweep or the other way round, never both. A
  // row that a new reservation took meanwhile no longer matches once re-read.
  await tx
    .select({ day: aiGlobalDaily.day })
    .from(aiGlobalDaily)
    .where(
      inArray(aiGlobalDaily.day, tx.selectDistinct({ day: aiUsage.day }).from(aiUsage).where(dead)),
    )
    .orderBy(aiGlobalDaily.day)
    .for('update');
  const rows = await tx
    .select({
      userId: aiUsage.userId,
      day: aiUsage.day,
      feature: aiUsage.feature,
      heldMicroUsd: aiUsage.reservedMicroUsd,
    })
    .from(aiUsage)
    .where(dead)
    .for('update');
  const perDay = new Map<string, number>();
  for (const r of rows) {
    await tx
      .update(aiUsage)
      .set({ reservedTokens: 0, reservedMicroUsd: 0, reservedUntil: null })
      .where(
        and(eq(aiUsage.userId, r.userId), eq(aiUsage.day, r.day), eq(aiUsage.feature, r.feature)),
      );
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + Number(r.heldMicroUsd));
  }
  for (const [day, held] of perDay) {
    await tx
      .update(aiGlobalDaily)
      .set({
        reservedMicroUsd: sql`GREATEST(${aiGlobalDaily.reservedMicroUsd} - ${held}, 0)`,
        costMicroUsd: sql`${aiGlobalDaily.costMicroUsd} + ${held}`,
      })
      .where(eq(aiGlobalDaily.day, day));
  }
  return rows.length;
}

/**
 * One sweep. Returns what it deleted or changed, or null when another instance holds the lock.
 */
export async function runJanitor(db: Db, now: Date): Promise<JanitorReport | null> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ ok: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${JANITOR_LOCK_ID}) AS ok`,
    );
    const rows = (lock as unknown as { rows?: Array<{ ok: boolean }> }).rows ?? [];
    if (rows[0]?.ok !== true) return null;

    const today = utcDay(now);
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const n = async (query: Promise<unknown[]>) => (await query).length;

    const report: JanitorReport = {
      presence: await n(
        tx.delete(presence).where(lte(presence.expiresAt, now)).returning({ k: presence.userId }),
      ),
      appAuthCodes: await n(
        tx
          .delete(appAuthCodes)
          .where(lte(appAuthCodes.expiresAt, now))
          .returning({ k: appAuthCodes.codeHash }),
      ),
      verification: await n(
        tx
          .delete(verification)
          .where(lte(verification.expiresAt, now))
          .returning({ k: verification.id }),
      ),
      sessions: await n(
        tx.delete(session).where(lte(session.expiresAt, now)).returning({ k: session.id }),
      ),
      invites: await n(
        tx
          .delete(friendInvites)
          .where(
            or(
              lt(friendInvites.expiresAt, ago(RETENTION.invitesAfterExpiryDays)),
              and(
                sql`${friendInvites.uses} >= ${friendInvites.maxUses}`,
                lt(friendInvites.createdAt, ago(RETENTION.invitesAfterExpiryDays)),
              ),
            ),
          )
          .returning({ k: friendInvites.id }),
      ),
      // An owner-requested removal takes effect when its 24 h cooling-off ends …
      partnerLinksEnded: await n(
        tx
          .delete(partnerLinks)
          .where(and(isNotNull(partnerLinks.endsAt), lte(partnerLinks.endsAt, now)))
          .returning({ k: partnerLinks.id }),
      ),
      // … and so does a requested «approval off».
      partnerApprovalOff: await n(
        tx
          .update(partnerLinks)
          .set({ requireApproval: false, approvalOffAt: null })
          .where(and(isNotNull(partnerLinks.approvalOffAt), lte(partnerLinks.approvalOffAt, now)))
          .returning({ k: partnerLinks.id }),
      ),
      accountabilityEvents: await n(
        tx
          .delete(accountabilityEvents)
          .where(lt(accountabilityEvents.createdAt, ago(RETENTION.accountabilityEventsDays)))
          .returning({ k: accountabilityEvents.id }),
      ),
      usageCounters: await n(
        tx
          .delete(usageCounters)
          .where(lt(usageCounters.day, addDays(today, -RETENTION.usageCountersDays)))
          .returning({ k: usageCounters.key }),
      ),
      rateCounters: await n(
        tx
          .delete(rateCounters)
          .where(lte(rateCounters.expiresAt, now))
          .returning({ k: rateCounters.key }),
      ),
      aiUsage: await n(
        tx
          .delete(aiUsage)
          .where(lt(aiUsage.day, addDays(today, -RETENTION.aiUsageDays)))
          .returning({ k: aiUsage.day }),
      ),
      aiGlobalDaily: await n(
        tx
          .delete(aiGlobalDaily)
          .where(lt(aiGlobalDaily.day, addDays(today, -RETENTION.aiUsageDays)))
          .returning({ k: aiGlobalDaily.day }),
      ),
      aiDeadHolds: await releaseDeadAiHolds(tx, now),
      // Per-mailbox AI use (anti-abuse, keyed by an HMAC): only today's day counts. After the
      // dead holds, so rows are locked in the order a reservation takes them.
      aiIdentityDaily: await n(
        tx
          .delete(aiIdentityDaily)
          .where(lt(aiIdentityDaily.day, today))
          .returning({ k: aiIdentityDaily.day }),
      ),
      dailyStats: await n(
        tx
          .delete(dailyStats)
          .where(lt(dailyStats.day, addDays(today, -RETENTION.dailyStatsDays)))
          .returning({ k: dailyStats.day }),
      ),
      // `ensureProfile` clears `user.name` once the display name is seeded; this catches an
      // account whose sign-up hook stopped in between.
      userNames: await n(
        tx
          .update(user)
          .set({ name: '' })
          .where(
            and(
              ne(user.name, ''),
              sql`EXISTS (SELECT 1 FROM ${profiles} WHERE ${profiles.userId} = ${user.id})`,
            ),
          )
          .returning({ k: user.id }),
      ),
    };
    await tx
      .insert(meta)
      .values({ key: META_KEYS.janitorLastRun, value: now.toISOString() })
      .onConflictDoUpdate({ target: meta.key, set: { value: now.toISOString() } });
    return report;
  });
}

export interface JanitorLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface JanitorHandle {
  /** Runs one sweep now (also used at boot). */
  runOnce(): Promise<JanitorReport | null>;
  stop(): void;
}

/** Runs the janitor now and every `intervalMs`. Errors are logged by type, never thrown. */
export function startJanitor(
  db: Db,
  options: { now?: () => Date; log?: JanitorLog; intervalMs?: number } = {},
): JanitorHandle {
  const now = options.now ?? (() => new Date());
  let running: Promise<JanitorReport | null> | null = null;
  const runOnce = async (): Promise<JanitorReport | null> => {
    if (running) return running;
    running = runJanitor(db, now())
      .then((report) => {
        if (report) options.log?.info({ janitor: report }, 'janitor sweep');
        return report;
      })
      .catch((err: unknown) => {
        options.log?.warn(
          {
            type: err instanceof Error ? err.name : 'Error',
            code: (err as { code?: unknown })?.code,
          },
          'janitor sweep failed',
        );
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  void runOnce();
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? JANITOR_INTERVAL_MS);
  timer.unref();
  return { runOnce, stop: () => clearInterval(timer) };
}
