import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyTargets } from '@centrate/shared/guardian-api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPrefsPatch,
  isTemplateInput,
  isUiPrefsPatch,
  readStoredPrefs,
  sanitizePrefs,
  sanitizeTemplates,
  upsertTemplate,
  writeStoredPrefs,
} from '../../../src/main/db/prefs-store';
import { DEFAULT_PREFS, DEFAULT_TEMPLATES, type TemplateInput } from '../../../src/shared/ui-state';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'centrate-prefs-'));
  dirs.push(d);
  return d;
}

const input = (patch: Partial<TemplateInput> = {}): TemplateInput => ({
  id: null,
  label: 'Mates 45 min',
  targets: { ...emptyTargets(), serviceIds: ['youtube'] },
  whitelistOnly: false,
  mode: 'strict',
  durationMinutes: 45,
  reason: 'Quiero aprobar mates',
  ...patch,
});

describe('prefs.json', () => {
  it('falls back field by field', () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(
      sanitizePrefs({
        theme: 'dark',
        autostart: 'yes',
        defaultMode: 'exam',
        lastReason: 'x'.repeat(141),
        closeHintShown: true,
      }),
    ).toEqual({ ...DEFAULT_PREFS, theme: 'dark', closeHintShown: true });
  });

  it('writes atomically and reads back; a damaged file gives defaults', () => {
    const dir = temp();
    const path = join(dir, 'prefs.json');
    expect(readStoredPrefs(path).templates.map((t) => t.id)).toEqual(['deberes', 'examen', 'leer']);
    const templates = upsertTemplate(DEFAULT_TEMPLATES, input(), () => 'tpl_abcdef123');
    if (!templates) throw new Error('rejected');
    writeStoredPrefs(path, { prefs: { ...DEFAULT_PREFS, theme: 'light' }, templates });
    const back = readStoredPrefs(path);
    expect(back.prefs.theme).toBe('light');
    expect(back.templates.map((t) => t.id)).toEqual(['deberes', 'examen', 'leer', 'tpl_abcdef123']);
    expect(JSON.parse(readFileSync(path, 'utf8')).v).toBe(1);
    writeFileSync(path, '{ nope');
    expect(readStoredPrefs(path).prefs).toEqual(DEFAULT_PREFS);
  });

  it('validates prefs patches', () => {
    expect(isUiPrefsPatch({ theme: 'dark', autostart: false })).toBe(true);
    expect(isUiPrefsPatch({ theme: 'sepia' })).toBe(false);
    expect(isUiPrefsPatch({ defaultMode: 'exam' })).toBe(false);
    expect(isUiPrefsPatch({ language: 'en' })).toBe(false);
    expect(isUiPrefsPatch(null)).toBe(false);
    expect(applyPrefsPatch(DEFAULT_PREFS, { defaultMode: 'strict' }).defaultMode).toBe('strict');
  });
});

describe('templates', () => {
  it('always keeps the built-ins, which can be customised but not replaced by junk', () => {
    const list = sanitizeTemplates([
      { ...DEFAULT_TEMPLATES[0], durationMinutes: 90, label: 'Deberes 1 h 30 min' },
      { id: 'tpl_bad!', label: 'x' },
      { ...input({ id: null }), id: 'tpl_good123', builtin: false },
    ]);
    expect(list.map((t) => t.id)).toEqual(['deberes', 'examen', 'leer', 'tpl_good123']);
    expect(list[0]).toMatchObject({ builtin: true, durationMinutes: 90 });
  });

  it('accepts only templates that make a valid block', () => {
    expect(isTemplateInput(input())).toBe(true);
    expect(isTemplateInput(input({ durationMinutes: 3 }))).toBe(false);
    expect(isTemplateInput(input({ targets: emptyTargets() }))).toBe(false);
    expect(isTemplateInput(input({ label: '' }))).toBe(false);
    expect(isTemplateInput({ ...input(), extra: 1 })).toBe(false);
    expect(
      isTemplateInput(input({ mode: 'exam', whitelistOnly: true, targets: emptyTargets() })),
    ).toBe(true);
  });

  it('upserts by id', () => {
    const first = upsertTemplate(DEFAULT_TEMPLATES, input(), () => 'tpl_one1234');
    if (!first) throw new Error('rejected');
    const edited = upsertTemplate(
      first,
      input({ id: 'tpl_one1234', durationMinutes: 50 }),
      () => 'unused',
    );
    expect(edited?.find((t) => t.id === 'tpl_one1234')?.durationMinutes).toBe(50);
    const builtin = upsertTemplate(
      first,
      input({ id: 'leer', label: 'Leer 40 min', durationMinutes: 40 }),
      () => 'x',
    );
    expect(builtin?.find((t) => t.id === 'leer')).toMatchObject({
      builtin: true,
      durationMinutes: 40,
    });
    expect(upsertTemplate(first, input({ id: 'tpl_missing1' }), () => 'x')).toBeNull();
  });
});
