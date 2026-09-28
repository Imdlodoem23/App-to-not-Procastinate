/**
 * Shared test harness for every builder: a config with accounts on, a fake clock, a fake
 * mailer, users with bearer sessions inserted straight into the database, and a session
 * resolver that reads those tokens (so SOCIAL and COACH can test without better-auth).
 */
import type { CloudSharing } from '@centrate/shared/cloud-api';
import { and, eq, gt } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../../src/app';
import { loadConfig, type Config } from '../../src/config';
import type { MailMessage, Mailer, SessionResolver } from '../../src/context';
import type { Db } from '../../src/db/client';
import { devices, profiles, session, user } from '../../src/db/schema';

/** Env with accounts, email and Google on, and no Anthropic key. Override any variable. */
export function testEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-000',
    BETTER_AUTH_URL: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    RESEND_API_KEY: 'test-resend-key',
    EMAIL_FROM: 'Céntrate <hola@example.com>',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig(testEnv(overrides));
}

export interface FakeClock {
  now: () => Date;
  set(at: Date | string): void;
  advance(ms: number): void;
}

export function fakeClock(start: Date | string = '2026-09-28T10:00:00.000Z'): FakeClock {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (at) => {
      t = new Date(at).getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export function fakeMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send: async (message) => {
      sent.push(message);
    },
  };
}

/** Resolves `Authorization: Bearer <session.token>` against the session table. */
export function tokenSessionResolver(db: Db, now: () => Date = () => new Date()): SessionResolver {
  return async (headers) => {
    const header = headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    const rows = await db
      .select({ id: session.id, userId: session.userId, createdAt: session.createdAt })
      .from(session)
      .where(and(eq(session.token, token), gt(session.expiresAt, now())))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const device = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.sessionId, row.id))
      .limit(1);
    return {
      userId: row.userId,
      sessionId: row.id,
      sessionCreatedAt: row.createdAt,
      deviceId: device[0]?.id ?? null,
    };
  };
}

export interface TestUser {
  userId: string;
  email: string;
  sessionId: string;
  token: string;
  headers: { authorization: string };
}

export interface CreateUserOptions {
  email?: string;
  displayName?: string | null;
  timeZone?: string;
  dailyGoalMinutes?: number | null;
  sharing?: Partial<CloudSharing>;
  /** Session creation time (fresh-session checks). Defaults to `now`. */
  sessionCreatedAt?: Date;
  now?: Date;
}

/** Inserts a user, their profile and a 60-day bearer session. */
export async function createTestUser(db: Db, options: CreateUserOptions = {}): Promise<TestUser> {
  const now = options.now ?? new Date();
  const userId = randomUUID();
  const email = options.email ?? `user-${userId.slice(0, 8)}@example.com`;
  await db.insert(user).values({ id: userId, name: '', email, emailVerified: true });
  const s = options.sharing ?? {};
  await db.insert(profiles).values({
    userId,
    displayName:
      options.displayName === undefined ? `Test ${userId.slice(0, 4)}` : options.displayName,
    timeZone: options.timeZone ?? 'Europe/Madrid',
    dailyGoalMinutes: options.dailyGoalMinutes ?? null,
    shareSync: s.syncStats ?? false,
    shareRanking: s.ranking ?? false,
    sharePresence: s.presence ?? false,
    partnerEmails: s.partnerEmails ?? false,
    coachEnabled: s.coach ?? false,
  });
  const sessionId = randomUUID();
  const token = randomBytes(24).toString('base64url');
  await db.insert(session).values({
    id: sessionId,
    token,
    userId,
    createdAt: options.sessionCreatedAt ?? now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 60 * 86_400_000),
  });
  return { userId, email, sessionId, token, headers: { authorization: `Bearer ${token}` } };
}

export interface TestAppOptions extends Partial<BuildAppOptions> {
  db: Db;
  clock?: FakeClock;
}

/**
 * The app with a PGlite database, the fake clock and the token resolver. Pass `resolveSession`
 * explicitly as `undefined` in `overrides` to use the real better-auth resolver (CORE tests).
 */
export async function buildTestApp(options: TestAppOptions): Promise<FastifyInstance> {
  const clock = options.clock ?? fakeClock();
  return buildApp({
    config: options.config ?? testConfig(),
    pingDb: async () => true,
    now: clock.now,
    mailer: fakeMailer(),
    resolveSession: tokenSessionResolver(options.db, clock.now),
    logger: false,
    ...options,
  });
}
