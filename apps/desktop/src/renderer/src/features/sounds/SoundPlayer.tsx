/**
 * The concentration-sound player (PROMPT §9), mounted once by the main window as its
 * `MainWindowFeature` (docs/DESKTOP.md §15.2): it renders nothing and plays what `desiredSound`
 * says, through the sound team's Web Audio loop player (`sounds/app-player.ts`: seamless,
 * band-limited loops at the context rate). The main window lives for the whole run and keeps
 * playing while hidden (an audible page is never throttled); its store has the snapshot, so a
 * choice made in Ajustes (the detail window) is heard here.
 *
 * Nothing happens until something should sound: no `AudioContext` and no `sounds:load` for
 * silence (`controller.ts`).
 */
import { useEffect, useRef, useState } from 'react';
import type { AmbientSound } from '../../../../shared/prefs';
import { snapshotFeature } from '../../../../shared/ui-state';
import { createAppLoopPlayer } from '../../sounds/app-player';
import { useAppStore } from '../../store/context';
import { createSoundController, type SoundController } from './controller';
import { desiredSound, manualAfterChange } from './cycle';

/**
 * Whether the user picked the current sound during this run: the choice changed after the first
 * snapshot (a harness load, `reset`, is not a pick). Adjusted during render, React's pattern for
 * state derived from a change.
 */
function useManualPick(ambient: AmbientSound, reset: string | null): boolean {
  const [seen, setSeen] = useState({ ambient, reset });
  const [manual, setManual] = useState(false);
  if (seen.ambient !== ambient || seen.reset !== reset) {
    setSeen({ ambient, reset });
    setManual(seen.reset === reset && manualAfterChange(seen.ambient, ambient, manual));
  }
  return manual;
}

export function SoundPlayer(): null {
  const bridge = useAppStore((s) => s.bridge);
  const enabled = useAppStore((s) => snapshotFeature(s.snapshot, 'sounds'));
  const ambient = useAppStore((s) => s.snapshot.prefs.sounds.ambient);
  const autoplay = useAppStore((s) => s.snapshot.prefs.sounds.autoplay);
  const volume = useAppStore((s) => s.snapshot.prefs.sounds.volume);
  const blockActive = useAppStore((s) => (s.snapshot.state?.blocks.length ?? 0) > 0);
  const studyActive = useAppStore((s) => s.snapshot.state?.study?.status === 'active');
  const harnessId = useAppStore((s) => s.snapshot.harness?.stateId ?? null);
  const manual = useManualPick(ambient, harnessId);

  const sound = desiredSound({
    enabled,
    prefs: { ambient, autoplay },
    blockActive,
    studyActive,
    manual,
    harness: harnessId !== null,
  });

  const controller = useRef<SoundController | null>(null);
  useEffect(
    () => () => {
      void controller.current?.dispose();
      controller.current = null;
    },
    [],
  );

  useEffect(() => {
    if (sound === null && controller.current === null) return;
    controller.current ??= createSoundController({
      load: (id) => bridge.invoke('sounds:load', { sound: id }),
      createPlayer: createAppLoopPlayer,
    });
    controller.current.apply({ sound, volume });
  }, [bridge, sound, volume]);

  return null;
}
