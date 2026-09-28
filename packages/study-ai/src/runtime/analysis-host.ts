/**
 * [browser] Entry point of the hidden analysis window (owner: RUNTIME): validates
 * `AnalysisInbound` messages from main, runs one study or calibration session at a time and
 * posts `AnalysisOutbound` messages back. DESIGN.md §8.6.
 */
import type { AnalysisHost, AnalysisHostOptions } from '../types';
import { notImplemented } from '../util/not-implemented';

export function createAnalysisHost(_options: AnalysisHostOptions): AnalysisHost {
  return notImplemented('createAnalysisHost');
}
