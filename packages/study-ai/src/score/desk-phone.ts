/**
 * «¡Estaba estudiando!» for a phone lying on the desk (owner: DECISION).
 *
 * A phone that lies still on the desk can still read as «in hand» now and then (detector
 * jitter, a new track after a missed run). When the user vouches for an episode whose low
 * time was mostly that phone, and its box stayed at one spot, the camera observer ignores a
 * phone at that spot for the rest of the session while it stays there. A phone picked up
 * leaves the spot and counts again at once, so vouching never switches phone detection off.
 *
 * The personal `thresholds.phone` is deliberately not raised from here: one click on a real
 * phone would then hide every phone, for the session and (persisted) for good. Spots live in
 * memory only, like the frames they come from.
 */
import type { Box, FrameFeatures, MonoMs } from '../types';
import { median } from '../util/math';
import {
  DESK_SPOT_AREA,
  DESK_SPOT_DIAG,
  DESK_SPOT_EDGE_PX,
  DESK_SPOT_MIN_PX,
  DESK_SPOT_MIN_SIGHTINGS,
  DESK_SPOT_SHARE,
} from './constants';

/** Where a phone lay, in normalised coordinates of a `width` × `height` frame. */
export interface DeskPhoneSpot {
  box: Box;
  width: number;
  height: number;
}

/** What the engine hands the observer when the user vouches for a desk-phone episode. */
export interface DeskPhoneVouch extends DeskPhoneSpot {
  /** Observations in [from, to] owe their phone evidence to this phone. */
  from: MonoMs;
  to: MonoMs;
}

/** An observer that learns vouched desk phones (the engine duck-types it). */
export interface DeskPhoneLearner {
  vouchDeskPhone(vouch: DeskPhoneVouch): void;
}

export function isDeskPhoneLearner(value: unknown): value is DeskPhoneLearner {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { vouchDeskPhone?: unknown }).vouchDeskPhone === 'function'
  );
}

function finiteBox(box: Box | null | undefined): box is Box {
  return (
    box !== null &&
    box !== undefined &&
    Number.isFinite(box.cx) &&
    Number.isFinite(box.cy) &&
    Number.isFinite(box.w) &&
    Number.isFinite(box.h) &&
    box.w > 0 &&
    box.h > 0
  );
}

/**
 * `box` is at `spot`: the centre within max(4 px, 0.15 × the spot's diagonal) and the area
 * within 30 % plus 3 px of edge jitter. Measured in pixels, so jitter on a small box stays.
 */
export function atSpot(box: Box, spot: DeskPhoneSpot): boolean {
  if (!finiteBox(box) || !finiteBox(spot.box)) return false;
  const { width, height } = spot;
  const rw = spot.box.w * width;
  const rh = spot.box.h * height;
  const reach = Math.max(DESK_SPOT_MIN_PX, DESK_SPOT_DIAG * Math.hypot(rw, rh));
  const distance = Math.hypot((box.cx - spot.box.cx) * width, (box.cy - spot.box.cy) * height);
  if (!(distance <= reach)) return false;
  const area = box.w * width * box.h * height;
  const refArea = rw * rh;
  return Math.abs(area - refArea) <= DESK_SPOT_AREA * refArea + DESK_SPOT_EDGE_PX * (rw + rh);
}

/**
 * The spot of a phone that stayed put: the component-wise median of ≥ 3 sightings, when
 * ≥ 80 % of them are at it. `null` for a phone that moved around (in the hand).
 */
export function stayedPut(
  sightings: readonly Box[],
  width: number,
  height: number,
): DeskPhoneSpot | null {
  if (!(width > 0 && height > 0)) return null;
  const boxes = sightings.filter(finiteBox);
  if (boxes.length < DESK_SPOT_MIN_SIGHTINGS) return null;
  const spot: DeskPhoneSpot = {
    box: {
      cx: median(boxes.map((b) => b.cx)),
      cy: median(boxes.map((b) => b.cy)),
      w: median(boxes.map((b) => b.w)),
      h: median(boxes.map((b) => b.h)),
    },
    width,
    height,
  };
  const at = boxes.filter((b) => atSpot(b, spot)).length;
  return at / boxes.length >= DESK_SPOT_SHARE ? spot : null;
}

/** The frame without its phone when that phone is at one of `spots`; otherwise unchanged. */
export function withoutDeskPhone(
  frame: FrameFeatures,
  spots: readonly DeskPhoneSpot[],
): FrameFeatures {
  const objects = frame.objects;
  const phone = objects?.phone;
  if (!objects || !phone || !spots.some((spot) => atSpot(phone.box, spot))) return frame;
  return { ...frame, objects: { ...objects, phone: null } };
}
