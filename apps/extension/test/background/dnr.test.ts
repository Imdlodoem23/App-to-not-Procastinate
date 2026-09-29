import { describe, expect, it, vi } from 'vitest';
import type { DnrApi, DnrApplyResult, DnrUpdate } from '../../src/background/dnr';
import {
  RULE_ID_RANGE,
  createDnrApplier,
  diffDynamicRules,
  ruleSignature,
} from '../../src/background/dnr';
import type { DnrRule } from '../../src/background/rules';
import { buildDnrRules, hostPatternToRegexFilter } from '../../src/background/rules';
import { backgroundPlugins } from '../../src/background/state';
import { YOUTUBE, blockRules, evaluateDnr, examRules } from './enforcement-fixtures';

/** declarativeNetRequest in memory, with the browsers' update semantics. */
function fakeDnr(options: { initial?: DnrRule[]; limits?: ReturnType<DnrApi['limits']> } = {}) {
  let rules: DnrRule[] = structuredClone(options.initial ?? []);
  const updates: DnrUpdate[] = [];
  const api: DnrApi & {
    rules: () => DnrRule[];
    updates: DnrUpdate[];
    refuse: ((update: DnrUpdate) => boolean) | null;
  } = {
    updates,
    refuse: null,
    rules: () => rules,
    getDynamicRules: async () => structuredClone(rules),
    async updateDynamicRules(update) {
      updates.push(structuredClone(update));
      if (api.refuse?.(update)) throw new Error('Rule with id 7 specifies an invalid regexFilter');
      // Removals first, then additions; an id still in use is an error.
      const next = rules.filter((r) => !update.removeRuleIds.includes(r.id));
      for (const rule of update.addRules) {
        if (next.some((r) => r.id === rule.id)) throw new Error(`duplicate id ${rule.id}`);
        next.push(structuredClone(rule));
      }
      rules = next;
    },
    limits: () => options.limits ?? {},
  };
  return api;
}

const quiet = { warn: () => undefined };

describe('ruleSignature', () => {
  it('ignores the id, set order and defaults the browser may fill in', () => {
    const a: DnrRule = {
      id: 1,
      action: { type: 'allow' },
      condition: { requestDomains: ['b.com', 'a.com'], resourceTypes: ['sub_frame', 'main_frame'] },
    };
    const b: DnrRule = {
      id: 9,
      priority: 1,
      action: { type: 'allow' },
      condition: {
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame', 'sub_frame'],
        requestDomains: ['a.com', 'b.com'],
      },
    };
    expect(ruleSignature(a)).toBe(ruleSignature(b));
    expect(ruleSignature(a)).not.toBe(ruleSignature({ ...b, priority: 2 }));
    expect(ruleSignature(a)).not.toBe(
      ruleSignature({ ...b, condition: { ...b.condition, excludedInitiatorDomains: ['x.com'] } }),
    );
  });
});

describe('diffDynamicRules', () => {
  const desired = buildDnrRules(blockRules()).rules;

  it('installs everything with ids from 1 on an empty browser', () => {
    const diff = diffDynamicRules([], desired);
    expect(diff.removeRuleIds).toEqual([]);
    expect(diff.addRules.map((r) => r.id)).toEqual(desired.map((_, i) => i + 1));
    expect(diff.kept).toBe(0);
  });

  it('changes nothing when the same rules are installed (whatever their ids)', () => {
    const installed = desired.map((spec, i) => ({ id: 500 + i * 3, ...spec })).reverse();
    expect(diffDynamicRules(installed, desired)).toEqual({
      removeRuleIds: [],
      addRules: [],
      kept: desired.length,
    });
  });

  it('replaces only the rules that changed and keeps the other ids', () => {
    const installed = diffDynamicRules([], desired).addRules;
    const next = buildDnrRules(
      blockRules({ blockDomains: [...blockRules().blockDomains, 'tiktok.com'] }),
    ).rules;
    const diff = diffDynamicRules(installed, next);
    expect(diff.removeRuleIds).toEqual([]);
    expect(diff.addRules).toHaveLength(1);
    expect(diff.addRules[0]?.action.redirect?.extensionPath).toBe(
      '/blocked.html?cause=domain&service=tiktok',
    );
    // A new id, never one of the kept rules.
    expect(diff.addRules[0]?.id).toBe(installed.length + 1);

    const youtubeOnly = buildDnrRules(blockRules({ blockDomains: [...YOUTUBE] })).rules;
    const shrink = diffDynamicRules(installed, youtubeOnly);
    expect(shrink.addRules).toEqual([]);
    expect(shrink.removeRuleIds).toHaveLength(2); // instagram + custom
    expect(shrink.kept).toBe(youtubeOnly.length);
  });

  it('never reuses an id removed in the same update, nor touches rules it does not own', () => {
    const foreign: DnrRule = {
      id: RULE_ID_RANGE.max + 1,
      action: { type: 'block' },
      condition: { requestDomains: ['ads.example'] },
    };
    const installed = [...diffDynamicRules([], desired).addRules, foreign];
    const other = buildDnrRules(examRules()).rules;
    const diff = diffDynamicRules(installed, other);
    expect(diff.removeRuleIds).not.toContain(foreign.id);
    const removed = new Set(diff.removeRuleIds);
    for (const rule of diff.addRules) {
      expect(removed.has(rule.id)).toBe(false);
      expect(rule.id).toBeLessThanOrEqual(RULE_ID_RANGE.max);
    }
  });

  it('removes duplicates of an installed rule', () => {
    const [first] = desired;
    const installed = [
      { id: 1, ...first! },
      { id: 2, ...first! },
    ];
    const diff = diffDynamicRules(installed, [first!]);
    expect(diff).toEqual({ removeRuleIds: [2], addRules: [], kept: 1 });
  });
});

describe('createDnrApplier', () => {
  it('applies atomically, then only what changed, and reports changes to listeners', async () => {
    const api = fakeDnr();
    const onChanged = vi.fn<(rules: unknown, result: DnrApplyResult) => void>();
    const applier = createDnrApplier({ api, onChanged, ...quiet });

    const first = await applier.apply(blockRules());
    expect(first).toMatchObject({
      version: blockRules().extRulesVersion,
      changed: true,
      removed: 0,
    });
    expect(api.updates).toHaveLength(1);
    expect(api.rules()).toHaveLength(first.ruleCount);
    expect(evaluateDnr(api.rules(), 'https://www.instagram.com/').action).toBe('redirect');
    expect(onChanged).toHaveBeenCalledTimes(1);

    const same = await applier.apply(blockRules({ nonce: 'another-nonce-000000' }));
    expect(same).toMatchObject({ changed: false, added: 0, removed: 0 });
    expect(api.updates).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(1);

    const exam = await applier.apply(examRules());
    expect(exam.changed).toBe(true);
    expect(api.updates).toHaveLength(2);
    expect(evaluateDnr(api.rules(), 'https://mail.google.com/').to).toBe(
      '/blocked.html?cause=whitelist',
    );
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(applier.last()).toEqual(exam);

    const none = await applier.apply(null);
    expect(none).toMatchObject({ version: null, ruleCount: 0, changed: true });
    expect(api.rules()).toEqual([]);
  });

  it('calls listeners on the first apply of a worker even when the browser already has the rules', async () => {
    const installed = diffDynamicRules([], buildDnrRules(blockRules()).rules).addRules;
    const api = fakeDnr({ initial: installed });
    const onChanged = vi.fn();
    const result = await createDnrApplier({ api, onChanged, ...quiet }).apply(blockRules());
    expect(api.updates).toHaveLength(0);
    expect(result.changed).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent applies (the last call wins)', async () => {
    const api = fakeDnr();
    const applier = createDnrApplier({ api, ...quiet });
    await Promise.all([
      applier.apply(examRules()),
      applier.apply(null),
      applier.apply(blockRules()),
    ]);
    expect(api.rules().map(({ id: _id, ...spec }) => spec)).toEqual(
      buildDnrRules(blockRules()).rules,
    );
  });

  it('retries without host patterns when the browser refuses a regex, and keeps the rules when it refuses anyway', async () => {
    const api = fakeDnr();
    api.refuse = (update) =>
      update.addRules.some((r) => r.condition.regexFilter?.includes('googleusercontent') ?? false);
    const applier = createDnrApplier({ api, ...quiet });
    const result = await applier.apply(examRules());
    expect(result.withoutHostPatterns).toBe(true);
    expect(api.updates).toHaveLength(2);
    expect(evaluateDnr(api.rules(), 'https://lh3.google.com/').to).toBe(
      '/blocked.html?cause=whitelist',
    );
    expect(evaluateDnr(api.rules(), 'https://docs.google.com/').action).toBe('allow');

    const before = structuredClone(api.rules());
    api.refuse = () => true;
    await expect(applier.apply(blockRules())).rejects.toThrow();
    expect(api.rules()).toEqual(before);
    expect(applier.last()).toEqual(result);
  });

  it('checks host patterns with isRegexSupported once each', async () => {
    const api = fakeDnr();
    const bad = hostPatternToRegexFilter('^lh[3-7]\\.google\\.com$');
    const isRegexSupported = vi.fn(async (regex: string) => regex !== bad);
    api.isRegexSupported = isRegexSupported;
    const applier = createDnrApplier({ api, ...quiet });
    const result = await applier.apply(examRules());
    expect(result.droppedPatterns).toEqual(['^lh[3-7]\\.google\\.com$']);
    await applier.apply(examRules({ extRulesVersion: examRules().extRulesVersion + 1 }));
    expect(isRegexSupported).toHaveBeenCalledTimes(3);
  });

  it("stays within the browser's limits and leaves other modules' rules alone", async () => {
    const foreign: DnrRule = {
      id: 200_000,
      action: { type: 'block' },
      condition: { regexFilter: '^https://ads\\.', resourceTypes: ['script'] },
    };
    const mine = (api: ReturnType<typeof fakeDnr>) =>
      api.rules().filter((r) => r.id !== foreign.id);

    const small = fakeDnr({ initial: [foreign], limits: { maxRules: 4 } });
    const merged = await createDnrApplier({ api: small, ...quiet }).apply(blockRules());
    expect(small.rules()).toContainEqual(foreign);
    expect(merged.merged).toBe(true);
    expect(mine(small).length).toBeLessThanOrEqual(3);
    expect(evaluateDnr(mine(small), 'https://www.example.org/').action).toBe('redirect');

    const regex = fakeDnr({ initial: [foreign], limits: { maxRegexRules: 3 } });
    const result = await createDnrApplier({ api: regex, ...quiet }).apply(examRules());
    expect(mine(regex).filter((r) => r.condition.regexFilter !== undefined)).toHaveLength(2);
    expect(result.droppedPatterns).toHaveLength(2);

    const tiny = fakeDnr({ limits: { maxRules: 5 } });
    const stripped = await createDnrApplier({ api: tiny, ...quiet }).apply(examRules());
    expect(tiny.rules()).toHaveLength(5);
    expect(stripped.droppedPatterns).toHaveLength(3);
    expect(evaluateDnr(tiny.rules(), 'https://docs.google.com/').action).toBe('allow');
  });

  it('propagates a refused update without host patterns (the version is then not applied)', async () => {
    const api = fakeDnr();
    api.refuse = () => true;
    await expect(createDnrApplier({ api, ...quiet }).apply(blockRules())).rejects.toThrow();
  });
});

describe('plugin registration', () => {
  it('registers the dnr plugin on import', () => {
    expect(backgroundPlugins().some((p) => p.name === 'dnr' && p.applyRules !== undefined)).toBe(
      true,
    );
  });
});
