/**
 * Section 1 «Aviso de protección»: only when something fails. A red or orange header with the
 * problem as its title and one row of text tiles with what to do («Reparar | Detalles…»,
 * «Instalar…»). A polite live region announces it when it appears (it is always in the DOM,
 * so the announcement is not lost when the section mounts).
 */
import { ShieldOff, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Section, Tile, TileRow } from '../../components';
import { useRepair } from '../../hooks/useRepair';
import { RENDERER } from '../../i18n/messages';
import { useBridge, useSnapshot } from '../../store/context';
import { deriveProtectionView, type ProtectionAction } from './view';

const P = RENDERER.protection;

export function ProtectionWarning(): React.JSX.Element {
  const snapshot = useSnapshot();
  const view = useMemo(() => deriveProtectionView(snapshot), [snapshot]);
  const bridge = useBridge();
  const repair = useRepair();

  const press = (action: ProtectionAction): void => {
    switch (action.id) {
      case 'repair':
      case 'install-guardian':
        repair.run();
        return;
      case 'details':
        bridge.send('window:open-detail', { name: 'ajustes', group: 'sistema' });
        return;
      case 'guide':
        if (action.guide) bridge.send('app:open-guide', { guide: action.guide });
        return;
    }
  };

  const mnemonic = (action: ProtectionAction): string =>
    action.id === 'details'
      ? P.mnemonics.details
      : action.id === 'repair'
        ? P.mnemonics.repair
        : P.mnemonics.install;

  return (
    <>
      {view ? (
        <Section
          id="proteccion"
          icon={view.tone === 'red' ? ShieldOff : TriangleAlert}
          title={view.title}
          titleTone={view.tone}
          wrap
        >
          <TileRow
            id="proteccion-acciones"
            label={P.rowLabel}
            columns={4}
            help={repair.message?.text}
            helpTone={repair.message?.tone ?? 'muted'}
            helpLive="polite"
          >
            {view.actions.map((action) => {
              const repairing =
                repair.running && (action.id === 'repair' || action.id === 'install-guardian');
              return (
                <Tile
                  key={action.id}
                  id={action.id}
                  label={repairing ? P.actions.repairing : action.label}
                  door={action.door && !repairing}
                  size="text"
                  help={action.help}
                  mnemonic={mnemonic(action)}
                  disabled={repairing}
                  disabledReason={P.actions.repairing}
                  onPress={() => press(action)}
                />
              );
            })}
          </TileRow>
        </Section>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {view?.title ?? ''}
      </div>
    </>
  );
}
