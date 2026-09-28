/**
 * «Sonido: Lluvia» (PROMPT §10, Study Mode's session tiles): each click moves the choice to the
 * next of Nada → Lluvia → Ruido blanco → Lo-fi (`prefs:set`, applied at once; the main window's
 * player follows the snapshot). For the Study Mode wave and Ajustes; nothing mounts it while the
 * `study` flag is off. The label says what sounds, the help what the next click plays.
 */
import { Music } from 'lucide-react';
import { useCallback } from 'react';
import { Tile, type TileSize } from '../../components';
import { useAppStore } from '../../store/context';
import { nextAmbient, soundTileHelp, soundTileLabel } from './cycle';

/** One step of the cycle: `prefs:set { sounds: { ambient } }` from the current choice. */
export function useCycleSound(): () => void {
  const bridge = useAppStore((s) => s.bridge);
  const ambient = useAppStore((s) => s.snapshot.prefs.sounds.ambient);
  return useCallback(() => {
    void bridge.invoke('prefs:set', { sounds: { ambient: nextAmbient(ambient) } });
  }, [bridge, ambient]);
}

export function SoundTile(props: {
  id?: string;
  mnemonic?: string;
  size?: TileSize;
  describedBy?: string;
}): React.JSX.Element {
  const ambient = useAppStore((s) => s.snapshot.prefs.sounds.ambient);
  const cycle = useCycleSound();
  return (
    <Tile
      id={props.id ?? 'sound'}
      label={soundTileLabel(ambient)}
      icon={Music}
      size={props.size ?? 'regular'}
      mnemonic={props.mnemonic}
      help={soundTileHelp(ambient)}
      describedBy={props.describedBy}
      onPress={cycle}
    />
  );
}
