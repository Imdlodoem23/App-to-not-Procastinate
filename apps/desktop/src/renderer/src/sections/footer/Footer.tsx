/**
 * Section 5 «Pie»: the protection status line («● Guardián activo · ● Extensión conectada», or
 * «● Guardián detenido · Reparar»), the version on the right («Actualizar a vX» in blue when
 * there is one), and three equal 32 px secondary buttons: Mini temporizador (with its flag) |
 * Ajustes… | Salir. «Salir» explains that blocks stay active. Outside `<main>`, so it is the
 * window's `contentinfo` and never scrolls with the sections.
 */
import { LogOut, Settings, Timer } from 'lucide-react';
import { Fragment, useMemo } from 'react';
import { StatusDot, TextButton, Tile, TileRow } from '../../components';
import { useRepair } from '../../hooks/useRepair';
import { RENDERER_ES } from '../../i18n/es';
import { useBridge, useSnapshot } from '../../store/context';
import { deriveFooterView, type FooterButton } from './view';

const F = RENDERER_ES.footer;

const ICONS = { miniTimer: Timer, settings: Settings, quit: LogOut } as const;

export function Footer(): React.JSX.Element {
  const snapshot = useSnapshot();
  const view = useMemo(() => deriveFooterView(snapshot), [snapshot]);
  const bridge = useBridge();
  const repair = useRepair();

  const press = (button: FooterButton): void => {
    if (button === 'settings') bridge.send('window:open-detail', { name: 'ajustes', group: null });
    else if (button === 'quit') bridge.send('app:quit', null);
    // Mini temporizador: its window comes with the `miniTimer` flag.
  };

  const statusItems = [
    <span key="guardian" className="footer-status-item">
      <StatusDot tone={view.guardian.tone} />
      {view.guardian.label}
    </span>,
  ];
  if (view.guardian.action) {
    statusItems.push(
      <TextButton key="repair" tone="blue" onPress={repair.run}>
        {repair.running
          ? RENDERER_ES.protection.actions.repairing
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

  return (
    <footer className="main-footer" data-measure="">
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
        <span className="footer-version" data-tone={view.version.update ? 'blue' : 'muted'}>
          {view.version.label}
        </span>
      </div>
      <TileRow
        id="pie"
        label={F.rowLabel}
        columns={3}
        help={repair.message?.text}
        helpTone={repair.message?.tone ?? 'muted'}
        helpLive="polite"
      >
        {Array.from({ length: Math.max(0, 3 - view.buttons.length) }, (_, i) => (
          <span key={`spacer-${i}`} className="footer-spacer" aria-hidden="true" />
        ))}
        {view.buttons.map((button) => (
          <Tile
            key={button}
            id={button}
            label={F.buttons[button]}
            icon={ICONS[button]}
            size="text"
            secondary
            door={button === 'settings'}
            help={F.help[button]}
            mnemonic={F.mnemonics[button]}
            onPress={() => press(button)}
          />
        ))}
      </TileRow>
    </footer>
  );
}
