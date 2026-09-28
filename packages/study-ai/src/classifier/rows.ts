/**
 * Stored row layout, schema 1 (owner: LEARNING). DESIGN.md §6.3.
 *
 * Rows hold absolute values (a new baseline re-derives every relative feature) and are
 * quantised at record time (angles 0.1°, the rest 0.001), so a profile's JSON round trip is
 * exact and a reloaded profile retrains to the very same model.
 */
import { FEATURE_ROW_COLUMNS } from '../types';
import type { FeatureRow, FeatureRowColumn, FrameFeatures } from '../types';
import { clamp, finiteOr, quantize } from '../util/math';
import { LUMA_UNKNOWN, ROW_ANGLE_STEP, ROW_BOX_LIMIT, ROW_VALUE_STEP } from './constants';

/** Column indices of a `FeatureRow` (checked against `FEATURE_ROW_COLUMNS` by the tests). */
export const COL: Readonly<Record<FeatureRowColumn, number>> = Object.freeze(
  Object.fromEntries(FEATURE_ROW_COLUMNS.map((name, index) => [name, index])) as Record<
    FeatureRowColumn,
    number
  >,
);

export const ROW_LENGTH = FEATURE_ROW_COLUMNS.length;

const ANGLE_COLUMNS: ReadonlySet<number> = new Set([COL.yaw, COL.pitch, COL.roll]);

/** Row value by column name (0 for a malformed row). */
export function rowValue(row: FeatureRow, column: FeatureRowColumn): number {
  return row[COL[column]] ?? 0;
}

function angle(value: number): number {
  return quantize(clamp(finiteOr(value, 0), -180, 180), ROW_ANGLE_STEP);
}

function value(v: number, min: number, max: number): number {
  return quantize(clamp(finiteOr(v, min < 0 && max > 0 ? 0 : min), min, max), ROW_VALUE_STEP);
}

function unit(v: number): number {
  return value(v, 0, 1);
}

/** Absolute, quantised row in `FEATURE_ROW_COLUMNS` order. */
export function frameToRow(frame: FrameFeatures): FeatureRow {
  const row = new Array<number>(ROW_LENGTH).fill(0);
  const face = frame.face;
  if (face) {
    row[COL.face] = 1;
    row[COL.yaw] = angle(face.pose.yaw);
    row[COL.pitch] = angle(face.pose.pitch);
    row[COL.roll] = angle(face.pose.roll);
    row[COL.cx] = value(face.box.cx, -ROW_BOX_LIMIT, ROW_BOX_LIMIT);
    row[COL.cy] = value(face.box.cy, -ROW_BOX_LIMIT, ROW_BOX_LIMIT);
    row[COL.w] = value(face.box.w, 0, ROW_BOX_LIMIT);
    row[COL.h] = value(face.box.h, 0, ROW_BOX_LIMIT);
    row[COL.truncated] = unit(face.truncated);
    row[COL.blink] = unit(face.blink);
    row[COL.lookDown] = unit(face.lookDown);
    row[COL.lookUp] = unit(face.lookUp);
    row[COL.gazeX] = value(face.gazeX, -1, 1);
    row[COL.jawOpen] = unit(face.jawOpen);
  }
  const objects = frame.objects;
  const phone = objects?.phone ?? null;
  if (phone) {
    row[COL.phone] = unit(phone.score);
    row[COL.phoneNear] = phone.nearFace ? 1 : 0;
    row[COL.phoneMoving] = phone.moving ? 1 : 0;
  }
  row[COL.book] = unit(objects?.book?.score ?? 0);
  row[COL.person] = unit(objects?.person?.score ?? 0);
  const luma = frame.luma;
  row[COL.lumaMean] = luma ? unit(luma.mean) : LUMA_UNKNOWN;
  row[COL.lumaStd] = luma ? unit(luma.spatialStd) : LUMA_UNKNOWN;
  row[COL.quality] = unit(frame.quality);
  return row;
}

/** True when `row` is a well-formed schema-1 row (length, finite, quantised angles). */
export function isValidRow(row: unknown): row is FeatureRow {
  if (!Array.isArray(row) || row.length !== ROW_LENGTH) return false;
  for (let i = 0; i < ROW_LENGTH; i += 1) {
    const v: unknown = row[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    if (ANGLE_COLUMNS.has(i) && Math.abs(v) > 180) return false;
  }
  return true;
}
