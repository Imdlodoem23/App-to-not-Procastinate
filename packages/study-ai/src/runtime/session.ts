/**
 * [browser] Study session facade (owner: RUNTIME): camera + vision + classifier + engine +
 * loop + governor, or the no-camera observer; emits events at once and a report at 1 Hz.
 * Every dependency is injectable (`deps`) so tests run it in Node. DESIGN.md §8.3–8.5.
 */
import type { StudySessionHandle, StudySessionOptions } from '../types';
import { notImplemented } from '../util/not-implemented';

export function startStudySession(_options: StudySessionOptions): Promise<StudySessionHandle> {
  return notImplemented('startStudySession');
}
