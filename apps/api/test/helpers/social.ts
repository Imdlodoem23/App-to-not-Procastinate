/**
 * Helpers for the SOCIAL tests: a small request wrapper that records every response body
 * (so a test can assert no email ever leaks into a social payload), and direct inserts for
 * friendships, devices and daily stats.
 */
import type { CloudDayStats } from '@centrate/shared/cloud-api';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/db/client';
import { dailyStats, devices, friendships, partnerLinks } from '../../src/db/schema';
import type { TestUser } from './app';

export interface Caller {
  (
    user: TestUser | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown; json: <T = unknown>() => T; raw: string }>;
  /** Every response body seen so far. */
  bodies: string[];
}

export function caller(app: FastifyInstance): Caller {
  const bodies: string[] = [];
  const call = (async (user, method, url, payload) => {
    const options: InjectOptions = { method, url, headers: user ? { ...user.headers } : {} };
    if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
    const res = await app.inject(options);
    bodies.push(res.body);
    const parse = <T>(): T => (res.body ? (JSON.parse(res.body) as T) : (undefined as T));
    return { status: res.statusCode, body: parse(), json: parse, raw: res.body };
  }) as Caller;
  call.bodies = bodies;
  return call;
}

/** Inserts both friendship rows. */
export async function befriend(db: Db, a: TestUser, b: TestUser, at = new Date()): Promise<void> {
  await db.insert(friendships).values([
    { userId: a.userId, friendId: b.userId, createdAt: at },
    { userId: b.userId, friendId: a.userId, createdAt: at },
  ]);
}

/** An active partner link (owner held accountable by partner), accepted at `at`. */
export async function linkPartners(
  db: Db,
  owner: TestUser,
  partner: TestUser,
  options: { requireApproval?: boolean; at?: Date } = {},
): Promise<string> {
  const at = options.at ?? new Date();
  const [row] = await db
    .insert(partnerLinks)
    .values({
      ownerId: owner.userId,
      partnerId: partner.userId,
      status: 'active',
      requireApproval: options.requireApproval ?? false,
      createdAt: at,
      acceptedAt: at,
    })
    .returning({ id: partnerLinks.id });
  if (!row) throw new Error('link insert failed');
  return row.id;
}

export async function addDevice(db: Db, user: TestUser): Promise<string> {
  const [row] = await db
    .insert(devices)
    .values({
      userId: user.userId,
      installId: randomUUID(),
      name: 'Portátil',
      platform: 'win',
      appVersion: '1.0.0',
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('device insert failed');
  return row.id;
}

/** Inserts one device-day of stats (only the numbers the ranking reads need to be given). */
export async function addDay(
  db: Db,
  user: TestUser,
  deviceId: string,
  day: string,
  stats: Partial<Omit<CloudDayStats, 'day'>> = {},
): Promise<void> {
  const focus = stats.focusMinutes ?? 0;
  await db.insert(dailyStats).values({
    deviceId,
    userId: user.userId,
    day,
    rev: stats.rev ?? 1,
    focusMinutes: focus,
    studyMinutes: stats.studyMinutes ?? 0,
    blocksCompleted: stats.blocksCompleted ?? 0,
    studySessions: stats.studySessions ?? 0,
    attempts: stats.attempts ?? 0,
    emergencyUnlocks: stats.emergencyUnlocks ?? 0,
    punishments: stats.punishments ?? 0,
    pointsEarned: stats.pointsEarned ?? 0,
    pointsLost: stats.pointsLost ?? 0,
  });
}
