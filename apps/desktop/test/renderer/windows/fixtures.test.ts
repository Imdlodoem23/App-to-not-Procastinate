import { describe, expect, it } from 'vitest';
import {
  HARNESS_NOW,
  HARNESS_STATE_IDS,
  fixtureUiState,
  harnessFixture,
} from '../../../src/shared/fixtures';
import { deriveAjustesView } from '../../../src/renderer/src/windows/ajustes/view';
import { deriveBloqueosView } from '../../../src/renderer/src/windows/bloqueos/view';
import { deriveEmergenciaView } from '../../../src/renderer/src/windows/emergencia/view';

describe('detail windows render every harness state', () => {
  it.each(HARNESS_STATE_IDS)('%s', (id) => {
    const fixture = harnessFixture(id);
    const state = fixtureUiState(fixture, 'detail');
    const bloqueos = deriveBloqueosView(state, HARNESS_NOW, {
      schedules: { status: 'ready', list: fixture.fake.schedules },
      pendingSchedules: {},
      processNames: fixture.fake.processNames,
    });
    expect(bloqueos.targets.title).toMatch(/^Qué bloquear: /);
    expect(bloqueos.active.rows).toHaveLength(fixture.snapshot.state?.blocks.length ?? 0);

    const emergencia = deriveEmergenciaView(state, HARNESS_NOW, fixture.fake.emergencyPreview);
    expect(emergencia.title).toMatch(/^Emergencia: /);
    // The phrase only exists while asking; Hardcore and Examen never offer a way out.
    expect(emergencia.phrase === null).toBe(emergencia.stage !== 'request');
    if (fixture.snapshot.state?.blocks.every((b) => b.mode === 'hardcore' || b.mode === 'exam')) {
      expect(emergencia.request).toBeNull();
    }

    const ajustes = deriveAjustesView(state, HARNESS_NOW);
    expect(ajustes.sistema.title).toMatch(/^Sistema: /);
    expect(ajustes.sistema.guardian.repair === null).toBe(
      ajustes.sistema.guardian.tone === 'green' || ajustes.sistema.guardian.tone === 'neutral',
    );
  });
});
