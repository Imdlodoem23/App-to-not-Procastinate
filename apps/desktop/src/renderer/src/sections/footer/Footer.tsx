/**
 * Section 5 «Pie»: the protection status line («● Guardián activo · ● Extensión conectada», or
 * «● Guardián detenido · Reparar»), the version on the right («Actualizar a vX» in blue when
 * there is one: it downloads, then installs), and equal 32 px secondary buttons filling the row:
 * Mini temporizador (with its flag; pressed while the mini timer shows) | Ajustes… | Salir, so
 * two buttons split the width while the flag is off. «Salir» explains that blocks stay active.
 * The buttons use the footer's 12 px (`footer.css`), so «Mini temporizador» fits a third of
 * the row. Outside `<main>`, so it is the window's `contentinfo` and never scrolls with the
 * sections.
 */
import { LogOut, Settings, Timer } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { StatusDot, TextButton, Tile, TileRow } from '../../components';
import { useRepair } from '../../hooks/useRepair';
import { RENDERER } from '../../i18n/messages';
import { useBridge, useSnapshot } from '../../store/context';
import { useUpdate } from './useUpdate';
import { deriveFooterView, type FooterButton } from './view';
import './footer.css';

const F = RENDERER.footer;

const ICONS = { miniTimer: Timer, settings: Settings, quit: LogOut } as const;

export function Footer(): React.JSX.Element {
  const snapshot = useSnapshot();
  const view = useMemo(() => deriveFooterView(snapshot), [snapshot]);
  const bridge = useBridge();
  const repair = useRepair();
  const update = useUpdate();
  // The help line reports the last thing pressed (a repair or an update).
  const [last, setLast] = useState<'repair' | 'update'>('repair');
  const message = last === 'update' ? update.message : repair.message;

  const press = (button: FooterButton): void => {
    if (button === 'settings') bridge.send('window:open-detail', { name: 'ajustes', group: null });
    else if (button === 'quit') bridge.send('app:quit', null);
    else bridge.send('mini-timer:toggle', { visible: null });
  };

  const runRepair = (): void => {
    setLast('repair');
    repair.run();
  };

  const statusItems = [
    <span key="guardian" className="footer-status-item">
      <StatusDot tone={view.guardian.tone} />
      {view.guardian.label}
    </span>,
  ];
  if (view.guardian.action) {
    statusItems.push(
      <TextButton key="repair" tone="blue" onPress={runRepair}>
        {repair.running
          ? RENDERER.protection.actions.repairing
          : view.guardian.action === 'install'
            ? F.install
            : F.repair}
      </TextButton>,
    );
  }
  if (view.extension) {
    statusItems.push(
      <span key="extension" className="footer-status-item">
        <StatusDot tone={view.extension.tone} />
        {view.extension.label}
      </span>,
    );
  }

  const { action } = view.version;
  const version = action ? (
    <TextButton
      tone="blue"
      className="footer-version"
      onPress={() => {
        setLast('update');
        update.run(action);
      }}
    >
      {view.version.label}
    </TextButton>
  ) : (
    <span className="footer-version" data-tone={view.version.update ? 'blue' : 'muted'}>
      {view.version.label}
    </span>
  );

  return (
    <footer
      className="main-footer"
      data-measure=""
      style={{ '--footer-cols': view.buttons.length } as React.CSSProperties}
    >
      <div className="footer-status">
        <div className="footer-status-items" data-fit="">
          {statusItems.map((item, index) => (
            <Fragment key={item.key}>
              {index > 0 ? (
                <span className="footer-separator" aria-hidden="true">
                  {F.separator}
                </span>
              ) : null}
              {item}
            </Fragment>
          ))}
        </div>
        {version}
      </div>
      <TileRow
        id="pie"
        label={F.rowLabel}
        columns={3}
        help={message?.text}
        helpTone={message?.tone ?? 'muted'}
        helpLive="polite"
      >
        {view.buttons.map((button) => (
          <Tile
            key={button}
            id={button}
            label={F.buttons[button]}
            icon={ICONS[button]}
            size="text"
            secondary
            door={button === 'settings'}
            selected={button === 'miniTimer' ? view.miniTimerVisible : undefined}
            help={F.help[button]}
            mnemonic={F.mnemonics[button]}
            onPress={() => press(button)}
          />
        ))}
      </TileRow>
    </footer>
  );
}
