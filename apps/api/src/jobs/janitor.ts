/**
 * Retention sweep (owner: CORE). docs/API.md §6. Runs at boot and every hour; with several
 * instances only one sweeps at a time (`pg_try_advisory_xact_lock`, released at commit). Reads
 * never depend on it: every route filters by time on its own, so the janitor only keeps the
 * database small and personal data short-lived.
 */
import { addDays } from '@centrate/shared/cloud-api';
import { and, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { META_KEYS } from '../db/meta';
import {
  accountabilityEvents,
  aiGlobalDaily,
  aiUsage,
  appAuthCodes,
  dailyStats,
  friendInvites,
  meta,
  partnerLinks,
  presence,
  session,
  usageCounters,
  verification,
} from '../db/schema';

const DAY_MS = 86_400_000;
const JANITOR_LOCK_ID = 4_726_002;
export const JANITOR_INTERVAL_MS = 3_600_000;

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
  | 'aiUsage'
  | 'aiGlobalDaily'
  | 'dailyStats',
  number
>;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

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
      dailyStats: await n(
        tx
          .delete(dailyStats)
          .where(lt(dailyStats.day, addDays(today, -RETENTION.dailyStatsDays)))
          .returning({ k: dailyStats.day }),
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
