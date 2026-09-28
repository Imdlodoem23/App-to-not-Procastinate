/**
 * Spanish section headers of «Copiar diagnóstico» (`../diagnostics.ts`). The data under them
 * (JSON, log lines, `centrate-guardian status`) is never translated.
 */
import type { Widen } from '../../../shared/i18n/locale';

export const DIAGNOSTICS_ES = {
  title: 'Céntrate · diagnóstico',
  generated: (iso: string): string => `generado: ${iso}`,
  summary: (json: string): string => `resumen: ${json}`,
  guardian: '== guardián (/v1/diagnostics) ==',
  guardianDown: '== guardián: sin respuesta ==',
  guardianLog: (lines: number): string => `== guardian.log (últimas ${lines} líneas) ==`,
  appLog: (lines: number): string => `== registro de la app (últimas ${lines} líneas) ==`,
  empty: '(vacío)',
  unavailable: '(no disponible)',
  /** `guardianStatus` without a real guardian (mock or harness): «(mock: sin guardián real)». */
  noRealGuardian: (mode: string): string => `(${mode}: sin guardián real)`,
} as const;

/** Shape every diagnostics language file must match. */
export type DiagnosticsMessages = Widen<typeof DIAGNOSTICS_ES>;
