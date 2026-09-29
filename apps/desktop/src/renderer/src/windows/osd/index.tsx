/**
 * The OSD window (PROMPT §10 «Aviso grande (OSD)», G-Helper's `ToastForm`): a transparent,
 * click-through window that never takes focus (PLATFORM), centred 300 DIP above the bottom of
 * the work area. It draws one pill: black at 60 % in both themes, 8 px corners, white 28 px
 * text at 600 and, on its left, the 20 px icon in the notice's accent (the pill is always dark,
 * so the accents are the dark theme's). Each notice fades in over 120 ms (nothing moves with
 * reduced motion); main hides the window after 2 s.
 *
 * The text is a polite status for assistive technology; the icon is decorative (the text always
 * says what happened).
 */
import type { LucideIcon } from 'lucide-react';
import { BookOpen, Check, ClockPlus, Coffee, Lock, Timer, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import type { OsdIcon } from '../../../../shared/platform';
import { Icon } from '../../components';
import { useAppStore } from '../../store/context';
import { OSD } from './i18n';
import { deriveOsdView } from './view';
import './osd.css';

const ICONS: Readonly<Record<OsdIcon, LucideIcon>> = {
  extend: ClockPlus,
  block: Lock,
  timer: Timer,
  check: Check,
  warning: TriangleAlert,
  study: BookOpen,
  awake: Coffee,
};

export default function OsdWindow(): React.JSX.Element {
  const osd = useAppStore((s) => s.snapshot.osd);
  const view = useMemo(() => deriveOsdView({ osd }), [osd]);

  return (
    <main className="osd" aria-labelledby="osd-title">
      <h1 id="osd-title" className="sr-only">
        {OSD.title}
      </h1>
      <div className="osd-live" role="status" aria-live="polite" aria-atomic="true">
        {view ? (
          <div key={view.id} className="osd-pill" data-theme="dark">
            <span className="osd-icon" data-accent={view.tone}>
              <Icon icon={ICONS[view.icon]} size="tile" />
            </span>
            <span className="osd-text" data-fit="">
              {view.text}
            </span>
          </div>
        ) : null}
      </div>
    </main>
  );
}
