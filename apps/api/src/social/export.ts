/**
 * The social part of the GDPR export (`GET /v1/me/export`, CORE's route): every stored row
 * about the user in the SOCIAL tables, including rows that reads already hide (expired
 * invites, ended links not yet swept). Other people appear only as id and display name.
 */
import type { CloudExport } from '@centrate/shared/cloud-api';
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accountabilityEvents,
  friendInvites,
  friendships,
  partnerLinks,
  presence,
  userBlocks,
} from '../db/schema';
import { toEventResponse, toPartnerLink } from './partners';
import { displayNames, person } from './people';

export type SocialExport = Pick<
  CloudExport,
  | 'friends'
  | 'invites'
  | 'blocks'
  | 'presence'
  | 'partnerLinks'
  | 'accountabilityEvents'
  | 'approvalDecisions'
>;

export async function exportSocialData(db: Db, userId: string, now: Date): Promise<SocialExport> {
  const friendRows = await db
    .select()
    .from(friendships)
    .where(eq(friendships.userId, userId))
    .orderBy(asc(friendships.createdAt));
  const inviteRows = await db
    .select()
    .from(friendInvites)
    .where(eq(friendInvites.inviterId, userId))
    .orderBy(asc(friendInvites.createdAt));
  const blockRows = await db
    .select()
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, userId))
    .orderBy(asc(userBlocks.createdAt));
  const [presenceRow] = await db.select().from(presence).where(eq(presence.userId, userId));
  const linkRows = await db
    .select()
    .from(partnerLinks)
    .where(or(eq(partnerLinks.ownerId, userId), eq(partnerLinks.partnerId, userId)))
    .orderBy(asc(partnerLinks.createdAt));
  const eventRows = await db
    .select()
    .from(accountabilityEvents)
    .where(eq(accountabilityEvents.ownerId, userId))
    .orderBy(asc(accountabilityEvents.occurredAt));
  const decisionRows = await db
    .select()
    .from(accountabilityEvents)
    .where(
      and(eq(accountabilityEvents.decidedBy, userId), isNotNull(accountabilityEvents.decidedAt)),
    )
    .orderBy(asc(accountabilityEvents.decidedAt));

  const names = await displayNames(db, [
    ...friendRows.map((r) => r.friendId),
    ...blockRows.map((r) => r.blockedId),
    ...linkRows.flatMap((r) => [r.ownerId, r.partnerId]),
    ...decisionRows.map((r) => r.ownerId),
  ]);

  return {
    friends: friendRows.map((r) => ({
      ...person(r.friendId, names),
      since: r.createdAt.toISOString(),
    })),
    invites: inviteRows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      maxUses: r.maxUses,
      uses: r.uses,
    })),
    blocks: blockRows.map((r) => ({
      ...person(r.blockedId, names),
      createdAt: r.createdAt.toISOString(),
    })),
    presence: presenceRow
      ? {
          state: presenceRow.state,
          since: presenceRow.since.toISOString(),
          endsAt: presenceRow.endsAt ? presenceRow.endsAt.toISOString() : null,
        }
      : null,
    partnerLinks: linkRows.map((r) => toPartnerLink(r, userId, names, now)),
    accountabilityEvents: eventRows.map((r) => toEventResponse(r, now)),
    approvalDecisions: decisionRows.flatMap((r) =>
      (r.approvalStatus === 'approved' || r.approvalStatus === 'denied') && r.decidedAt
        ? [
            {
              eventId: r.id,
              owner: person(r.ownerId, names),
              decision: r.approvalStatus,
              note: r.note,
              decidedAt: r.decidedAt.toISOString(),
            },
          ]
        : [],
    ),
  };
}
