/**
 * One valid payload per Phase 5 channel (docs/DESKTOP.md §15), shared by the contract's tests
 * and the main-process guard tests (`test/main/ipc`, `test/main/windows`).
 */
import { emptyAllow, emptyTargets } from '@centrate/shared/guardian-api';
import type { Phase5InvokeChannel, Phase5SendChannel } from '../../src/shared/ipc';
import { harnessFixture } from '../../src/shared/fixtures';

const SCH = 'sch_fixture0000000001';

export const SCHEDULE_INPUT = {
  name: 'Tardes sin redes',
  enabled: true,
  days: [1, 2, 3, 4, 5],
  start: '16:00',
  end: '19:00',
  timezone: 'Europe/Madrid',
  targets: { ...emptyTargets(), categoryIds: ['social'] },
  whitelistOnly: false,
  allow: emptyAllow(),
  mode: 'normal',
  reason: '',
  acknowledgeNoEmergency: false,
};

export const PHASE5_VALID_INVOKE: { [C in Phase5InvokeChannel]: unknown } = {
  'schedules:create': { intentId: 'intent-5', input: SCHEDULE_INPUT },
  'schedules:update': { id: SCH, input: SCHEDULE_INPUT },
  'schedules:delete': { id: SCH },
  'settings:get': null,
  'settings:put': { settings: harnessFixture('ajustes-full').fake.settings.settings },
  'rewards:list': null,
  'rewards:redeem': { intentId: 'intent-6', offerId: 'youtube-15' },
  'points:summary': null,
  'achievements:list': null,
  'stats:overview': { range: 'week', anchor: '2026-09-21' },
  'stats:heatmap': { end: null, weeks: 26 },
  'stats:events': { filter: 'attempts', before: 'ep_fixture0000000001:410', limit: 50 },
  'stats:export-csv': { kind: 'events' },
  'system:processes': null,
  'activewin:request-permission': null,
  'updater:check': null,
  'updater:download': null,
  'updater:install': null,
  'sounds:load': { sound: 'rain' },
  'onboarding:install-guardian': null,
  'onboarding:test-camera': null,
};

export const PHASE5_VALID_SEND: { [C in Phase5SendChannel]: unknown } = {
  'mini-timer:toggle': { visible: null },
  'mini-timer:position': { position: { x: 1720, y: -24 } },
  'osd:show': { text: '+15 min · hasta las 17:57', icon: 'extend', tone: 'orange' },
  'nuclear:emergency-exit': null,
};

/** Payloads each Phase 5 channel must refuse. */
export const PHASE5_INVALID_INVOKE: Partial<Record<Phase5InvokeChannel, unknown[]>> = {
  'schedules:create': [
    { intentId: 'bad id', input: SCHEDULE_INPUT },
    { intentId: 'i', input: { ...SCHEDULE_INPUT, start: '16:00', end: '16:00' } },
    { intentId: 'i', input: { ...SCHEDULE_INPUT, timezone: 'Local' } },
    { intentId: 'i', input: SCHEDULE_INPUT, extra: 1 },
  ],
  'schedules:update': [{ id: 'blk_fixture0000000001', input: SCHEDULE_INPUT }],
  'schedules:delete': [{ id: 'sch_' }, {}],
  'settings:put': [{ settings: { dailyGoalMinutes: 60 } }, {}],
  'rewards:redeem': [
    { intentId: 'i', offerId: 'YouTube 15' },
    { intentId: 'i', offerId: '' },
    { offerId: 'youtube-15' },
  ],
  'stats:overview': [
    { range: 'year', anchor: null },
    { range: 'week', anchor: '2026-02-30' },
    { range: 'week' },
  ],
  'stats:heatmap': [
    { end: null, weeks: 0 },
    { end: null, weeks: 54 },
    { end: 'today', weeks: 4 },
  ],
  'stats:events': [
    { filter: 'everything', before: null, limit: 50 },
    { filter: 'all', before: 'a b', limit: 50 },
    { filter: 'all', before: null, limit: 201 },
    { filter: 'all', before: 'x'.repeat(65), limit: 10 },
  ],
  'stats:export-csv': [{ kind: 'pdf' }, { kind: 'events', path: '/tmp/x.csv' }],
  'sounds:load': [{ sound: 'thunder' }, { sound: '../lluvia.wav' }],
  'updater:check': [{ force: true }],
};

export const PHASE5_INVALID_SEND: Record<Phase5SendChannel, unknown[]> = {
  'mini-timer:toggle': [{}, { visible: 'yes' }, null],
  'mini-timer:position': [{ position: { x: 1.5, y: 0 } }, { position: { x: 0 } }, {}],
  'osd:show': [
    { text: '', icon: 'extend', tone: 'orange' },
    { text: 'x'.repeat(81), icon: 'extend', tone: 'orange' },
    { text: 'Hola', icon: 'rocket', tone: 'orange' },
    { text: 'Hola', icon: 'extend', tone: 'purple' },
  ],
  'nuclear:emergency-exit': [undefined, {}],
};
