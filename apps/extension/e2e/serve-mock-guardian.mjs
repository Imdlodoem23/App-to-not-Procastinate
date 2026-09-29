// Runs the mock guardian (test/mock-guardian.ts) by hand, to try the extension without the
// Go service: load apps/extension/dist as an unpacked extension, then type the code shown
// here in its popup (with «Otro puerto…» when the port is not 47600).
//
//   node apps/extension/e2e/serve-mock-guardian.mjs [--port 47600] [--code 048392]
//
// Commands on stdin: block <service|domain…> [min] · whitelist [min] · allow <service> [min]
// · clear · code · stop · start · status · quit. Blocks are also listed with `status`.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '47600' }, code: { type: 'string' } },
});

const outDir = mkdtempSync(join(tmpdir(), 'centrate-mock-guardian-'));
const outFile = join(outDir, 'mock-guardian.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../test/mock-guardian.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: outFile,
  logLevel: 'warning',
});
const { startMockGuardian } = await import(pathToFileURL(outFile).href);

const guardian = await startMockGuardian({
  port: Number(values.port),
  pairingCode: values.code,
  log: (line) => console.log(`  ${line}`),
});

function status() {
  console.log(`guardian http://127.0.0.1:${guardian.port} · version ${guardian.extRulesVersion}`);
  console.log(`pairing code: ${guardian.pairingCode ?? '(none: type «code»)'}`);
  console.log(`paired extensions: ${guardian.extensions().length} · balance ${guardian.balance}`);
  for (const b of guardian.blocks()) {
    const left = Math.max(0, Math.round((b.endsAt - Date.now()) / 60_000));
    const what = b.whitelistOnly
      ? 'whitelist'
      : b.serviceIds.length > 0
        ? b.serviceIds.join(', ')
        : b.domains.join(', ');
    console.log(`  ${b.id} · ${what} · ${left} min · «${b.reason}»`);
  }
}

function run(line) {
  const [command, ...args] = line.trim().split(/\s+/);
  const minutes = (value, fallback) =>
    value !== undefined && /^\d+$/.test(value) ? Number(value) : fallback;
  switch (command) {
    case undefined:
    case '':
      return;
    case 'block': {
      const last = args.at(-1);
      const time = minutes(last, 25);
      const targets = /^\d+$/.test(last ?? '') ? args.slice(0, -1) : args;
      const services = targets.filter((t) => !t.includes('.'));
      const domains = targets.filter((t) => t.includes('.'));
      guardian.addBlock({ services, domains, minutes: time });
      break;
    }
    case 'whitelist':
      guardian.addBlock({ whitelistOnly: true, minutes: minutes(args[0], 60), reason: 'Examen' });
      break;
    case 'allow':
      guardian.addAllowance(args[0] ?? 'youtube', minutes(args[1], 15));
      break;
    case 'clear':
      guardian.clearBlocks();
      break;
    case 'code':
      console.log(`new code: ${guardian.newPairingCode()}`);
      return;
    case 'stop':
      void guardian
        .stop()
        .then(() => console.log('guardian stopped (the extension keeps its rules)'));
      return;
    case 'start':
      void guardian.start().then(() => console.log('guardian listening again'));
      return;
    case 'status':
      break;
    case 'quit':
    case 'exit':
      void shutdown();
      return;
    default:
      console.log(
        'commands: block <targets…> [min] · whitelist [min] · allow <service> [min] · clear · code · stop · start · status · quit',
      );
      return;
  }
  status();
}

async function shutdown() {
  await guardian.close();
  rmSync(outDir, { recursive: true, force: true });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
status();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    run(line);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
});
