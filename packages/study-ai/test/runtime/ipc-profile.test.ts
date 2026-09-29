/**
 * The outbound guard only lets through a profile main can write to disk as is: the canonical
 * JSON of a strictly valid current profile. It never makes main retrain.
 */
import { describe, expect, it, vi } from 'vitest';
import * as profileModule from '../../src/calibration/profile';
import { canonicalProfileJson, isAnalysisOutbound } from '../../src/runtime/ipc';
import { profileFor } from '../calibration/fixtures';

vi.mock('../../src/calibration/profile', async (importOriginal) => {
  const actual = await importOriginal<typeof profileModule>();
  return { ...actual, parseProfile: vi.fn(actual.parseProfile) };
});

const parseSpy = vi.mocked(profileModule.parseProfile);
const PROFILE = profileFor('baseline');
const JSON_OK = profileModule.serializeProfile(PROFILE);

const updated = (profileJson: string): unknown => ({
  type: 'event',
  event: { type: 'profile_updated', at: 1, profileJson, reason: 'feedback' },
});

/** The same profile with one field replaced (re-serialised canonically). */
function withField(path: readonly string[], value: unknown): string {
  const raw = JSON.parse(JSON_OK) as Record<string, unknown>;
  let node = raw;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[path[path.length - 1] as string] = value;
  return JSON.stringify(raw);
}

describe('outbound profile JSON', () => {
  it('accepts the canonical JSON of a genuine profile', () => {
    expect(canonicalProfileJson(JSON_OK)).toBe(true);
    expect(isAnalysisOutbound(updated(JSON_OK))).toBe(true);
  });

  it('refuses anything that is not canonical calibration numbers', () => {
    const pretty = JSON.stringify(JSON.parse(JSON_OK), null, 2);
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(JSON_OK) as object).reverse()),
    );
    // A 100 KB «frame» smuggled in an extra key, or in place of the camera hash.
    const frame = 'A'.repeat(100_000);
    const cases = [
      '{}',
      'not json',
      pretty,
      reordered,
      withField(['image'], frame),
      withField(['camera', 'key'], frame),
      withField(['createdAt'], 'yesterday'),
      withField(['baseline', 'yaw'], '12'),
      withField(['format'], 'something-else'),
      `${JSON_OK} `,
    ];
    for (const json of cases) {
      expect(canonicalProfileJson(json), json.slice(0, 60)).toBe(false);
      expect(isAnalysisOutbound(updated(json))).toBe(false);
    }
    expect(canonicalProfileJson(null)).toBe(false);
    expect(canonicalProfileJson('x'.repeat(600 * 1024))).toBe(false);
  });

  it('never parses (so never retrains) a profile of another version or trainer', () => {
    parseSpy.mockClear();
    for (const json of [withField(['trainer'], 2), withField(['version'], 0)]) {
      expect(canonicalProfileJson(json)).toBe(false);
      expect(
        isAnalysisOutbound({
          type: 'calibration_built',
          outcome: {
            ok: true,
            profileJson: json,
            report: PROFILE.report,
            issues: [],
          },
        }),
      ).toBe(false);
    }
    expect(parseSpy).not.toHaveBeenCalled();
  });
});
