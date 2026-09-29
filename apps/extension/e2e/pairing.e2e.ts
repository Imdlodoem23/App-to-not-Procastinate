/**
 * Pairing (docs/ARCHITECTURE.md §9.3): the app shows a 6-digit code, the user types it in
 * the extension, the background claims a token bound to the extension origin and the
 * browser family, then long-polls the signed rules and sends heartbeats.
 */
import { DEFAULT_GUARDIAN_PORT } from '@centrate/shared/guardian-api';
import { MESSAGE_TYPES } from '../src/background/state';
import type { MockGuardian } from '../test/mock-guardian';
import { startMockGuardian } from '../test/mock-guardian';
import { EXTENSION_ORIGIN, expect, test } from './support/extension';

test('pairs from the popup with the code the app shows', async ({ extension }) => {
  // The popup pairs on the default port (47600) unless the user opens «Puerto: N».
  let guardian: MockGuardian;
  try {
    guardian = await startMockGuardian({ port: DEFAULT_GUARDIAN_PORT });
  } catch (error) {
    test.skip(
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE',
      `port ${DEFAULT_GUARDIAN_PORT} is taken (a real guardian is running?)`,
    );
    throw error;
  }
  try {
    const code = guardian.newPairingCode();
    const popup = await extension.openPopup();
    const field = popup.getByLabel(/código de emparejamiento/i);
    await field.fill(`${code.slice(0, 3)} ${code.slice(3)}`);
    await popup.getByRole('button', { name: 'Emparejar', exact: true }).click();

    await expect.poll(async () => (await extension.state()).paired).toBe(true);
    const [paired] = guardian.extensions();
    expect(paired?.boundOrigin).toBe(EXTENSION_ORIGIN);
    expect(paired?.browser).toBe('chromium');
    expect(guardian.pairingCode).toBeNull(); // single use

    await guardian.waitForApplied();
    await expect.poll(async () => (await extension.state()).link).toBe('connected');
    // The popup leaves the pairing form once paired.
    await expect(field).toBeHidden();
  } finally {
    await guardian.close();
  }
});

test('pairs through the background with a code and a port; a wrong code is refused', async ({
  extension,
  guardian,
}) => {
  const code = guardian.newPairingCode();
  const wrong = code === '000000' ? '000001' : '000000';
  const refused = await extension.send({
    type: MESSAGE_TYPES.pair,
    code: wrong,
    port: guardian.port,
  });
  expect(refused).toEqual({ ok: false, error: 'code_invalid', retryAfterSeconds: null });
  expect((await extension.state()).paired).toBe(false);

  const state = await extension.pair(guardian);
  expect(state.paired).toBe(true);
  expect(state.pairing?.port).toBe(guardian.port);

  const [paired] = guardian.extensions();
  expect(paired?.boundOrigin).toBe(EXTENSION_ORIGIN);
  const beat = await guardian.waitForHeartbeat();
  expect(beat.body).toMatchObject({
    browser: 'chromium',
    hostPermission: true,
    appliedExtRulesVersion: guardian.extRulesVersion,
  });

  // Every rules request carried a fresh nonce; the sync settles on a long poll.
  const rulesRequests = guardian.requests().filter((r) => r.path === '/v1/ext/rules');
  const nonces = rulesRequests.map((r) => r.query['nonce']);
  expect(new Set(nonces).size).toBe(nonces.length);
  await expect
    .poll(() =>
      guardian
        .requests()
        .some((r) => r.path === '/v1/ext/rules' && r.query['waitMs'] !== undefined),
    )
    .toBe(true);
  await expect.poll(async () => (await extension.state()).link).toBe('connected');
});
