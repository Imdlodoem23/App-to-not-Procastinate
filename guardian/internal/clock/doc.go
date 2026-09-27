// Package clock gives the guardian a notion of "now" that the user cannot move
// by changing the computer's clock, and tells suspend apart from clock changes
// (PROMPT.md section 5, «Cambiar la hora del ordenador no acaba el bloqueo»).
//
// # Clock sources
//
// [BootTime] counts real time since boot, keeps counting while the machine is
// suspended or hibernated, and cannot be stepped by anyone (NTP included):
//
//   - Linux: clock_gettime(CLOCK_BOOTTIME).
//   - macOS: clock_gettime(CLOCK_MONOTONIC_RAW), which Apple's libc implements
//     with mach_continuous_time; golang.org/x/sys/unix reaches it without cgo.
//     (CLOCK_UPTIME_RAW is mach_absolute_time and stops during sleep;
//     CLOCK_MONOTONIC is computed as gettimeofday minus kern.boottime.)
//   - Windows: QueryInterruptTime (100 ns units, includes sleep and
//     hibernation), falling back to GetTickCount64, which includes them too.
//
// [AwakeTime] is the same kind of clock but stops during suspend
// (CLOCK_MONOTONIC, CLOCK_UPTIME_RAW, QueryUnbiasedInterruptTime). The
// difference between the two is the time spent suspended. Go's own monotonic
// clock (time.Since) is deliberately not used for this: it stops during suspend
// on Linux and macOS but not on Windows, where the runtime reads the interrupt
// time.
//
// [BootID] identifies the current boot: /proc/sys/kernel/random/boot_id on
// Linux, sysctl kern.bootsessionuuid on macOS, and on Windows the BootId
// counter under
// HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters
// combined with the creation time of the System process (PID 4), which
// Windows stamps at boot and never rewrites: the counter alone does not change
// on some systems (prefetcher disabled). When no primary source can be read,
// macOS falls back to kern.boottime ("boottime:") and Windows to the boot
// moment derived from the wall clock ("derived:"). A clock change can alter
// those, so [SameBoot] ignores their value and decides by Mono continuity
// alone: a wrong "same boot" only makes blocks last longer, while a wrong
// "different boot" would accept a clock change made while the guardian was
// stopped.
//
// # Trusted time
//
// A [Detector] keeps a trusted clock T and a wall offset W:
//
//	T(m) = baseWall + (m − baseMono)   where m is a Mono (BootTime) reading
//	W    = signed sum of every wall-clock jump reported so far
//
// [NewDetector] sets baseWall to the wall clock and baseMono to Mono read at
// the same moment, so T starts equal to the wall clock and from then on
// advances only with Mono. [Detector.EffectiveNow] returns T;
// [Detector.WallOffset] returns W; T + W is what the wall clock should read.
//
// Every [Detector.Tick] reads the wall clock w, Mono m and Awake a and computes
//
//	diff = w − (T(m) + W)
//
// and then:
//
//   - |diff| > Tolerance (default 60 s): the clock was changed. Tick reports
//     Delta = diff (Forward when positive) and adds it to W. T does not move.
//   - |diff| ≤ Tolerance: clock noise (NTP slewing, the oscillator error of
//     Mono, a small NTP step after resume). T moves toward w − W by at most
//     MaxSlew × (m − previous m) (default 0.1 %, 3.6 s per hour), so over days
//     T follows the NTP-disciplined wall clock instead of drifting away from it.
//
// diff is measured against T, not against the previous tick, so small steps
// add up: moving the clock 50 s every few seconds is reported as soon as the
// sum passes Tolerance. Without a report the wall clock can stray at most
// Tolerance from T + W, and T itself can gain at most MaxSlew of the real
// elapsed time, so a block can be shortened by at most 0.1 % of its length.
//
// A suspend moves the wall clock and Mono by the same amount, so it never looks
// like a jump. It is reported on its own: SuspendedFor = Δm − Δa.
//
// # Backward jumps
//
// Moving the clock back is reported as a negative Delta. T is unaffected, so a
// block whose endsAt is compared with EffectiveNow ends at the promised real
// moment: not later («no más allá de la hora prometida») and not earlier. Only
// the way that moment reads on the machine's (now wrong) wall clock changes:
// endsAt + WallOffset().
//
// # How the engine is expected to use it
//
//   - Keep endsAt in UTC measured against EffectiveNow: endsAt =
//     EffectiveNow().Add(duration). A block is over when
//     !EffectiveNow().Before(endsAt). Never compare with time.Now(): a jump
//     between two ticks would otherwise end the block early.
//   - Call Tick every 1–5 s. When [JumpResult.Jumped], log the attempt and send
//     the app endsAt.Add(WallOffset()), the end expressed in the machine's own
//     clock (PROMPT.md: «suma ese salto a endsAt y se lo manda a la app»), so
//     that its Date.now() countdown matches. An engine that prefers to store
//     deadlines in wall-clock terms must instead add Delta to every one of them
//     inside the same lock that guards its expiry checks.
//   - Evaluate recurring schedules against EffectiveNow().In(loc), never
//     against time.Now().
//   - When the user allows network checks, call [NetworkTime] with
//     EffectiveNow as the certificate clock (after boot or resume, after a
//     jump, then every half hour or so) and pass the result to
//     [Detector.Resync]. When [JumpResult.TrustedShift] is not zero, add it to
//     every pending deadline kept in trusted time inside the lock that guards
//     the expiry checks; display times do not change. A caller that cannot
//     shift its deadlines must use [Detector.Calibrate] instead, which never
//     moves EffectiveNow forward (and so never corrects a lag).
//   - When [JumpResult.Suspended], do not count the missing heartbeats of
//     SuspendedFor as a failure.
//   - Persist [Detector.Snapshot] with the rest of the state (every minute and
//     at shutdown is enough) and pass it to [Detector.Restore] at startup.
//
// # Restarts and reboots
//
// Within the same boot (same BootID and Mono not lower than the saved value)
// Restore resumes T exactly where the snapshot left it plus the Mono time
// elapsed since, so stopping the service, changing the clock and starting it
// again is reported as an ordinary jump.
//
// After a reboot Mono restarts from zero and continuity is lost. T restarts
// from the earlier of two candidates: the wall clock, and the wall clock minus
// the saved offset. The first is right if the clock was put right while the
// machine was off, the second if it is still as wrong as before (a jump made
// before the reboot stays compensated). Taking the earlier one means that
// guessing wrong can only make blocks last longer, never end early. T is never
// set earlier than the saved T: a wall clock that reads earlier (dead CMOS
// battery, clock set back while the machine was off) is not believed, and
// RestoreResult.WallBehind says so.
//
// Without an external reference two errors remain. A clock moved forward
// while the machine was off makes T run ahead: [Detector.Calibrate] (and
// Resync) move T back to the network time, without touching deadlines, so
// blocks last until their promised real moment. A wrong guess, or the clamp to
// the saved T, makes T lag real time, by the offset or by the downtime; ticks
// never correct that (the wall clock agrees with T + W) and it survives
// further reboots. [Detector.Resync] moves T forward to the network time and
// reports the move as TrustedShift, which the engine adds to its pending
// deadlines so that none of them is reached earlier.
//
// Restore distrusts a snapshot only when it cannot be genuine: a zero trusted
// time, or one that is implausible (before 2025, or more than a year ahead of
// both wall-clock candidates) and contradicts the snapshot's own wall clock
// and offset by more than a year (RestoreResult.Discarded; T restarts from the
// wall clock). A snapshot consistent with itself is always used. A large
// offset is never a reason to discard one: it is how a compensated clock
// change survives a reboot. Offsets are added with saturation, so extreme
// values cannot wrap around.
package clock
