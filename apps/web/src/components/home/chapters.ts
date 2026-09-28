/**
 * The three chapters of the home page (Bloqueo, Study Mode, Progreso; design plan § 4.6): what
 * each gallery card shows next to its copy. Texts come from copy.ts; this file only picks the
 * visual of every card, in the same order as `copy.chapters.<chapter>.cards`.
 *
 * A visual is either the AppWindow mock in one of its states, or a small composition made of
 * app pieces (tiles, bars, dots, line icons) drawn by CardVisual.astro. Compositions carry no
 * hand-written words: only strings from copy.ts, names from the catalog of @centrate/shared and
 * numbers from its points rules.
 */
import { copy, type AppWindowState, type FootnoteId } from '../../content/copy';

export type AppWindowPart = 'block' | 'study' | 'progress' | 'footer';

export type CompositionKind =
  | 'services'
  | 'emergency'
  | 'calibration'
  | 'learn'
  | 'punishment'
  | 'no-camera'
  | 'rewards'
  | 'streak'
  | 'pet'
  | 'ledger';

export type CardVisualSpec =
  | {
      kind: 'window';
      state: AppWindowState;
      /** Crop to these sections of the window. */
      parts?: readonly AppWindowPart[];
      /** Title bar (only when the crop starts at the top of the window). */
      chrome?: boolean;
    }
  | { kind: CompositionKind };

export interface FootnoteMark {
  id: FootnoteId;
  /** Occurrence of this note's reference on the page (see FootnoteRef.astro). */
  k: number;
}

export interface ChapterCard {
  title: string;
  text: string;
  note?: FootnoteMark;
  visual: CardVisualSpec;
}

export interface ChapterData {
  id: string;
  eyebrow: string;
  headline: string;
  lead: string;
  leadNote?: FootnoteMark;
  cards: ChapterCard[];
}

/**
 * Which reference of each note the chapters render (the first ones of `admin`, `attempts` and
 * `webcam` are in «Lo más destacado», before the chapters).
 */
const OCCURRENCE: Partial<Record<FootnoteId, number>> = {
  webcam: 2,
  emergency: 1,
  punishment: 1,
  rewards: 1,
};

const mark = (id: FootnoteId | undefined): FootnoteMark | undefined =>
  id && { id, k: OCCURRENCE[id] ?? 1 };

const compose = (kind: CompositionKind): CardVisualSpec => ({ kind });

/**
 * Windows are shown whole, title bar to footer: at the card zoom not even the tallest state
 * reaches the card's bottom edge, so a crop would end on an empty edge. Whole, the window floats
 * in the card like the compositions (CardVisual.astro).
 */
const whole = (state: AppWindowState): CardVisualSpec => ({ kind: 'window', state, chrome: true });

/** Visual of each card, in the order of copy.ts. */
const visuals = {
  block: [
    whole('typing'),
    whole('confirm'),
    compose('services'),
    whole('countdown'),
    compose('emergency'),
  ],
  study: [
    compose('calibration'),
    whole('study'),
    compose('learn'),
    compose('punishment'),
    compose('no-camera'),
  ],
  progress: [
    whole('progress'),
    compose('rewards'),
    compose('streak'),
    compose('pet'),
    compose('ledger'),
  ],
} as const satisfies Record<keyof typeof copy.chapters, readonly CardVisualSpec[]>;

function visualAt(list: readonly CardVisualSpec[], i: number, id: string): CardVisualSpec {
  const visual = list[i];
  if (!visual) throw new Error(`chapters.ts: card ${i + 1} of «${id}» has no visual`);
  return visual;
}

type ChapterCopy = (typeof copy.chapters)[keyof typeof copy.chapters];

function build(chapter: ChapterCopy, cardVisuals: readonly CardVisualSpec[]): ChapterData {
  return {
    id: chapter.id,
    eyebrow: chapter.eyebrow,
    headline: chapter.headline,
    lead: chapter.lead,
    leadNote: mark('leadNote' in chapter ? chapter.leadNote : undefined),
    cards: chapter.cards.map((card, i) => ({
      title: card.title,
      text: card.text,
      note: mark('note' in card ? card.note : undefined),
      visual: visualAt(cardVisuals, i, chapter.id),
    })),
  };
}

export const chapters: readonly ChapterData[] = [
  build(copy.chapters.block, visuals.block),
  build(copy.chapters.study, visuals.study),
  build(copy.chapters.progress, visuals.progress),
];
