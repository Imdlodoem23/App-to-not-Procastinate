/**
 * «¿Qué quieres hacer?» (PROMPT §10, Bloqueo sin bloqueo): the 44 px field with its rotating
 * example, the line of what was understood under it, and the templates row
 * «Deberes 1 h | Examen 3 h | Leer 30 min | Más…».
 */
import type { KeyboardEvent } from 'react';
import { DoorTile, Field, Tile, TileRow } from '../../components';
import { ChipList } from './ChipList';
import { BLOQUEO_ES } from './i18n/es';
import { templateIcon } from './icons';
import type { BloqueoActions, BloqueoRefs } from './useBloqueo';
import { BLOQUEO_FIELD_ID, BLOQUEO_ROWS, type ComposerView, type FieldLine } from './view';

const LINE_ID = 'bloqueo-field-line';

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

function FieldLineView(props: { line: FieldLine; actions: BloqueoActions }): React.JSX.Element {
  const { line, actions } = props;
  if (line.kind === 'hint') {
    return (
      <div id={LINE_ID} className="bq-field-line" data-fit="">
        {line.text}
      </div>
    );
  }
  return (
    <div id={LINE_ID} className="bq-field-line" data-fit="">
      {line.chips.length > 0 ? (
        <ChipList
          chips={line.chips}
          line
          label={BLOQUEO_ES.field.label}
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

export function Composer(props: {
  composer: ComposerView;
  actions: BloqueoActions;
  refs: BloqueoRefs;
}): React.JSX.Element {
  const { composer, actions, refs } = props;
  return (
    <div className="bq-composer">
      <Field
        id={BLOQUEO_FIELD_ID}
        ref={refs.field}
        size="main"
        label={BLOQUEO_ES.field.label}
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
      <TileRow
        id={BLOQUEO_ROWS.templates}
        label={BLOQUEO_ES.templates.rowLabel}
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
