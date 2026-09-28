/**
 * «Confirmación en el sitio» (PROMPT §10), for redeeming a reward, ending Study Mode early,
 * turning Nuclear on and the last step of the emergency unlock: the first press turns the label
 * into «¿Seguro? …» with a red outline and puts the consequence on the help line; a second press
 * within 3 s applies; Esc, the mouse or the focus leaving disarm it. Never chained modals.
 */
import type { TileProps } from './Tile';
import { Tile } from './Tile';
import { useArmed } from '../hooks/useArmed';

export interface InPlaceConfirmProps extends Omit<
  TileProps,
  'armed' | 'armedHelp' | 'onPress' | 'selected' | 'door'
> {
  /** Stable id of the armed control (`emergency-unlock`, `delete-data`…), fixture-settable. */
  armId: string;
  /** Shown in red on the help line while armed («Perderás 620 puntos y tu racha de 5 días»). */
  consequence: string;
  onConfirm(): void;
}

export function InPlaceConfirm(props: InPlaceConfirmProps): React.JSX.Element {
  const { armId, consequence, onConfirm, ...tile } = props;
  const armed = useArmed(armId);
  return (
    <Tile
      {...tile}
      armed={armed.armed}
      armedHelp={consequence}
      onPress={(info) => armed.press(onConfirm, info)}
      onMouseLeave={() => {
        armed.disarm();
        tile.onMouseLeave?.();
      }}
      onBlur={() => {
        armed.disarm();
        tile.onBlur?.();
      }}
    />
  );
}
