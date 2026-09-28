/** English section headers of «Copiar diagnóstico» (same shape as `es.ts`). */
import type { DiagnosticsMessages } from './es';

export const DIAGNOSTICS_EN: DiagnosticsMessages = {
  title: 'Céntrate · diagnostics',
  generated: (iso: string): string => `generated: ${iso}`,
  summary: (json: string): string => `summary: ${json}`,
  guardian: '== guardian (/v1/diagnostics) ==',
  guardianDown: '== guardian: not responding ==',
  guardianLog: (lines: number): string => `== guardian.log (last ${lines} lines) ==`,
  appLog: (lines: number): string => `== app log (last ${lines} lines) ==`,
  empty: '(empty)',
  unavailable: '(not available)',
  noRealGuardian: (mode: string): string => `(${mode}: no real guardian)`,
};
