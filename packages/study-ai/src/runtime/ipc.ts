/**
 * Strict guards for the main ↔ analysis-window messages (owner: RUNTIME). Pure.
 * DESIGN.md §8.6.
 */
import type { AnalysisInbound, AnalysisOutbound } from '../types';
import { notImplemented } from '../util/not-implemented';

export function isAnalysisInbound(_value: unknown): _value is AnalysisInbound {
  return notImplemented('isAnalysisInbound');
}

export function isAnalysisOutbound(_value: unknown): _value is AnalysisOutbound {
  return notImplemented('isAnalysisOutbound');
}
