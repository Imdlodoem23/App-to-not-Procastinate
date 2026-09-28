/**
 * Help texts of the tiles of one row. Each tile writes its current text (its help, its disabled
 * reason, or its «¿Seguro?» consequence) here after every render; the row's help line
 * subscribes, so it always shows the latest text of the tile under the mouse or focus, or of
 * the armed tile. Pure (no DOM, no React).
 */
import type { HelpTone } from './tones';

export interface RowHelpEntry {
  text: string | null;
  tone: HelpTone;
  armed: boolean;
}

export class RowHelpRegistry {
  private entries = new Map<string, RowHelpEntry>();
  private listeners = new Set<() => void>();
  private version = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  get(item: string): RowHelpEntry | undefined {
    return this.entries.get(item);
  }

  /** The armed tile of the row, if any (its consequence wins over hover). */
  armed(): RowHelpEntry | undefined {
    for (const entry of this.entries.values()) if (entry.armed) return entry;
    return undefined;
  }

  set(item: string, entry: RowHelpEntry): void {
    const current = this.entries.get(item);
    if (
      current &&
      current.text === entry.text &&
      current.tone === entry.tone &&
      current.armed === entry.armed
    ) {
      return;
    }
    this.entries.set(item, entry);
    this.emit();
  }

  delete(item: string): void {
    if (this.entries.delete(item)) this.emit();
  }

  private emit(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * What the row's help line shows: the armed tile's consequence, else the help of the active
 * (hovered or focused) tile, else the row's own help.
 */
export function rowHelpText(
  registry: Pick<RowHelpRegistry, 'get' | 'armed'>,
  activeItem: string | null,
  fallback: { text: string | null; tone: HelpTone },
): { text: string | null; tone: HelpTone } {
  const armed = registry.armed();
  if (armed?.text) return { text: armed.text, tone: armed.tone };
  const active = activeItem ? registry.get(activeItem) : undefined;
  if (active?.text) return { text: active.text, tone: active.tone };
  return fallback;
}
