/**
 * Section 5 «Pie»: the protection status line («● Guardián activo · ● Extensión conectada», or
 * «● Guardián detenido · Reparar»), the version on the right («Actualizar a vX» in blue when
 * there is one: it downloads, then installs), and equal 32 px secondary buttons filling the row:
 * Mini temporizador (with its flag; pressed while the mini timer shows) | Ajustes… | Salir, so
 * two buttons split the width while the flag is off. «Salir» explains that blocks stay active.
 * The buttons use the footer's 12 px (`footer.css`), so «Mini temporizador» fits a third of
 * the row. Outside `<main>`, so it is the window's `contentinfo` and never scrolls with the
 * sections.
 *
 * While «Mantener despierto» is on, «Despierto · hasta las 18:30» takes the version's place (no extra
 * height): pressing it (click, Enter or Space) asks main for the tray's «Mantener despierto»
 * choices as a native menu under it (`keep-awake:menu`), which the keyboard walks like any menu.
 * When the guardian cannot hold it, the help line under the buttons says why, in orange; when a
 * choice from that menu or the tray is refused and «Avisos grandes» is off, main sends
 * `ui:command keep-awake-failed` and the same line says «No se ha podido cambiar «Mantener
 * despierto»» until the keep-awake state changes or another footer action reports.
 */
import { Coffee, LogOut, Settings, Timer } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, StatusDot, TextButton, Tile, TileRow } from '../../components';
import { useRepair } from '../../hooks/useRepair';
import { RENDERER } from '../../i18n/messages';
import { useBridge, useSnapshot } from '../../store/context';
import { FOOTER } from './i18n';
import { useUpdate } from './useUpdate';
import { deriveFooterView, type FooterButton } from './view';
import './footer.css';

const F = RENDERER.footer;

const ICONS = { miniTimer: Timer, settings: Settings, quit: LogOut } as const;

/** The chip's description (what pressing it does), read with its name. */
const AWAKE_HELP_ID = 'footer-awake-help';

export function Footer(): React.JSX.Element {
  const snapshot = useSnapshot();
  const view = useMemo(() => deriveFooterView(snapshot), [snapshot]);
  const bridge = useBridge();
  const repair = useRepair();
  const update = useUpdate();
  // The help line reports the last thing that happened (a repair, an update, or a refused
  // «Mantener despierto» choice).
  const [last, setLast] = useState<'repair' | 'update' | 'awake'>('repair');
  const [awakeFailedFor, setAwakeFailedFor] = useState<string | null>(null);
  const awakeKey = JSON.stringify(snapshot.state?.keepAwake ?? null);
  const awakeFailed = last === 'awake' && awakeFailedFor === awakeKey;
  const message: { text: string; tone: 'muted' | 'red' | 'orange' } | null =
    last === 'update'
      ? update.message
      : last === 'awake'
        ? awakeFailed
          ? { text: FOOTER.awake.failed, tone: 'orange' }
          : null
        : repair.message;
  const awakeRef = useRef<HTMLButtonElement>(null);
  const awakeKeyRef = useRef(awakeKey);
  useEffect(() => {
    awakeKeyRef.current = awakeKey;
  }, [awakeKey]);

  // A refused choice (tray or chip menu, «Avisos grandes» off): shown until the state changes.
  useEffect(
    () =>
      bridge.on('ui:command', (command) => {
        if (command.type !== 'keep-awake-failed') return;
        setAwakeFailedFor(awakeKeyRef.current);
        setLast('awake');
      }),
    [bridge],
  );

  // The native menu opens under the chip's left edge (CSS px of this window).
  const openAwakeMenu = (): void => {
    const rect = awakeRef.current?.getBoundingClientRect();
    bridge.send('keep-awake:menu', {
      x: Math.max(0, Math.round(rect?.left ?? 0)),
      y: Math.max(0, Math.round(rect?.bottom ?? 0)),
    });
  };

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
  const awake = view.awake;
  const version = awake ? (
    <>
      <TextButton
        ref={awakeRef}
        tone={awake.tone}
        className="footer-version footer-awake-chip"
        describedBy={AWAKE_HELP_ID}
        hasPopup="menu"
        onPress={openAwakeMenu}
      >
        <Icon icon={Coffee} />
        <span className="footer-awake-label">{awake.label}</span>
      </TextButton>
      <span id={AWAKE_HELP_ID} className="sr-only">
        {awake.trouble ? `${awake.trouble}. ${FOOTER.awake.help}` : FOOTER.awake.help}
      </span>
    </>
  ) : action ? (
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
        help={message?.text ?? awake?.trouble ?? undefined}
        helpTone={message?.tone ?? (awake?.trouble ? 'orange' : 'muted')}
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
