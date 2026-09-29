/**
 * Pure pieces of the web dashboard (owner: CLIENT, pages/panel.ts): weekly totals from the
 * merged days of `GET /v1/stats`, Spanish number and time formats, and the SVG column charts.
 *
 * Charts follow PROMPT §10 «Estadísticas»: one color per chart, no grid but the baseline, a
 * text summary next to each chart, and a table with every value. Colors come only from the
 * design tokens, through classes in panel.css (the CSP forbids inline styles). Every mark has
 * a `<title>` (the browser's hover tooltip) and the whole chart an `aria-label`.
 */
import type { CloudMergedDay } from '@centrate/shared/cloud-api';
import type { LocalDay } from '@centrate/shared/domain';
import { addDays, isoWeekOf, isoWeekRange } from '@centrate/shared/cloud-api';
import { escapeHtml, raw } from './layout';
import type { SafeHtml } from './layout';

/** Weeks shown by the dashboard, the current one last. */
export const PANEL_WEEKS = 12;

export interface WeekTotals {
  /** Monday of the ISO week. */
  from: LocalDay;
  /** Sunday, or `today` for the current week. */
  to: LocalDay;
  /** Days of the week already lived (7, or fewer for the current week). */
  daysElapsed: number;
  focusMinutes: number;
  studyMinutes: number;
  pointsEarned: number;
  pointsLost: number;
  /** Days that met the daily goal (null without a goal). */
  goalDays: number | null;
}

/** Mondays of the last `count` ISO weeks ending with the week of `today`, oldest first. */
export function panelMondays(today: LocalDay, count = PANEL_WEEKS): LocalDay[] {
  const monday = isoWeekRange(isoWeekOf(today))?.from ?? today;
  return Array.from({ length: count }, (_, i) => addDays(monday, (i - count + 1) * 7));
}

/** Sums merged days into the weeks starting at `mondays` (days outside them are ignored). */
export function weeklyTotals(
  days: readonly CloudMergedDay[],
  mondays: readonly LocalDay[],
  today: LocalDay,
  hasGoal: boolean,
): WeekTotals[] {
  const weeks = mondays.map((from): WeekTotals => {
    const sunday = addDays(from, 6);
    const to = sunday < today ? sunday : today;
    return {
      from,
      to,
      daysElapsed: Math.max(0, Math.min(7, dayDiff(from, to) + 1)),
      focusMinutes: 0,
      studyMinutes: 0,
      pointsEarned: 0,
      pointsLost: 0,
      goalDays: hasGoal ? 0 : null,
    };
  });
  const byMonday = new Map(weeks.map((w) => [w.from, w]));
  for (const d of days) {
    const range = isoWeekRange(isoWeekOf(d.day));
    const week = range ? byMonday.get(range.from) : undefined;
    if (!week || d.day > today) continue;
    week.focusMinutes += d.focusMinutes;
    week.studyMinutes += d.studyMinutes;
    week.pointsEarned += d.pointsEarned;
    week.pointsLost += d.pointsLost;
    if (week.goalDays !== null && d.goalMet === true) week.goalDays += 1;
  }
  return weeks;
}

function dayDiff(from: LocalDay, to: LocalDay): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------------------
// Formats (es-ES, 24 h, grouping always on, typographic minus)
// ---------------------------------------------------------------------------------------

const INT = new Intl.NumberFormat('es-ES', { useGrouping: 'always', maximumFractionDigits: 0 });
const MINUS = '−';

export function formatInt(n: number): string {
  return `${n < 0 ? MINUS : ''}${INT.format(Math.abs(n))}`;
}

/** «45 min», «7 h», «7 h 20 min», «1.240 h». */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${formatInt(h)} h` : `${formatInt(h)} h ${rest} min`;
}

/** «+120», «−40», «0». */
export function formatSignedPoints(n: number): string {
  if (n === 0) return '0';
  return n > 0 ? `+${formatInt(n)}` : formatInt(n);
}

const SHORT_DAY = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const LONG_DAY = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** «7 sept» (a civil date, no time zone shift). */
export function shortDay(day: LocalDay): string {
  return SHORT_DAY.format(new Date(`${day}T12:00:00Z`));
}

/** «6 de julio». */
export function longDay(day: LocalDay): string {
  return LONG_DAY.format(new Date(`${day}T12:00:00Z`));
}

// ---------------------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------------------

export interface Tick {
  value: number;
  label: string;
}

/** Hour-based ticks for minutes: 0 to a round top with at most 4 steps. */
export function minuteTicks(maxMinutes: number): Tick[] {
  const steps = [30, 60, 120, 180, 300, 600, 1200, 1800, 3000, 6000, 12_000];
  const max = Math.max(maxMinutes, 1);
  const step = steps.find((s) => Math.ceil(max / s) <= 4) ?? Math.ceil(max / 4 / 60) * 60;
  const top = Math.ceil(max / step) * step;
  const ticks: Tick[] = [];
  for (let v = 0; v <= top; v += step) {
    ticks.push({
      value: v,
      label: v === 0 ? '0' : v % 60 === 0 ? `${formatInt(v / 60)} h` : `${v} min`,
    });
  }
  return ticks;
}

/** Ticks around zero for points won (up) and lost (down), at most 6 in all. */
export function pointTicks(maxEarned: number, maxLost: number): Tick[] {
  const up = Math.max(0, maxEarned);
  const down = Math.max(0, maxLost);
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000];
  const fits = (s: number) => Math.ceil(up / s) + Math.ceil(down / s) <= 5;
  const step = steps.find(fits) ?? 100_000;
  const top = Math.max(up > 0 || down === 0 ? step : 0, Math.ceil(up / step) * step);
  const bottom = Math.ceil(down / step) * step;
  const ticks: Tick[] = [];
  for (let v = 0 - bottom; v <= top; v += step) {
    ticks.push({ value: v, label: formatSignedPoints(v) });
  }
  return ticks;
}

// ---------------------------------------------------------------------------------------
// SVG column chart
// ---------------------------------------------------------------------------------------

export type BarTone = 'green' | 'red';

export interface ChartSlot {
  /** Axis label under the slot, or null to skip it (keeps the axis readable). */
  label: string | null;
  /** Tooltip of the whole slot, e.g. «Semana del 6 de julio: 7 h 20 min». */
  title: string;
  /** Signed values: positive columns rise from the baseline, negative ones hang from it. */
  bars: Array<{ value: number; tone: BarTone }>;
}

export interface ChartOptions {
  slots: readonly ChartSlot[];
  ticks: readonly Tick[];
  /** Read by screen readers instead of the marks. */
  ariaLabel: string;
  /** Slot whose value is written on its cap (the best week), if any. */
  labelSlot?: { index: number; text: string } | null;
}

/**
 * Two drawings of every chart: `wide` for the 600 px page, `narrow` for phones, where the wide
 * one would shrink its text below legibility. panel.css shows one of them (a media query), so
 * screen readers meet only the visible one. Font sizes (panel.css) are in these units.
 */
const GEOMETRY = {
  wide: { width: 560, height: 200, top: 18, right: 8, bottom: 26, left: 48 },
  narrow: { width: 320, height: 200, top: 18, right: 6, bottom: 24, left: 42 },
} as const;
export type ChartSize = keyof typeof GEOMETRY;
const BAR_MAX = 20;
const RADIUS = 4;

const n = (v: number): string => String(Math.round(v * 10) / 10);

/** A column from the baseline `y0` to `y1`, square at the baseline, rounded at its data end. */
function columnPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(RADIUS, w / 2, h);
  if (y1 < y0) {
    return (
      `M${n(x)} ${n(y0)}V${n(y1 + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y1)}` +
      `H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y1 + r)}V${n(y0)}Z`
    );
  }
  return (
    `M${n(x)} ${n(y0)}V${n(y1 - r)}A${n(r)} ${n(r)} 0 0 0 ${n(x + r)} ${n(y1)}` +
    `H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 0 ${n(x + w)} ${n(y1 - r)}V${n(y0)}Z`
  );
}

/**
 * An SVG column chart built from numbers only. Text (ticks, labels, titles) is escaped even
 * though it comes from our own formats.
 */
export function columnChart(options: ChartOptions, size: ChartSize = 'wide'): SafeHtml {
  const { slots, ticks } = options;
  const g = GEOMETRY[size];
  const min = Math.min(0, ...ticks.map((t) => t.value));
  const max = Math.max(1, ...ticks.map((t) => t.value));
  const plotW = g.width - g.left - g.right;
  const plotH = g.height - g.top - g.bottom;
  const y = (v: number) => g.top + ((max - v) / (max - min)) * plotH;
  const slotW = plotW / Math.max(1, slots.length);
  const barW = Math.min(BAR_MAX, slotW * 0.5);
  const base = y(0);

  const parts: string[] = [];
  for (const t of ticks) {
    parts.push(
      `<text class="chart-tick" x="${n(g.left - 8)}" y="${n(y(t.value) + 4)}" text-anchor="end">${escapeHtml(t.label)}</text>`,
    );
  }
  slots.forEach((slot, i) => {
    const x0 = g.left + i * slotW;
    const cx = x0 + slotW / 2;
    const marks = slot.bars
      .map((b) => {
        const d = columnPath(cx - barW / 2, barW, base, y(b.value));
        return d ? `<path class="bar bar-${b.tone}" d="${d}"/>` : '';
      })
      .join('');
    parts.push(
      `<g class="slot"><title>${escapeHtml(slot.title)}</title>` +
        `<rect class="slot-hit" x="${n(x0 + 1)}" y="${n(g.top)}" width="${n(slotW - 2)}" height="${n(plotH)}" rx="4"/>` +
        `${marks}</g>`,
    );
    if (slot.label !== null) {
      parts.push(
        `<text class="chart-tick" x="${n(cx)}" y="${n(g.height - 8)}" text-anchor="middle">${escapeHtml(slot.label)}</text>`,
      );
    }
  });
  parts.push(
    `<line class="chart-baseline" x1="${n(g.left)}" x2="${n(g.width - g.right)}" y1="${n(base)}" y2="${n(base)}"/>`,
  );
  const label = options.labelSlot;
  if (label && slots[label.index]) {
    const top = Math.max(...(slots[label.index]?.bars.map((b) => b.value) ?? [0]));
    parts.push(
      `<text class="chart-value" x="${n(g.left + (label.index + 0.5) * slotW)}" y="${n(y(top) - 6)}" text-anchor="middle">${escapeHtml(label.text)}</text>`,
    );
  }
  return raw(
    `<svg class="chart-svg chart-${size}" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="${escapeHtml(options.ariaLabel)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`,
  );
}

/** Axis labels for the week slots: the current week and every third one before it. */
export function weekAxisLabels(mondays: readonly LocalDay[]): Array<string | null> {
  const last = mondays.length - 1;
  return mondays.map((m, i) => ((last - i) % 3 === 0 ? shortDay(m) : null));
}

/** Both drawings of a chart; CSS shows the one that fits the screen. */
export function responsiveChart(options: ChartOptions): SafeHtml {
  return raw(`${columnChart(options, 'wide').value}${columnChart(options, 'narrow').value}`);
}
