/**
 * The window's one polite region (docs/DESKTOP.md §7.3 «live regions»): mounted empty with the
 * window and never unmounted, so screen readers already track it when a result arrives
 * («Guardado: centrate-eventos-2026-09-28.csv · 12 filas»). A repeated sentence speaks again
 * (`seq` re-creates the text node).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Announcement {
  text: string;
  seq: number;
}

export function useAnnouncer(): {
  announcement: Announcement | null;
  announce(text: string): void;
} {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const announce = useCallback((text: string) => {
    if (!mounted.current || text.trim() === '') return;
    setAnnouncement((last) => ({ text, seq: (last?.seq ?? 0) + 1 }));
  }, []);
  return { announcement, announce };
}

export function Announcer(props: { announcement: Announcement | null }): React.JSX.Element {
  const { announcement } = props;
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true" data-announcer="">
      {announcement ? <span key={announcement.seq}>{announcement.text}</span> : null}
    </div>
  );
}
