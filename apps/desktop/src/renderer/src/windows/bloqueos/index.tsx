/**
 * The Bloqueos detail window (PROMPT §4 «Formulario avanzado», §9, §10 «Ventanas de detalle ›
 * Bloqueos»; docs/DESKTOP.md §7.7). Default export, no props: `DetailWindow` loads it lazily.
 *
 * Top: the advanced form in two columns, like G-Helper's «Fans + Power» (the brief's «en dos
 * columnas si hace falta»): «Qué bloquear» on the left (search, categories, custom domains,
 * apps), «Duración», «Modo» and «Tu motivo» on the right. Under both, pinned to the bottom of the
 * window while the form scrolls, «Guardar como plantilla | Bloquear…» with its help line;
 * «Bloquear…» hands the draft to the main window's confirmation card. Below: active blocks,
 * templates, schedules and exam mode.
 *
 * Opened seeded («con lo que sí entendió») it focuses what is missing: the duration row when the
 * phrase named what to block but not for how long, else the search; with `focus` it scrolls
 * there. One polite region, there from the start, announces results and the search count.
 * `data-loading` marks the root while the schedules are being fetched (the harness waits for it
 * to go before a screenshot).
 */
import { useLayoutEffect, useRef } from 'react';
import { useAppStore } from '../../store/context';
import { DurationSection, FormActions, ModeSection, ReasonSection } from './FormSections';
import { ActiveSection, ExamSection, SchedulesSection, TemplatesSection } from './ListSections';
import { TargetsSection } from './TargetsSection';
import { Announcer } from './announcer';
import { scrollToSection, useBloqueosWindow } from './useBloqueosWindow';
import { BLOQUEOS_IDS } from './view';
import './bloqueos.css';

const FOCUS_SECTIONS = {
  form: BLOQUEOS_IDS.targets,
  active: BLOQUEOS_IDS.active,
  templates: BLOQUEOS_IDS.templates,
  schedules: BLOQUEOS_IDS.schedules,
} as const;

/** The tab stop of the duration presets (no preset is checked while the duration is open). */
function presetTabStop(): HTMLElement | null {
  const tiles = document.querySelectorAll<HTMLElement>(
    `[data-row-tile="${BLOQUEOS_IDS.rows.presets}"]`,
  );
  return [...tiles].find((t) => t.tabIndex === 0) ?? tiles[0] ?? null;
}

export default function BloqueosWindow(): React.JSX.Element {
  const { view, local, notices, announcement, actions } = useBloqueosWindow();
  const loading = view.schedules.status === 'loading';
  const request = useAppStore((s) => (s.env.detail?.name === 'bloqueos' ? s.env.detail : null));

  // Read by the door effect below, which must run once per door (not when the user picks).
  const missing = useRef<'duration' | 'targets'>('targets');
  missing.current = view.duration.open && view.problem === 'no_duration' ? 'duration' : 'targets';

  // A door retargets the window: scroll to what it asked for; a seeded form focuses what is
  // missing (the duration row, else the search).
  useLayoutEffect(() => {
    if (!request) return;
    if (request.focus) scrollToSection(FOCUS_SECTIONS[request.focus]);
    if (request.seed && missing.current === 'duration') {
      presetTabStop()?.focus({ preventScroll: true });
    } else if (request.seed || request.focus === 'form') {
      document.getElementById(BLOQUEOS_IDS.search)?.focus({ preventScroll: true });
    }
  }, [request]);

  return (
    <div className="blq" data-loading={loading ? '' : undefined}>
      <div className="blq-form">
        <div className="blq-what">
          <TargetsSection
            view={view.targets}
            search={local.search}
            domainInput={local.domainInput}
            processInput={local.processInput}
            seedLine={view.seedLine}
            notices={{ domains: notices.domains, apps: notices.apps }}
            actions={actions}
          />
        </div>
        <div className="blq-how">
          <DurationSection view={view.duration} notice={notices.duration} actions={actions} />
          <ModeSection view={view.mode} actions={actions} />
          <ReasonSection
            reason={local.form.reason}
            naming={local.templateName !== null}
            actions={actions}
          />
        </div>
      </div>
      <FormActions
        templateName={local.templateName}
        problemText={view.problemText}
        notice={notices.actions}
        actions={actions}
      />
      <ActiveSection view={view.active} actions={actions} />
      <TemplatesSection view={view.templates} notice={notices.templates} actions={actions} />
      <SchedulesSection view={view.schedules} notice={notices.lists} actions={actions} />
      <ExamSection view={view.exam} actions={actions} />
      <Announcer announcement={announcement} />
    </div>
  );
}
