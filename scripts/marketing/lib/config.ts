/**
 * What the marketing specs share: `media.json`, the run's environment (set by
 * `build-media.mjs`) and the output folders.
 *
 * - `MARKETING_OUT`: work folder. Specs write `stills/<name>.png` + `stills/<state>.json`,
 *   and `frames/<video>/` (unique PNGs + `timeline.json`). Never the repository.
 * - `MARKETING_LANG`: `es` (default) or `en`, the language the fake OS and browser report.
 * - `MARKETING_ONLY`: comma list of jobs (`stills`, video ids); empty runs everything.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ThemeName } from '@centrate/shared/design/tokens';
import type { DisplayPresetId, HarnessStateId } from '../../../apps/desktop/src/shared/fixtures';

export type Lang = 'es' | 'en';
export type Backdrop = 'light' | 'alt' | 'dark';

export interface StillSpec {
  state: HarnessStateId;
  alt: Record<Lang, string>;
}

export interface VideoSpec {
  id: string;
  kind: 'hero' | 'loop';
  theme: ThemeName;
  /** Web surface the video sits on: fills the canvas around a window smaller than it. */
  backdrop: Backdrop;
  /** Label of the frame used as the still image (reduced motion). */
  stillAt: string;
  alt: Record<Lang, string>;
}

export interface MediaConfig {
  scaleFactor: number;
  display: DisplayPresetId;
  fps: number;
  budgets: Record<'heroAv1' | 'heroOther' | 'loop' | 'image' | 'firstView', number>;
  /** `<state>-<theme>` stills the web shows above the fold (check-budgets.mjs). */
  firstViewStills: string[];
  stills: StillSpec[];
  videos: VideoSpec[];
}

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export const CONFIG = JSON.parse(
  readFileSync(join(__dirname, '..', 'media.json'), 'utf8'),
) as MediaConfig;

export const LANG: Lang = process.env['MARKETING_LANG'] === 'en' ? 'en' : 'es';

const ONLY = (process.env['MARKETING_ONLY'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** True when this run includes `job` (`stills` or a video id). */
export function wanted(job: string): boolean {
  return ONLY.length === 0 || ONLY.includes(job);
}

export function outDir(): string {
  const out = process.env['MARKETING_OUT'];
  if (!out) throw new Error('MARKETING_OUT is not set: run node scripts/marketing/build-media.mjs');
  return resolve(out);
}

/** A fresh (emptied) folder under the work folder. */
export function freshDir(...parts: string[]): string {
  const dir = join(outDir(), ...parts);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function video(id: string): VideoSpec {
  const spec = CONFIG.videos.find((v) => v.id === id);
  if (!spec) throw new Error(`media.json has no video «${id}»`);
  return spec;
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
