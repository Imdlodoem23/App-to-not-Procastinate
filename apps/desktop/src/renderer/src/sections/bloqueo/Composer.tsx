/**
 * «¿Qué quieres hacer?» (PROMPT §10, Bloqueo sin bloqueo): the 44 px field with its rotating
 * example, the line of what was understood under it, and the templates row
 * «Deberes 1 h | Examen 3 h | Leer 30 min | Más…».
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DoorTile, Field, Tile, TileRow } from '../../components';
import type { ChipView } from './chips';
import { ChipList } from './ChipList';
import { BLOQUEO } from './i18n';
import { templateIcon } from './icons';
import type { BloqueoActions, BloqueoRefs } from './useBloqueo';
import { BLOQUEO_FIELD_ID, BLOQUEO_ROWS, type ComposerView, type FieldLine } from './view';

const LINE_ID = 'bloqueo-field-line';
/** Typing pause after which screen readers hear what was understood. */
const UNDERSTOOD_DELAY_MS = 800;

/** `text` once it has stayed the same for `delayMs` ('' at once when it empties). */
function useSettled(text: string, delayMs: number): string {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    if (text === '') {
      setSettled('');
      return undefined;
    }
    const timer = setTimeout(() => setSettled(text), delayMs);
    return () => clearTimeout(timer);
  }, [text, delayMs]);
  return settled;
}

/** Enter in a text field of the section (not while an IME composes). */
export function isEnter(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === 'Enter' &&
    !event.nativeEvent.isComposing &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

/**
 * The first of `candidates` that fits the line next to its note, measured before paint in the
 * real font (like `useFitText`): all chips, then fewer targets behind «+N», then none.
 */
function useFitChips(
  candidates: readonly (readonly ChipView[])[],
  fitKey: string,
): { ref: React.RefObject<HTMLDivElement | null>; chips: readonly ChipView[] } {
  const key = `${fitKey}\u0000${candidates.map((list) => list.map((c) => c.label).join('\u0001')).join('\u0000')}`;
  const [fit, setFit] = useState({ key, index: 0 });
  const index = fit.key === key ? fit.index : 0;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const line = ref.current;
    if (!line || index >= candidates.length) return;
    const group = line.querySelector<HTMLElement>('.bq-chips');
    const overflows =
      line.scrollWidth > line.clientWidth + 1 ||
      (group !== null && group.scrollWidth > group.clientWidth + 1);
    if (overflows) setFit({ key, index: index + 1 });
  });

  return { ref, chips: candidates[index] ?? [] };
}

function ChipsLine(props: {
  line: Extract<FieldLine, { kind: 'chips' }>;
  actions: BloqueoActions;
}): React.JSX.Element {
  const { line, actions } = props;
  const fit = useFitChips(line.candidates, line.note?.text ?? '');
  return (
    <div id={LINE_ID} ref={fit.ref} className="bq-field-line" data-fit="">
      {fit.chips.length > 0 ? (
        <ChipList
          chips={fit.chips}
          line
          label={BLOQUEO.field.label}
          onPress={(chip) => {
            if (chip.span) actions.selectSpan(chip.span);
          }}
          pressable={(chip) => chip.span !== null}
        />
      ) : null}
      {line.note ? (
        <span className="bq-note" data-tone={line.note.tone}>
          {line.note.text}
        </span>
      ) : null}
    </div>
  );
}

function FieldLineView(props: { line: FieldLine; actions: BloqueoActions }): React.JSX.Element {
  const { line, actions } = props;
  if (line.kind === 'hint') {
    return (
      <div id={LINE_ID} className="bq-field-line" data-fit="">
        {line.text}
      </div>
    );
  }
  return <ChipsLine line={line} actions={actions} />;
}

export function Composer(props: {
  composer: ComposerView;
  actions: BloqueoActions;
  refs: BloqueoRefs;
}): React.JSX.Element {
  const { composer, actions, refs } = props;
  // The chips line only describes the field (read on focus); once typing pauses, a polite
  // region says what was understood or not («Entendido: YouTube, 1 h, hasta 18:00»).
  const understood = useSettled(
    composer.line.kind === 'chips' ? composer.line.announce : '',
    UNDERSTOOD_DELAY_MS,
  );
  return (
    <div className="bq-composer">
      <Field
        id={BLOQUEO_FIELD_ID}
        ref={refs.field}
        size="main"
        label={BLOQUEO.field.label}
        value={composer.value}
        placeholder={composer.placeholder}
        describedBy={LINE_ID}
        maxLength={500}
        onChange={actions.typeText}
        onKeyDown={(event) => {
          if (!isEnter(event)) return;
          event.preventDefault();
          actions.enter();
        }}
      />
      <FieldLineView line={composer.line} actions={actions} />
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {understood}
      </span>
      <TileRow
        id={BLOQUEO_ROWS.templates}
        label={BLOQUEO.templates.rowLabel}
        help={composer.templatesHelp}
      >
        {composer.templates.map((t) =>
          t.templateId !== null ? (
            <Tile
              key={t.id}
              id={t.id}
              label={t.label}
              icon={templateIcon(t.templateId)}
              help={t.help}
              mnemonic={t.mnemonic ?? undefined}
              onPress={() => {
                if (t.templateId !== null) actions.pressTemplate(t.templateId);
              }}
            />
          ) : (
            <DoorTile
              key={t.id}
              id={t.id}
              label={t.label}
              icon={templateIcon(null)}
              help={t.help}
              mnemonic={t.mnemonic ?? undefined}
              onPress={actions.openMore}
            />
          ),
        )}
      </TileRow>
    </div>
  );
}
