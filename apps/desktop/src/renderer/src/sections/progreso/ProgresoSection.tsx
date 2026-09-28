/**
 * Section 4 «Progreso»: the mascot as the header icon, «Nivel 7 · 1.240 puntos» · «Racha: 5
 * días», and the 4 px daily goal bar with «Hoy: 42 de 60 min». In «números rojos» the title is
 * red with the «Números rojos» pill. Its doors (Estadísticas… | Recompensas… | Logros…) join
 * with their feature flags; Phase 1 shows the header and the goal bar only.
 */
import type { LucideIcon } from 'lucide-react';
import { ChartColumn, Gift, Leaf, Shrub, Sprout, TreeDeciduous, Trophy } from 'lucide-react';
import { useMemo } from 'react';
import { Bar, DoorTile, Pill, Section, TileRow } from '../../components';
import { RENDERER_ES } from '../../i18n/es';
import { useSnapshot } from '../../store/context';
import { deriveProgresoView, type MascotPhase, type ProgresoDoor } from './view';

const G = RENDERER_ES.progreso;
const DOOR_ICONS: Record<ProgresoDoor, LucideIcon> = {
  stats: ChartColumn,
  rewards: Gift,
  achievements: Trophy,
};

/** Placeholder glyphs of the mascot's phases (lucide; the real mascot comes with `rewards`). */
const MASCOT_ICONS: Record<MascotPhase, LucideIcon> = {
  sprout: Sprout,
  plant: Shrub,
  tree: TreeDeciduous,
  wilted: Leaf,
};

export function ProgresoSection(): React.JSX.Element | null {
  const snapshot = useSnapshot();
  const view = useMemo(() => deriveProgresoView(snapshot), [snapshot]);
  if (!view) return null;
  return (
    <Section
      id="progreso"
      icon={MASCOT_ICONS[view.phase]}
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
        // Their windows join with the same flags (stats, rewards, achievements).
        <TileRow id="progreso-puertas" label={G.doorsLabel} columns={3}>
          {view.doors.map((door) => (
            <DoorTile
              key={door}
              id={door}
              label={G.doors[door]}
              icon={DOOR_ICONS[door]}
              size="door"
              help={G.doorsHelp[door]}
            />
          ))}
        </TileRow>
      ) : null}
    </Section>
  );
}
