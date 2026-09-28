/**
 * Actions of the whitelist editor in «Modo examen» (`useBloqueosWindow` builds them). Every change
 * is one `settings:put` with the **full** settings (`whitelist.ts` builds the body so no other
 * pending change is lost); the guardian answers with the new settings and pending list, which
 * replace the window's copy. The fields live in `detail.bloqueos.exam` (fixture-settable).
 */
import type { CatalogPlatform } from '@centrate/shared/catalog';
import type { SettingsResponse } from '@centrate/shared/guardian-api';
import type { CentrateBridge } from '../../../../shared/ipc';
import type { BloqueosLocalState } from '../../../../shared/ui-state';
import {
  addedNotice,
  checkWhitelistDomain,
  checkWhitelistProcess,
  removedNotice,
  whitelistErrorText,
  whitelistLists,
  withWhitelistEntry,
  withoutWhitelistEntry,
  type SettingsData,
  type WhitelistEntryView,
  type WhitelistKind,
  type WhitelistNotice,
} from './whitelist';

export interface WhitelistActions {
  setWhitelistDomainInput(text: string): void;
  setWhitelistProcessInput(text: string): void;
  allowDomain(): void;
  allowProcess(): void;
  /** A running program offered under the app field. */
  allowSuggestion(name: string): void;
  removeWhitelistEntry(entry: Pick<WhitelistEntryView, 'kind' | 'value'>): void;
  retrySettings(): void;
}

export interface WhitelistActionDeps {
  bridge: CentrateBridge;
  local(): BloqueosLocalState;
  updateLocal(fn: (local: BloqueosLocalState) => BloqueosLocalState): void;
  getSettings(): SettingsData;
  setSettings(data: SettingsData): void;
  loadSettings(): void;
  platform(): CatalogPlatform;
  now(): number;
  isSaving(): boolean;
  setSaving(saving: boolean): void;
  notify(notice: WhitelistNotice | null): void;
  mounted(): boolean;
}

export function createWhitelistActions(d: WhitelistActionDeps): WhitelistActions {
  const ready = (): SettingsResponse | null => {
    const s = d.getSettings();
    return s.status === 'ready' ? s.value : null;
  };

  const setExam = (patch: Partial<BloqueosLocalState['exam']>): void =>
    d.updateLocal((local) => {
      const exam = { ...local.exam, ...patch };
      return exam.domainInput === local.exam.domainInput &&
        exam.processInput === local.exam.processInput
        ? local
        : { ...local, exam };
    });

  /** One PUT; `after` says what to tell the user once the guardian accepted it. */
  const put = (
    body: ReturnType<typeof withWhitelistEntry>,
    value: string,
    after: (response: SettingsResponse) => WhitelistNotice,
    clear: () => void,
  ): void => {
    d.setSaving(true);
    void d.bridge.invoke('settings:put', { settings: body }).then(
      (result) => {
        if (!d.mounted()) return;
        d.setSaving(false);
        if (!result.ok) {
          d.notify({ text: whitelistErrorText(result.error, value), tone: 'red' });
          return;
        }
        d.setSettings({ status: 'ready', value: result.value });
        clear();
        d.notify(after(result.value));
      },
      () => {
        if (d.mounted()) d.setSaving(false);
      },
    );
  };

  const add = (kind: WhitelistKind, input: string, clear: () => void): void => {
    const response = ready();
    if (!response || d.isSaving()) return;
    const lists = whitelistLists(response);
    const check =
      kind === 'domain'
        ? checkWhitelistDomain(input, lists)
        : checkWhitelistProcess(input, lists, d.platform());
    if (!check.ok) {
      d.notify({ text: check.error, tone: 'orange' });
      return;
    }
    const value = check.value;
    put(
      withWhitelistEntry(response, kind, value),
      value,
      (after) => addedNotice(after, kind, value, d.now()),
      clear,
    );
  };

  return {
    setWhitelistDomainInput: (text) => {
      setExam({ domainInput: text });
      d.notify(null);
    },
    setWhitelistProcessInput: (text) => {
      setExam({ processInput: text });
      d.notify(null);
    },
    allowDomain: () =>
      add('domain', d.local().exam.domainInput, () => setExam({ domainInput: '' })),
    allowProcess: () =>
      add('process', d.local().exam.processInput, () => setExam({ processInput: '' })),
    allowSuggestion: (name) => add('process', name, () => setExam({ processInput: '' })),
    removeWhitelistEntry: (entry) => {
      const response = ready();
      if (!response || d.isSaving()) return;
      put(
        withoutWhitelistEntry(response, entry.kind, entry.value),
        entry.value,
        () => removedNotice(entry.value),
        () => undefined,
      );
    },
    retrySettings: () => {
      d.setSettings({ status: 'loading' });
      d.loadSettings();
    },
  };
}
