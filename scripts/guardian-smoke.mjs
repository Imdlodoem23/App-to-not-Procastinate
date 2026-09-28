// End-to-end smoke test of the real guardian binary (docs/ARCHITECTURE.md §15).
//
// Runs `centrate-guardian run` in the foreground on a temporary data folder and hosts file
// (CENTRATE_DATA_DIR, CENTRATE_HOSTS_PATH; build the binary with `-tags "testhooks
// centrate_dev"` so the overrides also apply on elevated CI runners and POST /v1/_test/clock
// drives its fake clock) and talks to it through `createGuardianClient` from packages/shared,
// bundled in memory with esbuild like scripts/gen-guardian-data.mjs does:
//
//   create a YouTube block with the token from client.json → the hosts section lists it;
//   window attempts cost −10, then −20; the block survives a restart; a forward wall jump moves
//   the display end; past the end the section is gone and block_completed credits +60;
//   `has-active` exits 10 during the block and 0 after it.
//
// With --release it checks a release build instead: health lacks the testhooks capability and
// POST /v1/_test/clock is 404.
//
// Usage: node scripts/guardian-smoke.mjs --bin <path to centrate-guardian> [--release] [--keep]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values: args } = parseArgs({
  options: {
    bin: { type: 'string' },
    release: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
if (!args.bin) {
  console.error('usage: node scripts/guardian-smoke.mjs --bin <centrate-guardian> [--release]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const bin = resolve(args.bin);
const USER_HOSTS = '127.0.0.1 localhost\n::1 localhost\n';
const MINUTE = 60_000;

/** Loads the shared guardian client (TypeScript) through an in-memory esbuild bundle. */
async function loadShared() {
  const result = await build({
    stdin: {
      contents: `export {
        createGuardianClient,
        GuardianApiError,
        validateResponse,
        testClockResponseSchema,
        GUARDIAN_TEST_CAPABILITY,
      } from './packages/shared/src/guardian-api.ts';`,
      resolveDir: root,
      sourcefile: 'guardian-smoke-entry.ts',
      loader: 'ts',
    },
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/** A free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A TestClockRequest with one action (every field is required). */
const clockAction = (field, value) => ({
  advanceMs: null,
  suspendMs: null,
  jumpMs: null,
  reboot: false,
  [field]: value,
});

function check(cond, message) {
  if (!cond) throw new Error(`smoke check failed: ${message}`);
  console.log(`ok - ${message}`);
}

// The temporary machine: <base>/centrate (data folder; the name matters to RemoveDataDir) and
// <base>/hosts.
const base = mkdtempSync(join(tmpdir(), 'centrate-smoke-'));
const dataDir = join(base, 'centrate');
const hostsPath = join(base, 'hosts');
writeFileSync(hostsPath, USER_HOSTS);
mkdirSync(dataDir, { recursive: true });
const port = await freePort();
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ schemaVersion: 1, port }) + '\n');
const env = { ...process.env, CENTRATE_DATA_DIR: dataDir, CENTRATE_HOSTS_PATH: hostsPath };

const readClientJson = () => JSON.parse(readFileSync(join(dataDir, 'client.json'), 'utf8'));
const readHosts = () => readFileSync(hostsPath, 'utf8');
const hostsHas = (line) => readHosts().split(/\r?\n/).includes(line);

let guardian = null;
let output = '';

/** Starts `centrate-guardian run` and waits until its API answers. */
async function startGuardian() {
  guardian = spawn(bin, ['run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  guardian.stdout.on('data', (d) => (output += d));
  guardian.stderr.on('data', (d) => (output += d));
  const exited = new Promise((r) => guardian.once('exit', (code) => r(code)));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const code = await Promise.race([exited, sleep(250).then(() => undefined)]);
    if (code !== undefined) throw new Error(`the guardian exited with ${code}`);
    if (!existsSync(join(dataDir, 'client.json'))) continue;
    const { port: bound } = readClientJson();
    try {
      const res = await fetch(`http://127.0.0.1:${bound}/v1/health`);
      if (res.ok) return bound;
    } catch {
      // not listening yet
    }
  }
  throw new Error('the guardian API never answered');
}

/** Stops the guardian: SIGTERM is its clean stop on Unix; Windows has no signal to send. */
async function stopGuardian() {
  if (!guardian || guardian.exitCode !== null) return;
  const exited = new Promise((r) => guardian.once('exit', r));
  guardian.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  await Promise.race([exited, sleep(15_000)]);
  if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill('SIGKILL');
  guardian = null;
}

function hasActive() {
  const r = spawnSync(bin, ['has-active'], { env, encoding: 'utf8' });
  return r.status;
}

async function main() {
  const shared = await loadShared();
  const boundPort = await startGuardian();
  if (boundPort === port) {
    check(true, `the guardian listens on the config.json port (${port})`);
  } else if (process.platform === 'win32') {
    // An elevated guardian re-creates a data folder it does not trust (§11.1), config.json
    // included; it then listens on the default port, which client.json names.
    console.log(`note - config.json port ${port} not used (listening on ${boundPort})`);
  } else {
    check(false, `the guardian listens on the config.json port (${port}, got ${boundPort})`);
  }
  const baseUrl = `http://127.0.0.1:${boundPort}`;
  const client = shared.createGuardianClient({ baseUrl, token: () => readClientJson().token });

  const health = await client.health();
  check(health.ok && health.name === 'centrate-guardian', 'health answers');
  const testClockRes = await fetch(`${baseUrl}/v1/_test/clock`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${readClientJson().token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(clockAction('advanceMs', 0)),
  });
  if (args.release) {
    check(
      !health.capabilities.includes(shared.GUARDIAN_TEST_CAPABILITY),
      'no testhooks capability',
    );
    check(testClockRes.status === 404, 'POST /v1/_test/clock is 404 in a release build');
    return;
  }
  check(health.capabilities.includes(shared.GUARDIAN_TEST_CAPABILITY), 'testhooks capability');
  check(testClockRes.status === 200, 'POST /v1/_test/clock answers');

  /** Drives the fake clock (the shared client has no method for the test-only route). */
  async function testClock(body) {
    const res = await fetch(`${baseUrl}/v1/_test/clock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readClientJson().token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    const v = shared.validateResponse(shared.testClockResponseSchema, json);
    if (res.status !== 200 || !v.ok)
      throw new Error(`test clock ${res.status}: ${JSON.stringify(json)}`);
    return v.value;
  }

  // 1. A 60-minute YouTube block reaches the hosts file.
  const { block } = await client.createBlock({
    targets: {
      serviceIds: ['youtube'],
      categoryIds: [],
      appIds: [],
      customDomains: [],
      customProcesses: [],
    },
    whitelistOnly: false,
    allow: { customDomains: [], customProcesses: [] },
    mode: 'strict',
    durationMinutes: 60,
    endsAt: null,
    reason: 'Prueba de humo',
    acknowledgeLong: false,
    acknowledgeNoEmergency: false,
  });
  check(block.status === 'active', 'block created');
  check(
    hostsHas('0.0.0.0 youtube.com') && hostsHas(':: youtube.com'),
    'hosts section lists youtube.com (0.0.0.0 and ::)',
  );
  check(readHosts().startsWith(USER_HOSTS), "the user's hosts lines are untouched");
  check(hasActive() === 10, 'has-active exits 10 during a strict block');

  // 2. Attempts from the app's window layer: −10, then −20 after the dedupe window.
  const attempt = {
    layer: 'window',
    target: { type: 'service', value: 'youtube' },
    browser: null,
    incognito: false,
  };
  const a1 = await client.reportAttempt(attempt);
  check(a1.counted && a1.pointsDelta === -10, `first attempt costs −10 (${a1.pointsDelta})`);
  await testClock(clockAction('advanceMs', 31_000));
  const a2 = await client.reportAttempt(attempt);
  check(a2.counted && a2.pointsDelta === -20, `second attempt costs −20 (${a2.pointsDelta})`);

  // 3. Restart: the block survives; the client re-reads the rotated token after a 401.
  const oldToken = readClientJson().token;
  await stopGuardian();
  check(hostsHas('0.0.0.0 youtube.com'), 'stopping the guardian keeps the hosts section');
  await startGuardian();
  check(readClientJson().token !== oldToken, 'client.json has a new token after the restart');
  const after = (await client.getBlock(block.id)).block;
  check(
    after.status === 'active' && after.endsAt === block.endsAt,
    'the block survives the restart',
  );

  // 4. A forward wall jump moves the display end by the jump.
  await testClock(clockAction('jumpMs', 60 * MINUTE));
  const jumped = (await client.getBlock(block.id)).block;
  check(
    Date.parse(jumped.endsAt) - Date.parse(block.endsAt) === 60 * MINUTE,
    'a +1 h wall jump moves endsAt by 1 h',
  );

  // 5. Past the end: section gone, +60 credited.
  await testClock(clockAction('advanceMs', 61 * MINUTE));
  const ended = (await client.getBlock(block.id)).block;
  check(ended.status === 'completed', 'the block completes at its end');
  check(readHosts() === USER_HOSTS, 'the hosts file is byte-identical to the original');
  const state = await client.getState();
  const events = [];
  for (let after = 0; ;) {
    const page = await client.getEvents({ epoch: state.state.epoch, after });
    events.push(...page.events);
    if (!page.hasMore) break;
    after = page.lastSeq;
  }
  const completed = events.filter((e) => e.type === 'block_completed');
  check(completed.length === 1 && completed[0].points === 60, 'block_completed credits +60');
  const { points } = await client.getPoints();
  check(points.balance === 30, `balance is 60 − 10 − 20 = 30 (${points.balance})`);
  await stopGuardian();
  check(hasActive() === 0, 'has-active exits 0 once the block ended');
}

try {
  await main();
  console.log(`guardian smoke test passed (${args.release ? 'release' : 'testhooks'} build)`);
} catch (error) {
  console.error(error);
  console.error('--- guardian output ---\n' + output);
  process.exitCode = 1;
} finally {
  await stopGuardian();
  if (!args.keep) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.log(`kept ${base}`);
}
