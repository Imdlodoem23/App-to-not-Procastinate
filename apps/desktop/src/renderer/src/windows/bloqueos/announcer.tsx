/**
 * One polite region per detail window (docs/DESKTOP.md §7.3 «live regions»): mounted empty with
 * the window and never unmounted, so screen readers already track it when a result arrives; only
 * its text changes. Results that show in help lines mounted with their text already in them
 * (a notice under a list, a new stage of the emergency) are carried here instead. A repeated
 * sentence speaks again (`seq` re-creates the text node).
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
