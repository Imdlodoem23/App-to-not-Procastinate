/**
 * lucide-react glyphs of section 2 (PROMPT §10 «Iconos»: lucide only, stroke 1.75,
 * `currentColor`; every control also carries text). Services use their catalog monogram
 * instead (the catalog has no favicons yet).
 */
import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  BookOpen,
  Bookmark,
  Clapperboard,
  Clock,
  ClockPlus,
  Ellipsis,
  Flame,
  Gamepad2,
  Globe,
  GraduationCap,
  Lock,
  MessageCircle,
  Newspaper,
  NotebookPen,
  PencilLine,
  Plus,
  RotateCw,
  Shield,
  ShieldAlert,
  ShoppingBag,
  SquareTerminal,
  Timer,
  Users,
  Wrench,
} from 'lucide-react';
import type { CategoryId } from '@centrate/shared/catalog';
import type { BlockMode } from '@centrate/shared/domain';
import type { ChipKind } from './chips';

/** Section header icon («icono de candado»). */
export const SECTION_ICON: LucideIcon = Lock;

const TEMPLATE_ICONS: Readonly<Record<string, LucideIcon>> = {
  deberes: NotebookPen,
  examen: GraduationCap,
  leer: BookOpen,
};

export function templateIcon(templateId: string | null): LucideIcon {
  if (templateId === null) return Ellipsis;
  return TEMPLATE_ICONS[templateId] ?? Bookmark;
}

export const MODE_ICONS: Readonly<Record<BlockMode, LucideIcon>> = {
  normal: Shield,
  strict: ShieldAlert,
  hardcore: Flame,
  exam: GraduationCap,
};

const CATEGORY_ICONS: Readonly<Record<CategoryId, LucideIcon>> = {
  social: Users,
  video: Clapperboard,
  games: Gamepad2,
  messaging: MessageCircle,
  shopping: ShoppingBag,
  news: Newspaper,
};

/** Leading glyph of a chip that is not a service (services draw their monogram). */
export function chipIcon(kind: ChipKind, categoryId: CategoryId | null): LucideIcon | null {
  switch (kind) {
    case 'category':
      return categoryId ? CATEGORY_ICONS[categoryId] : Globe;
    case 'domain':
      return Globe;
    case 'app':
      return AppWindow;
    case 'process':
      return SquareTerminal;
    case 'whitelist':
      return GraduationCap;
    case 'duration':
      return Timer;
    case 'until':
      return Clock;
    case 'task':
      return BookOpen;
    case 'service':
    case 'more':
      return null;
  }
}

/** +15 min | +30 min | +1 h: «more time» (the label says how much). */
export const EXTEND_ICONS: Readonly<Record<string, LucideIcon>> = {
  '+15': ClockPlus,
  '+30': ClockPlus,
  '+60': ClockPlus,
  other: PencilLine,
  apply: Plus,
};

export const ACTION_ICONS = {
  repair: Wrench,
  retry: RotateCw,
} as const;
