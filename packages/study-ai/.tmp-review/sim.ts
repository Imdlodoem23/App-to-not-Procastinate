import { AdaptiveLoop } from '../src/runtime/loop';
import { CpuGovernor } from '../src/runtime/governor';
import { FrameCadence } from '../src/runtime/frame-step';
import { FakeScheduler } from '../test/runtime/fakes';

async function run(face: number, det: number, faceSeen: boolean) {
  const s = new FakeScheduler(0);
  const gov = new CpuGovernor();
  const cadence = new FrameCadence();
  const starts: number[] = [];
  const loop = new AdaptiveLoop(
    async (now, plan) => {
      starts.push(now);
      const opts = cadence.options(now, plan);
      const cost = face + (opts.objects ? det : 0);
      s.t += cost; // synchronous compute
      cadence.done(s.t, opts);
      return { at: now, visionMs: face, objectMs: opts.objects ? det : 0, otherMs: 0, ranObjects: opts.objects, faceSeen };
    },
    gov,
    s,
    s,
  );
  loop.start();
  for (let i = 0; i < 1200; i++) await s.advance(100);
  loop.stop();
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  const over5 = gaps.filter((g) => g > 5000).length;
  const over3 = gaps.filter((g) => g > 3000).length;
  console.log(`face=${face} det=${det} faceSeen=${faceSeen}: ticks=${starts.length} maxGap=${Math.max(...gaps).toFixed(0)} gaps>3s=${over3} gaps>5s=${over5} level=${gov.level} stats=${JSON.stringify({fps: loop.stats.fps})}`);
}
for (const [f, d] of [[40, 150], [60, 300], [80, 450], [80, 600], [100, 800]] as const) {
  await run(f, d, false);
  await run(f, d, true);
}
