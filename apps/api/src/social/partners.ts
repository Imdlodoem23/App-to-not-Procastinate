/**
 * Accountability partner links and approvals (docs/API.md §9). Weakening a setup takes 24
 * hours; the effective state is computed on read, so nothing depends on the janitor:
 * - a link whose `endsAt` has passed no longer exists;
 * - an «approval off» whose `approvalOffAt` has passed counts as applied.
 */
import type {
  AccountabilityEventResponse,
  ApprovalState,
  PartnerLink,
} from '@centrate/shared/cloud-api';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { accountabilityEvents } from '../db/schema';
import { partnerLinks } from '../db/schema';
import { person } from './people';

export type PartnerLinkRow = typeof partnerLinks.$inferSelect;
export type AccountabilityEventRow = typeof accountabilityEvents.$inferSelect;

/** The link still exists: no removal scheduled, or scheduled for later. */
export function linkIsLive(now: Date): SQL {
  return or(isNull(partnerLinks.endsAt), gt(partnerLinks.endsAt, now)) as SQL;
}

/** An active link that still exists and whose partner may hear about the owner's events. */
export function linkIsListening(now: Date): SQL {
  return and(eq(partnerLinks.status, 'active'), linkIsLive(now)) as SQL;
}

export function isLive(row: PartnerLinkRow, now: Date): boolean {
  return row.endsAt === null || row.endsAt > now;
}

export function effectiveRequireApproval(row: PartnerLinkRow, now: Date): boolean {
  return row.requireApproval && (row.approvalOffAt === null || row.approvalOffAt > now);
}

export function toPartnerLink(
  row: PartnerLinkRow,
  viewerId: string,
  names: Map<string, string>,
  now: Date,
): PartnerLink {
  const requireApproval = effectiveRequireApproval(row, now);
  return {
    id: row.id,
    role: row.ownerId === viewerId ? 'owner' : 'partner',
    owner: person(row.ownerId, names),
    partner: person(row.partnerId, names),
    status: row.status,
    requireApproval,
    approvalOffAt: requireApproval && row.approvalOffAt ? row.approvalOffAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
  };
}

/**
 * The approval as the app sees it. `expired` is computed on read: a pending approval past its
 * deadline. The app treats `expired` like `approved` (fail open).
 *
 * `showNote`: the partner's note is meant for the owner; other partners see the outcome only.
 */
export function toApprovalState(
  row: AccountabilityEventRow,
  now: Date,
  showNote: boolean,
): ApprovalState | null {
  if (row.approvalStatus === null || row.approvalDeadline === null) return null;
  const status =
    row.approvalStatus === 'pending' && row.approvalDeadline <= now
      ? 'expired'
      : row.approvalStatus;
  return {
    status,
    deadline: row.approvalDeadline.toISOString(),
    note: showNote ? row.note : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

export function toEventResponse(
  row: AccountabilityEventRow,
  now: Date,
): AccountabilityEventResponse {
  return {
    eventId: row.id,
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    approval: toApprovalState(row, now, true),
  };
}
