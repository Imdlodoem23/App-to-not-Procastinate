/**
 * Controls of the Ajustes window that the kit does not have as such: the group's result line,
 * a 48 px row whose control is three or four compact tiles («Tema», «Objetivo diario»), the
 * shortcut recorder, the volume slider and the punishment level with Nuclear's in-place
 * «¿Seguro?». All of them keep every settings row at 48 px (one line of title, one of
 * description).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { PunishmentLevel } from '@centrate/shared/domain';
import {
  Field,
  Segmented,
  SettingsRow,
  Tile,
  TileRow,
  settingsRowIds,
  type SegmentedOption,
} from '../../components';
import { useArmed } from '../../hooks/useArmed';
import { useHelp } from '../../hooks/useHelp';
import { formatInt } from '../../../../shared/format';
import type { ShortcutAction } from '../../../../shared/prefs';
import type { Platform } from '../../../../shared/ui-state';
import { AJUSTES } from './i18n';
import { captureShortcut } from './shortcuts';
import type { AjustesNotice } from './useAjustes';
import { AJUSTES_IDS, NUCLEAR_ARM_ID, type AjustesView, type ShortcutRowView } from './view';

const A = AJUSTES;

/**
 * A group's result line: a polite region that is always mounted (zero height while empty), so
 * «Hecho: tus datos se han borrado» is announced when its text arrives.
 */
export function Notice(props: { notice: AjustesNotice | undefined }): React.JSX.Element {
  const { notice } = props;
  return (
    <div className="aj-notice" aria-live="polite" aria-atomic="true">
      {notice ? (
        <span
          key={notice.seq}
          className={notice.spokenOnly ? 'sr-only' : 'aj-notice-text'}
          data-tone={notice.tone}
        >
          {notice.text}
        </span>
      ) : null}
    </div>
  );
}

/**
 * «Tema: Sistema | Claro | Oscuro» as a 48 px settings row: title and description on the left
 * (the hovered or focused option's help replaces the description), three or four compact tiles
 * on the right. `note` (a pending change, in orange) replaces the description while no option is
 * hovered. The row's own help line stays for screen readers only (the tiles' description).
 */
export function ChoiceRow<T extends string>(props: {
  id: string;
  rowId: string;
  title: ReactNode;
  description: string;
  note?: string | null;
  value: T | null;
  columns?: 3 | 4;
  options: readonly (SegmentedOption<NoInfer<T>> & { help: string })[];
  onChange(value: NoInfer<T>): void;
}): React.JSX.Element {
  const active = useHelp(props.rowId).active;
  const shown = props.options.find((o) => o.value === active);
  const columns = props.columns ?? 3;
  return (
    <SettingsRow
      id={props.id}
      className={columns === 4 ? 'aj-choice aj-choice-4' : 'aj-choice'}
      title={props.title}
      description={
        shown ? (
          shown.help
        ) : props.note ? (
          <span data-tone="orange">{props.note}</span>
        ) : (
          props.description
        )
      }
    >
      <Segmented<T>
        id={props.rowId}
        label={typeof props.title === 'string' ? props.title : props.rowId}
        columns={columns}
        value={props.value ?? ('' as T)}
        options={props.options}
        onChange={props.onChange}
        help={props.note ?? props.description}
      />
    </SettingsRow>
  );
}

/**
 * One global shortcut: the combination in a read-only field on the right. Focusing the field
 * (click or Tab) records: the next combination with Ctrl/Cmd, Alt or Super is saved, Backspace
 * or Delete removes it, Esc stops. Enter or Space records again. The window's own keys (Esc
 * closing it, Alt + letter) wait while it records.
 */
export function ShortcutRow(props: {
  row: ShortcutRowView;
  platform: Platform;
  onCapture(action: ShortcutAction | null): void;
  onSave(action: ShortcutAction, accelerator: string | null): void;
  onHint(text: string): void;
}): React.JSX.Element {
  const { row, platform } = props;
  const id = `aj-shortcut-${row.action}`;
  const ids = settingsRowIds(id);
  return (
    <SettingsRow
      id={id}
      title={row.title}
      description={<span data-tone={row.tone}>{row.description}</span>}
    >
      <Field
        value={row.capturing ? '' : row.label}
        onChange={() => undefined}
        readOnly
        label={row.title}
        placeholder={row.capturing ? A.shortcuts.press : A.shortcuts.none}
        describedBy={ids.description}
        className="aj-shortcut"
        data-capturing={row.capturing ? '' : undefined}
        onFocus={() => props.onCapture(row.action)}
        onBlur={() => {
          if (row.capturing) props.onCapture(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (!row.capturing) {
            if (
              (event.key === 'Enter' || event.key === ' ') &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              event.preventDefault();
              props.onCapture(row.action);
            }
            return;
          }
          const result = captureShortcut(
            {
              code: event.code,
              key: event.key,
              ctrl: event.ctrlKey,
              meta: event.metaKey,
              alt: event.altKey,
              shift: event.shiftKey,
            },
            platform,
          );
          if (result.kind === 'ignore' && event.key === 'Tab') return;
          event.preventDefault();
          switch (result.kind) {
            case 'set':
              props.onSave(row.action, result.accelerator);
              return;
            case 'clear':
              props.onSave(row.action, null);
              return;
            case 'cancel':
              props.onCapture(null);
              return;
            case 'need-modifier':
              props.onHint(A.shortcuts.needModifier);
              return;
            case 'ignore':
              return;
          }
        }}
      />
    </SettingsRow>
  );
}

/**
 * «Volumen»: a slider (arrow keys move it by 5) with the value beside it. It follows the pointer
 * locally and saves on release (`change`), so a drag is one write.
 */
export function VolumeRow(props: {
  volume: number;
  onCommit(volume: number): void;
}): React.JSX.Element {
  const { volume, onCommit } = props;
  /** The value being dragged, over the saved `base`; a new saved volume replaces it. */
  const [draft, setDraft] = useState<{ value: number; base: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  useLayoutEffect(() => {
    commit.current = onCommit;
  });
  const ids = settingsRowIds('aj-volume');

  useEffect(() => {
    const el = input.current;
    if (!el) return undefined;
    const onChange = (): void => commit.current(Number(el.value));
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);

  const shown = draft && draft.base === volume ? draft.value : volume;
  const label = A.general.volumeValue(formatInt(shown));
  return (
    <SettingsRow id="aj-volume" title={A.general.volume} description={A.general.volumeDesc}>
      {/* Named with `aria-label` (the row title's words): a name by reference is lost to axe
          while the row is scrolled out of the detail window. */}
      <input
        ref={input}
        type="range"
        min={0}
        max={100}
        step={5}
        value={shown}
        className="aj-range"
        aria-label={A.general.volume}
        aria-describedby={ids.description}
        aria-valuetext={label}
        onChange={(event) => setDraft({ value: Number(event.target.value), base: volume })}
      />
      <span className="aj-value aj-range-value" aria-hidden="true">
        {label}
      </span>
    </SettingsRow>
  );
}

/**
 * «Nivel de castigo: 1 · Distracciones | 2 · Lista blanca | Nuclear» (a guardian setting that
 * applies at once). The help line explains the hovered level, else the chosen one; choosing
 * Nuclear asks «¿Seguro?» in place first (PROMPT §10), and while it is the level the honest
 * note about administrators shows under the row.
 */
export function PunishmentRow(props: {
  view: AjustesView['study'];
  onChange(level: PunishmentLevel): void;
}): React.JSX.Element {
  const { view, onChange } = props;
  const nuclear = useArmed(NUCLEAR_ARM_ID);
  const levels = view.levels;
  const chosen = levels?.find((o) => o.value === view.level);
  return (
    <>
      <SettingsRow id="aj-punishment" title={A.study.level} description={view.levelDesc}>
        {null}
      </SettingsRow>
      {levels ? (
        <TileRow
          id={AJUSTES_IDS.rows.punishment}
          label={A.study.level}
          columns={3}
          kind="radiogroup"
          help={chosen?.help}
          helpLive="polite"
        >
          {levels.map((option) => {
            const guarded = option.value === 'nuclear' && view.level !== 'nuclear';
            return (
              <Tile
                key={option.value}
                id={option.value}
                label={option.label}
                help={option.help}
                tone={option.tone}
                mnemonic={option.mnemonic}
                size="text"
                selected={option.value === view.level}
                armed={guarded && nuclear.armed}
                armedHelp={A.study.nuclearConsequence}
                onPress={(info) => {
                  if (option.value === view.level) return;
                  if (guarded) nuclear.press(() => onChange('nuclear'), info);
                  else onChange(option.value);
                }}
                onMouseLeave={guarded ? nuclear.disarm : undefined}
                onBlur={guarded ? nuclear.disarm : undefined}
              />
            );
          })}
        </TileRow>
      ) : null}
      {view.nuclear ? <p className="aj-note">{A.study.adminNote}</p> : null}
    </>
  );
}
