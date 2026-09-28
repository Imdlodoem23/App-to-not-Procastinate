/**
 * The Bloqueos detail window (PROMPT §4 «Formulario avanzado», §9, §10 «Ventanas de detalle ›
 * Bloqueos»; docs/DESKTOP.md §7.7). Default export, no props: `DetailWindow` loads it lazily.
 *
 * Top: the advanced form, one section per decision («Qué bloquear», «Duración», «Modo», «Tu
 * motivo») ending in «Guardar como plantilla | Bloquear…»; «Bloquear…» hands the draft to the
 * main window's confirmation card. Below: active blocks, templates, schedules and exam mode.
 * Opened seeded («con lo que sí entendió») it focuses the search; with `focus` it scrolls there.
 * `data-loading` marks the root while the schedules are being fetched (the harness waits for it
 * to go before a screenshot).
 */
import { useLayoutEffect } from 'react';
import { useAppStore } from '../../store/context';
import { DurationSection, ModeSection, ReasonSection } from './FormSections';
import { ActiveSection, ExamSection, SchedulesSection, TemplatesSection } from './ListSections';
import { TargetsSection } from './TargetsSection';
import { scrollToSection, useBloqueosWindow } from './useBloqueosWindow';
import { BLOQUEOS_IDS } from './view';
import './bloqueos.css';

const FOCUS_SECTIONS = {
  form: BLOQUEOS_IDS.targets,
  active: BLOQUEOS_IDS.active,
  templates: BLOQUEOS_IDS.templates,
  schedules: BLOQUEOS_IDS.schedules,
} as const;

export default function BloqueosWindow(): React.JSX.Element {
  const { view, local, notices, actions } = useBloqueosWindow();
  const loading = view.schedules.status === 'loading';
  const request = useAppStore((s) => (s.env.detail?.name === 'bloqueos' ? s.env.detail : null));

  // A door retargets the window: scroll to what it asked for; a seeded form takes the focus.
  useLayoutEffect(() => {
    if (!request) return;
    if (request.focus) scrollToSection(FOCUS_SECTIONS[request.focus]);
    if (request.seed || request.focus === 'form') {
      document.getElementById(BLOQUEOS_IDS.search)?.focus({ preventScroll: true });
    }
  }, [request]);

  return (
    <div className="blq" data-loading={loading ? '' : undefined}>
      <TargetsSection
        view={view.targets}
        search={local.search}
        domainInput={local.domainInput}
        processInput={local.processInput}
        seedLine={view.seedLine}
        notices={{ domains: notices.domains, apps: notices.apps }}
        actions={actions}
      />
      <DurationSection view={view.duration} notice={notices.duration} actions={actions} />
      <ModeSection view={view.mode} actions={actions} />
      <ReasonSection
        reason={local.form.reason}
        templateName={local.templateName}
        problemText={view.problemText}
        notice={notices.actions}
        actions={actions}
      />
      <ActiveSection view={view.active} actions={actions} />
      <TemplatesSection view={view.templates} notice={notices.templates} actions={actions} />
      <SchedulesSection view={view.schedules} notice={notices.lists} actions={actions} />
      <ExamSection view={view.exam} actions={actions} />
    </div>
  );
}
