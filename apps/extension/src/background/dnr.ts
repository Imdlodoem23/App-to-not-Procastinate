/**
 * Applies the rules in force to the browser's `declarativeNetRequest` dynamic rules.
 *
 * - **Atomic.** One `updateDynamicRules({ removeRuleIds, addRules })` per change: the browser
 *   swaps the whole set at once or keeps the previous one (a refused update never leaves
 *   the browser half-blocked, and the version is then not reported as applied).
 * - **Stable ids.** The desired rules (rules.ts) carry no ids; each is matched by content
 *   with a rule already installed, which keeps its id. Only rules that really changed are
 *   removed and added, with the smallest free ids of `RULE_ID_RANGE` (never an id removed
 *   in the same call, never an id outside the range: other modules may own those).
 * - **Limits.** The rule and regex budgets are the smaller of rules.ts' defaults and the
 *   browser's constants, minus rules other modules own. Host patterns the browser does not
 *   support (`isRegexSupported`) are left out; if the browser still refuses the update,
 *   it is retried once without any host-pattern rule (the whitelist gets stricter).
 * - Registered as the `dnr` background plugin: `applyRules` runs at every worker start and
 *   whenever the rules in force change (state.ts, index.ts). After an apply that changed
 *   the browser's rules (or the first one of a worker), `onDnrRulesChanged` listeners run;
 *   attempts.ts uses it to move tabs already open on a newly blocked site.
 */

import type { ExtRulesResponse } from '@centrate/shared/guardian-api';
import type { DnrLimits, DnrRule, DnrRuleSpec } from './rules';
import {
  DEFAULT_DNR_LIMITS,
  LOOPBACK_REGEX_FILTER,
  buildDnrRules,
  hostPatternToRegexFilter,
} from './rules';
import { registerBackgroundPlugin } from './state';

/** Dynamic rule ids this module owns; rules outside the range are never touched. */
export const RULE_ID_RANGE = Object.freeze({ min: 1, max: 99_999 });

const inRange = (id: number): boolean => id >= RULE_ID_RANGE.min && id <= RULE_ID_RANGE.max;

// ---------------------------------------------------------------------------------------
// Browser API
// ---------------------------------------------------------------------------------------

export interface DnrUpdate {
  removeRuleIds: number[];
  addRules: DnrRule[];
}

/** The subset of `chrome.declarativeNetRequest` this module uses (a fake in tests). */
export interface DnrApi {
  getDynamicRules(): Promise<DnrRule[]>;
  updateDynamicRules(update: DnrUpdate): Promise<void>;
  /** `isRegexSupported`, when the browser has it. */
  isRegexSupported?: (regex: string) => Promise<boolean>;
  /** The browser's own limits, when it exposes them. */
  limits(): Partial<Pick<DnrLimits, 'maxRules' | 'maxRegexRules'>>;
}

function smallest(...values: Array<number | undefined>): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length > 0 ? Math.min(...known) : undefined;
}

/** `chrome.declarativeNetRequest` behind `DnrApi` (promise API: Chrome 121+, Firefox 128+). */
export function chromeDnrApi(): DnrApi {
  const dnr = chrome.declarativeNetRequest;
  const constants = dnr as unknown as Record<string, unknown>;
  const constant = (key: string): number | undefined => {
    const value = constants[key];
    return typeof value === 'number' && value > 0 ? value : undefined;
  };
  const check = (dnr as Partial<typeof dnr>).isRegexSupported;
  return {
    getDynamicRules: () => dnr.getDynamicRules(),
    updateDynamicRules: (update) => dnr.updateDynamicRules(update),
    isRegexSupported:
      typeof check === 'function'
        ? async (regex) => (await dnr.isRegexSupported({ regex })).isSupported
        : undefined,
    limits: () => ({
      // Chrome: 30 000 dynamic but 5 000 «unsafe» (redirect); older builds and Firefox:
      // 5 000 dynamic (+ session).
      maxRules: smallest(
        constant('MAX_NUMBER_OF_DYNAMIC_RULES'),
        constant('MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES'),
        constant('MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES'),
      ),
      maxRegexRules: constant('MAX_NUMBER_OF_REGEX_RULES'),
    }),
  };
}

// ---------------------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------------------

/** Condition keys whose arrays are sets (order does not matter). */
const SET_KEYS = new Set([
  'requestDomains',
  'excludedRequestDomains',
  'initiatorDomains',
  'excludedInitiatorDomains',
  'topDomains',
  'excludedTopDomains',
  'domains',
  'excludedDomains',
  'resourceTypes',
  'excludedResourceTypes',
  'requestMethods',
  'excludedRequestMethods',
  'tabIds',
  'excludedTabIds',
]);

function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    if (key === undefined || !SET_KEYS.has(key)) return items;
    return items
      .map((item) => [JSON.stringify(item), item] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, item]) => item);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue;
      // Browsers may fill in this default when they return rules.
      if (k === 'isUrlFilterCaseSensitive' && v === false) continue;
      out[k] = canonical(v, k);
    }
    return out;
  }
  return value;
}

/**
 * A rule's content without its id, in canonical form (sorted keys and set-like arrays,
 * defaults dropped), so a rule read back from the browser equals the one that was added.
 */
export function ruleSignature(rule: DnrRuleSpec | DnrRule): string {
  return JSON.stringify(
    canonical({ priority: rule.priority ?? 1, action: rule.action, condition: rule.condition }),
  );
}

export interface RuleDiff extends DnrUpdate {
  /** Installed rules that stay as they are. */
  kept: number;
}

export function hasChanges(diff: DnrUpdate): boolean {
  return diff.removeRuleIds.length > 0 || diff.addRules.length > 0;
}

/**
 * What to remove and add so the rules this module owns become `desired`. Rules outside
 * `RULE_ID_RANGE` are left alone and their ids never reused.
 */
export function diffDynamicRules(
  existing: readonly DnrRule[],
  desired: readonly DnrRuleSpec[],
): RuleDiff {
  const owned = existing.filter((rule) => inRange(rule.id)).sort((a, b) => a.id - b.id);
  const taken = new Set(existing.map((rule) => rule.id));
  const bySignature = new Map<string, number[]>();
  for (const rule of owned) {
    const signature = ruleSignature(rule);
    const ids = bySignature.get(signature);
    if (ids) ids.push(rule.id);
    else bySignature.set(signature, [rule.id]);
  }

  const kept = new Set<number>();
  const toAdd: DnrRuleSpec[] = [];
  for (const spec of desired) {
    const id = bySignature.get(ruleSignature(spec))?.shift();
    if (id === undefined) toAdd.push(spec);
    else kept.add(id);
  }

  const removeRuleIds = owned.filter((rule) => !kept.has(rule.id)).map((rule) => rule.id);
  let next = RULE_ID_RANGE.min;
  const addRules = toAdd.map((spec): DnrRule => {
    while (taken.has(next)) next += 1;
    if (next > RULE_ID_RANGE.max) throw new RangeError('no free dynamic rule id');
    const id = next;
    next += 1;
    return { id, ...spec };
  });
  return { removeRuleIds, addRules, kept: kept.size };
}

// ---------------------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------------------

export interface DnrApplyResult {
  /** `extRulesVersion` of the rules applied (`null`: none, every rule removed). */
  version: number | null;
  /** Rules this module has in the browser now. */
  ruleCount: number;
  added: number;
  removed: number;
  /** The browser's rules changed, or this was the first apply since the worker started. */
  changed: boolean;
  /** Whitelist host patterns left out: the hosts they match stay blocked. */
  droppedPatterns: string[];
  /** Blocked hosts were merged into service-less rules to fit the rule budget. */
  merged: boolean;
  /** The browser refused the rules with host patterns; they were applied without them. */
  withoutHostPatterns: boolean;
}

export type DnrChangeListener = (
  rules: ExtRulesResponse | null,
  result: DnrApplyResult,
) => void | Promise<void>;

export interface DnrApplierOptions {
  /** Default `chromeDnrApi()` (created on first use). */
  api?: DnrApi;
  /** Runs after an apply that changed the rules (and after the first apply). */
  onChanged?: DnrChangeListener;
  /** Diagnostics (default `console.warn`). */
  warn?: (message: string, error?: unknown) => void;
}

export interface DnrApplier {
  /**
   * Makes the browser enforce `rules` (`null`: remove every rule of this module). Calls are
   * serialized. Throws when the browser refuses the update; the previous rules then stay.
   */
  apply(rules: ExtRulesResponse | null): Promise<DnrApplyResult>;
  /** The last successful result in this worker, or `null`. */
  last(): DnrApplyResult | null;
}

function isHostPatternRule(rule: DnrRuleSpec): boolean {
  const filter = rule.condition.regexFilter;
  return filter !== undefined && filter !== LOOPBACK_REGEX_FILTER;
}

export function createDnrApplier(options: DnrApplierOptions = {}): DnrApplier {
  let api: DnrApi | null = options.api ?? null;
  const getApi = (): DnrApi => (api ??= chromeDnrApi());
  const warn = options.warn ?? ((message, error) => console.warn(message, error));
  const regexSupport = new Map<string, boolean>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastResult: DnrApplyResult | null = null;

  async function unsupportedRegexes(
    dnr: DnrApi,
    rules: ExtRulesResponse | null,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const check = dnr.isRegexSupported;
    if (check === undefined || rules === null || rules.whitelist === null) return out;
    for (const pattern of rules.whitelist.allowHostPatterns) {
      const filter = hostPatternToRegexFilter(pattern);
      if (filter === null) continue;
      let supported = regexSupport.get(filter);
      if (supported === undefined) {
        try {
          supported = await check(filter);
        } catch {
          supported = false;
        }
        regexSupport.set(filter, supported);
      }
      if (!supported) out.add(filter);
    }
    return out;
  }

  async function run(rules: ExtRulesResponse | null): Promise<DnrApplyResult> {
    const dnr = getApi();
    const existing = await dnr.getDynamicRules();
    const foreign = existing.filter((rule) => !inRange(rule.id));
    const foreignRegex = foreign.filter((rule) => rule.condition.regexFilter !== undefined).length;
    const browser = dnr.limits();
    const limits: Partial<DnrLimits> = {
      maxRules: Math.max(
        0,
        Math.min(DEFAULT_DNR_LIMITS.maxRules, browser.maxRules ?? Infinity) - foreign.length,
      ),
      maxRegexRules: Math.max(
        0,
        Math.min(DEFAULT_DNR_LIMITS.maxRegexRules, browser.maxRegexRules ?? Infinity) -
          foreignRegex,
      ),
    };
    const unsupportedRegex = await unsupportedRegexes(dnr, rules);

    let plan = buildDnrRules(rules, { limits, unsupportedRegex });
    let diff = diffDynamicRules(existing, plan.rules);
    let withoutHostPatterns = false;
    if (hasChanges(diff)) {
      try {
        await dnr.updateDynamicRules({
          removeRuleIds: diff.removeRuleIds,
          addRules: diff.addRules,
        });
      } catch (error) {
        if (!plan.rules.some(isHostPatternRule)) throw error;
        warn('Céntrate: the browser refused the rules; retrying without host patterns', error);
        plan = buildDnrRules(rules, { limits, unsupportedRegex, skipHostPatterns: true });
        diff = diffDynamicRules(existing, plan.rules);
        withoutHostPatterns = true;
        if (hasChanges(diff)) {
          await dnr.updateDynamicRules({
            removeRuleIds: diff.removeRuleIds,
            addRules: diff.addRules,
          });
        }
      }
    }

    const result: DnrApplyResult = {
      version: rules?.extRulesVersion ?? null,
      ruleCount: plan.rules.length,
      added: diff.addRules.length,
      removed: diff.removeRuleIds.length,
      changed: hasChanges(diff) || lastResult === null,
      droppedPatterns: plan.droppedPatterns,
      merged: plan.merged,
      withoutHostPatterns,
    };
    lastResult = result;
    if (result.changed && options.onChanged !== undefined) {
      try {
        await options.onChanged(rules, result);
      } catch (error) {
        warn('Céntrate: a DNR change listener failed', error);
      }
    }
    return result;
  }

  return {
    apply(rules) {
      const task = queue.then(
        () => run(rules),
        () => run(rules),
      );
      queue = task.catch(() => undefined);
      return task;
    },
    last: () => lastResult,
  };
}

// ---------------------------------------------------------------------------------------
// Background plugin
// ---------------------------------------------------------------------------------------

const changeListeners = new Set<DnrChangeListener>();

/** Adds a listener for applies that changed the browser's rules; returns the unsubscribe. */
export function onDnrRulesChanged(listener: DnrChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** The worker's applier (the `dnr` plugin drives it). */
export const dnrApplier: DnrApplier = createDnrApplier({
  async onChanged(rules, result) {
    for (const listener of changeListeners) {
      try {
        await listener(rules, result);
      } catch (error) {
        console.warn('Céntrate: a DNR change listener failed', error);
      }
    }
  },
});

registerBackgroundPlugin({
  name: 'dnr',
  async applyRules(rules) {
    await dnrApplier.apply(rules);
  },
});
