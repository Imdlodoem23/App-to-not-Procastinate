/**
 * `userData/prefs.json`: app preferences (`UiPrefs`) and block templates (docs/DESKTOP.md
 * §6.5). Read **synchronously** before any window exists (theme, background color); every
 * field is validated on its own and falls back to its default, so a damaged file never
 * blocks the app. Writes are atomic (temporary file, then rename).
 *
 * Built-in templates («Deberes 1 h», «Examen 3 h», «Leer 30 min») always exist; the user may
 * customise them (they stay built-in and cannot be deleted) and add their own (`tpl_<id>`).
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CATEGORY_IDS } from '@centrate/shared/catalog';
import { BLOCK_MODES, type BlockMode, type TargetSpec } from '@centrate/shared/domain';
import {
  GUARDIAN_LIMITS,
  emptyAllow,
  emptyTargets,
  isCreateBlockRequest,
} from '@centrate/shared/guardian-api';
import {
  DEFAULT_PREFS,
  DEFAULT_TEMPLATES,
  type BlockTemplate,
  type DefaultBlockMode,
  type TemplateInput,
  type UiPrefs,
  type UiPrefsPatch,
} from '../../shared/ui-state';

export const PREFS_FILE = 'prefs.json';
export const TEMPLATE_LABEL_MAX = 40;
export const MAX_USER_TEMPLATES = 30;
const TEMPLATE_ID_RE = /^(?:deberes|examen|leer|tpl_[A-Za-z0-9_-]{6,64})$/;
const THEMES = ['system', 'light', 'dark'] as const;
const DEFAULT_MODES: readonly DefaultBlockMode[] = ['normal', 'strict', 'hardcore'];

export interface StoredPrefs {
  prefs: UiPrefs;
  templates: BlockTemplate[];
}

// ---------------------------------------------------------------------------------------
// Validation (field by field)
// ---------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTheme(v: unknown): v is UiPrefs['theme'] {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

function isDefaultMode(v: unknown): v is DefaultBlockMode {
  return typeof v === 'string' && (DEFAULT_MODES as readonly string[]).includes(v);
}

function isReason(v: unknown): v is string {
  return typeof v === 'string' && v.length <= GUARDIAN_LIMITS.reasonMaxLength;
}

export function sanitizePrefs(value: unknown): UiPrefs {
  const r = isRecord(value) ? value : {};
  return {
    v: 1,
    theme: isTheme(r['theme']) ? r['theme'] : DEFAULT_PREFS.theme,
    autostart: typeof r['autostart'] === 'boolean' ? r['autostart'] : DEFAULT_PREFS.autostart,
    defaultMode: isDefaultMode(r['defaultMode']) ? r['defaultMode'] : DEFAULT_PREFS.defaultMode,
    lastReason: isReason(r['lastReason']) ? r['lastReason'] : DEFAULT_PREFS.lastReason,
    closeHintShown:
      typeof r['closeHintShown'] === 'boolean' ? r['closeHintShown'] : DEFAULT_PREFS.closeHintShown,
    language: 'es',
  };
}

type PatchKey = keyof UiPrefsPatch;

/** A `prefs:set` payload: only known keys, each with its own type. */
export function isUiPrefsPatch(value: unknown): value is UiPrefsPatch {
  if (!isRecord(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    switch (key as PatchKey) {
      case 'theme':
        if (!isTheme(v)) return false;
        break;
      case 'autostart':
      case 'closeHintShown':
        if (typeof v !== 'boolean') return false;
        break;
      case 'defaultMode':
        if (!isDefaultMode(v)) return false;
        break;
      case 'lastReason':
        if (!isReason(v)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

export function applyPrefsPatch(prefs: UiPrefs, patch: UiPrefsPatch): UiPrefs {
  const next: UiPrefs = { ...prefs };
  if (patch.theme !== undefined) next.theme = patch.theme;
  if (patch.autostart !== undefined) next.autostart = patch.autostart;
  if (patch.defaultMode !== undefined) next.defaultMode = patch.defaultMode;
  if (patch.lastReason !== undefined) next.lastReason = patch.lastReason;
  if (patch.closeHintShown !== undefined) next.closeHintShown = patch.closeHintShown;
  return next;
}

function isStringList(v: unknown, max: number): v is string[] {
  return Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string');
}

function asTargets(v: unknown): TargetSpec | null {
  if (!isRecord(v)) return null;
  const t = {
    serviceIds: v['serviceIds'],
    categoryIds: v['categoryIds'],
    appIds: v['appIds'],
    customDomains: v['customDomains'],
    customProcesses: v['customProcesses'],
  };
  if (
    !isStringList(t.serviceIds, GUARDIAN_LIMITS.maxIdsPerList) ||
    !isStringList(t.categoryIds, GUARDIAN_LIMITS.maxIdsPerList) ||
    !t.categoryIds.every((c) => (CATEGORY_IDS as readonly string[]).includes(c)) ||
    !isStringList(t.appIds, GUARDIAN_LIMITS.maxIdsPerList) ||
    !isStringList(t.customDomains, GUARDIAN_LIMITS.maxCustomDomains) ||
    !isStringList(t.customProcesses, GUARDIAN_LIMITS.maxCustomProcesses)
  ) {
    return null;
  }
  return {
    serviceIds: [...t.serviceIds],
    categoryIds: [...t.categoryIds] as TargetSpec['categoryIds'],
    appIds: [...t.appIds],
    customDomains: [...t.customDomains],
    customProcesses: [...t.customProcesses],
  };
}

/**
 * A template is valid when the block it would create is a valid `CreateBlockRequest` (same
 * validators as the guardian), with its mode resolved to Normal when it follows Ajustes.
 */
export function templateToRequestIsValid(t: Omit<BlockTemplate, 'id' | 'builtin'>): boolean {
  const mode: BlockMode = t.mode ?? 'normal';
  const whitelistOnly = t.whitelistOnly || mode === 'exam';
  return isCreateBlockRequest({
    targets: whitelistOnly ? emptyTargets() : t.targets,
    whitelistOnly,
    allow: emptyAllow(),
    mode,
    durationMinutes: t.durationMinutes,
    endsAt: null,
    reason: (t.reason ?? '').trim(),
    acknowledgeLong: t.durationMinutes > GUARDIAN_LIMITS.longBlockConfirmMinutes,
    acknowledgeNoEmergency: mode === 'hardcore' || mode === 'exam',
  });
}

/** A `templates:save` payload (exact keys; `id: null` creates one). */
export function isTemplateInput(value: unknown): value is TemplateInput {
  if (!isRecord(value)) return false;
  const keys = ['id', 'label', 'targets', 'whitelistOnly', 'mode', 'durationMinutes', 'reason'];
  if (Object.keys(value).some((k) => !keys.includes(k))) return false;
  const id = value['id'];
  if (id !== null && (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id))) return false;
  return parseTemplateBody(value) !== null;
}

function parseTemplateBody(
  r: Record<string, unknown>,
): Omit<BlockTemplate, 'id' | 'builtin'> | null {
  const label = typeof r['label'] === 'string' ? r['label'].trim() : '';
  const targets = asTargets(r['targets']);
  const mode = r['mode'];
  const duration = r['durationMinutes'];
  const reason = r['reason'];
  if (label === '' || label.length > TEMPLATE_LABEL_MAX || !targets) return null;
  if (typeof r['whitelistOnly'] !== 'boolean') return null;
  if (
    mode !== null &&
    (typeof mode !== 'string' || !(BLOCK_MODES as readonly string[]).includes(mode))
  ) {
    return null;
  }
  if (typeof duration !== 'number' || !Number.isInteger(duration)) return null;
  if (reason !== null && !isReason(reason)) return null;
  const body: Omit<BlockTemplate, 'id' | 'builtin'> = {
    label,
    targets,
    whitelistOnly: r['whitelistOnly'],
    mode: mode as BlockMode | null,
    durationMinutes: duration,
    reason: reason as string | null,
  };
  return templateToRequestIsValid(body) ? body : null;
}

/** Stored templates: invalid entries dropped, built-ins always present and first. */
export function sanitizeTemplates(value: unknown): BlockTemplate[] {
  const list = Array.isArray(value) ? value : [];
  const byId = new Map<string, BlockTemplate>();
  for (const item of list) {
    if (!isRecord(item) || typeof item['id'] !== 'string' || !TEMPLATE_ID_RE.test(item['id'])) {
      continue;
    }
    const body = parseTemplateBody(item);
    if (!body || byId.has(item['id'])) continue;
    const builtin = DEFAULT_TEMPLATES.some((t) => t.id === item['id']);
    byId.set(item['id'], { id: item['id'], builtin, ...body });
  }
  const builtins = DEFAULT_TEMPLATES.map((t) => byId.get(t.id) ?? cloneTemplate(t));
  const users = [...byId.values()].filter((t) => !t.builtin).slice(0, MAX_USER_TEMPLATES);
  return [...builtins, ...users];
}

export function cloneTemplate(t: BlockTemplate): BlockTemplate {
  return {
    ...t,
    targets: {
      serviceIds: [...t.targets.serviceIds],
      categoryIds: [...t.targets.categoryIds],
      appIds: [...t.targets.appIds],
      customDomains: [...t.targets.customDomains],
      customProcesses: [...t.targets.customProcesses],
    },
  };
}

export function defaultTemplates(): BlockTemplate[] {
  return DEFAULT_TEMPLATES.map(cloneTemplate);
}

/** Insert or replace a template (`id: null` gets `newId()`). `null` when invalid or full. */
export function upsertTemplate(
  templates: readonly BlockTemplate[],
  input: TemplateInput,
  newId: () => string,
): BlockTemplate[] | null {
  const body = parseTemplateBody(input as unknown as Record<string, unknown>);
  if (!body) return null;
  if (input.id !== null) {
    const index = templates.findIndex((t) => t.id === input.id);
    if (index < 0) return null;
    const existing = templates[index];
    if (!existing) return null;
    const next = [...templates];
    next[index] = { id: existing.id, builtin: existing.builtin, ...body };
    return next;
  }
  if (templates.filter((t) => !t.builtin).length >= MAX_USER_TEMPLATES) return null;
  return [...templates, { id: newId(), builtin: false, ...body }];
}

// ---------------------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------------------

export function readStoredPrefs(path: string): StoredPrefs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    parsed = null;
  }
  const r = isRecord(parsed) ? parsed : {};
  return { prefs: sanitizePrefs(r['prefs']), templates: sanitizeTemplates(r['templates']) };
}

/** Atomic write (temporary file in the same folder, then rename). */
export function writeStoredPrefs(path: string, stored: StoredPrefs): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body = JSON.stringify({ v: 1, prefs: stored.prefs, templates: stored.templates }, null, 2);
  try {
    writeFileSync(tmp, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    throw error;
  }
}

export function prefsPath(userDataDir: string): string {
  return join(userDataDir, PREFS_FILE);
}
