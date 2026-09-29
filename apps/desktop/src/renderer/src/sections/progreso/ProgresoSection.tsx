/**
 * Section 4 «Progreso»: the mascot in its phase as the header icon, «Nivel 7 · 1.240 puntos» ·
 * «Racha: 5 días», and the 4 px daily goal bar with «Hoy: 42 de 60 min». In «números rojos» the
 * title is red with the «Números rojos» pill. Its 40 px doors (Estadísticas… | Recompensas… |
 * Logros…) join with their feature flags and open their detail views; each has its Alt + letter
 * and its help on the row's help line. In compact density the goal row and that help line fold
 * away (progreso.css).
 */
import type { LucideIcon } from 'lucide-react';
import { ChartColumn, Gift, Trophy } from 'lucide-react';
import { useMemo } from 'react';
import { Bar, DoorTile, Pill, Section, TileRow } from '../../components';
import { mascotIcon } from '../../components/mascot';
import { RENDERER } from '../../i18n/messages';
import { useAppStore, useSnapshot } from '../../store/context';
import { PROGRESO_DOORS_ROW, deriveProgresoView, type ProgresoDoor } from './view';
import './progreso.css';

const G = RENDERER.progreso;
const DOOR_ICONS: Record<ProgresoDoor, LucideIcon> = {
  stats: ChartColumn,
  rewards: Gift,
  achievements: Trophy,
};

export function ProgresoSection(): React.JSX.Element | null {
  const snapshot = useSnapshot();
  const bridge = useAppStore((s) => s.bridge);
  const view = useMemo(() => deriveProgresoView(snapshot), [snapshot]);
  if (!view) return null;
  return (
    <Section
      id="progreso"
      icon={mascotIcon(view.phase)}
      title={view.title}
      titleTone={view.negative ? 'red' : 'default'}
      pill={view.pill ? <Pill tone="red">{view.pill}</Pill> : undefined}
      datum={view.streak}
    >
      <div className="progreso-goal">
        <Bar value={view.goal.value} height={4} tone="green" />
        <span className="progreso-goal-text" data-fit="">
          {view.goal.label}
        </span>
      </div>
      {view.doors.length > 0 ? (
        <TileRow
          id={PROGRESO_DOORS_ROW}
          label={G.doorsLabel}
          columns={3}
          className="progreso-doors"
        >
          {view.doors.map((door) => (
            <DoorTile
              key={door.id}
              id={door.id}
              label={door.label}
              icon={DOOR_ICONS[door.id]}
              size="door"
              help={door.help}
              mnemonic={door.mnemonic}
              onPress={() => bridge.send('window:open-detail', door.request)}
            />
          ))}
        </TileRow>
      ) : null}
    </Section>
  );
}
