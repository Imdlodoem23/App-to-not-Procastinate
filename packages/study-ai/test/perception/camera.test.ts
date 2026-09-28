/** The camera frame source with a fake browser surface (Node, fake clock and timers). */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CameraOpenError,
  cameraErrorCode,
  listCamerasWith,
  openCameraWith,
  type CameraEnv,
} from '../../src/perception/camera';
import type { TimerApi } from '../../src/types';

class FakeTimers implements TimerApi {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Moves the clock, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.pending) if (!first || entry[1].at < first[1].at) first = entry;
      if (!first || first[1].at > end) break;
      this.pending.delete(first[0]);
      this.now = first[1].at;
      first[1].fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

class FakeBitmap {
  closed = 0;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed += 1;
  }
}

class FakeTrack extends EventTarget {
  muted = false;
  readyState: 'live' | 'ended' = 'live';
  stopped = 0;
  constructor(
    readonly label: string,
    private readonly settings: { width?: number; height?: number },
  ) {
    super();
  }
  getSettings(): { width?: number; height?: number } {
    return this.settings;
  }
  stop(): void {
    this.stopped += 1;
    this.readyState = 'ended';
  }
  end(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

interface Rig {
  env: CameraEnv;
  timers: FakeTimers;
  track: FakeTrack;
  bitmaps: FakeBitmap[];
  constraints: MediaStreamConstraints[];
  /** How the next grabFrame() behaves. */
  grab: 'now' | 'never' | 'late' | 'reject';
  resolveLate: (() => void) | null;
  resized: number;
}

function rig(options: { settings?: { width?: number; height?: number }; fail?: string } = {}): Rig {
  const timers = new FakeTimers();
  const track = new FakeTrack(
    'Integrated Webcam (0bda:5634)',
    options.settings ?? { width: 320, height: 240 },
  );
  const r: Rig = {
    env: null as unknown as CameraEnv,
    timers,
    track,
    bitmaps: [],
    constraints: [],
    grab: 'now',
    resolveLate: null,
    resized: 0,
  };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const settings = track.getSettings();
  r.env = {
    mediaDevices: {
      getUserMedia: async (constraints?: MediaStreamConstraints) => {
        r.constraints.push(constraints ?? {});
        if (options.fail) throw Object.assign(new Error('nope'), { name: options.fail });
        return stream;
      },
      enumerateDevices: async () =>
        [
          { kind: 'audioinput', deviceId: 'a', label: 'Mic', groupId: '', toJSON: () => ({}) },
          { kind: 'videoinput', deviceId: 'v1', label: 'Webcam', groupId: '', toJSON: () => ({}) },
        ] as MediaDeviceInfo[],
    },
    createGrabber: () => ({
      grabFrame: () => {
        const bitmap = new FakeBitmap(settings.width ?? 320, settings.height ?? 240);
        r.bitmaps.push(bitmap);
        if (r.grab === 'reject') return Promise.reject(new Error('InvalidStateError'));
        if (r.grab === 'never') return new Promise<ImageBitmap>(() => {});
        if (r.grab === 'late') {
          return new Promise<ImageBitmap>((resolve) => {
            r.resolveLate = () => resolve(bitmap as unknown as ImageBitmap);
          });
        }
        return Promise.resolve(bitmap as unknown as ImageBitmap);
      },
    }),
    resize: async (bitmap, width, height) => {
      r.resized += 1;
      const small = new FakeBitmap(width, height);
      r.bitmaps.push(small);
      void bitmap;
      return small as unknown as ImageBitmap;
    },
    createVideo: null,
    now: () => timers.now,
    timers,
    sha256Hex: async (text) => createHash('sha256').update(text).digest('hex'),
  };
  return r;
}

describe('openCamera', () => {
  it('asks for 320×240 video only, at a low frame rate', async () => {
    const r = rig();
    await openCameraWith({ deviceId: 'v1' }, r.env);
    expect(r.constraints[0]).toEqual({
      audio: false,
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 5, max: 10 },
        resizeMode: 'crop-and-scale',
        deviceId: { exact: 'v1' },
      },
    });
  });

  it('maps getUserMedia errors to codes', async () => {
    const cases: [string, string][] = [
      ['NotAllowedError', 'permission_denied'],
      ['NotReadableError', 'in_use'],
      ['AbortError', 'in_use'],
      ['NotFoundError', 'not_found'],
      ['OverconstrainedError', 'not_found'],
      ['TypeError', 'unknown'],
    ];
    for (const [name, code] of cases) {
      const r = rig({ fail: name });
      await expect(openCameraWith({}, r.env)).rejects.toMatchObject({ code });
      expect(cameraErrorCode({ name })).toBe(code);
    }
    const none = rig();
    none.env.mediaDevices = null;
    const error = await openCameraWith({}, none.env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CameraOpenError);
    expect((error as CameraOpenError).code).toBe('unsupported');
  });
});

describe('frame source', () => {
  it('starting → ok → stalled; frames close exactly once', async () => {
    const r = rig();
    const cam = await openCameraWith({}, r.env);
    expect(cam.status).toBe('starting');
    expect([cam.width, cam.height]).toEqual([320, 240]);
    const frame = (await cam.next())!;
    expect(frame).not.toBeNull();
    expect(cam.status).toBe('ok');
    expect([frame.width, frame.height]).toEqual([320, 240]);
    frame.close();
    frame.close();
    expect(r.bitmaps[0]!.closed).toBe(1);
    await r.timers.advance(3_001);
    expect(cam.status).toBe('stalled');
    (await cam.next())!.close();
    expect(cam.status).toBe('ok');
  });

  it('a camera that never delivers is stalled after 5 s', async () => {
    const r = rig();
    const cam = await openCameraWith({}, r.env);
    await r.timers.advance(5_001);
    expect(cam.status).toBe('stalled');
  });

  it('muted track → stalled, ended track → error, stop() → off (idempotent)', async () => {
    const r = rig();
    const cam = await openCameraWith({}, r.env);
    (await cam.next())!.close();
    r.track.muted = true;
    expect(cam.status).toBe('stalled');
    r.track.muted = false;
    r.track.end();
    expect(cam.status).toBe('error');
    expect(await cam.next()).toBeNull();
    cam.stop();
    cam.stop();
    expect(cam.status).toBe('off');
    expect(r.track.stopped).toBe(1);
  });

  it('next() gives null after 2 s without a frame and closes a late one', async () => {
    const r = rig();
    const cam = await openCameraWith({}, r.env);
    r.grab = 'late';
    const pending = cam.next();
    await r.timers.advance(2_000);
    expect(await pending).toBeNull();
    r.resolveLate!();
    await flush();
    expect(r.bitmaps[0]!.closed).toBe(1);
  });

  it('next() gives null when grabFrame rejects', async () => {
    const r = rig();
    const cam = await openCameraWith({}, r.env);
    r.grab = 'reject';
    expect(await cam.next()).toBeNull();
  });

  it('scales big frames down to about 320 px wide, keeping the aspect', async () => {
    const r = rig({ settings: { width: 1280, height: 720 } });
    const cam = await openCameraWith({}, r.env);
    expect([cam.width, cam.height]).toEqual([320, 180]);
    const frame = (await cam.next())!;
    expect([frame.width, frame.height]).toEqual([320, 180]);
    expect(r.resized).toBe(1);
    expect(r.bitmaps[0]!.closed).toBe(1); // the big one, right away
    frame.close();
    expect(r.bitmaps[1]!.closed).toBe(1);
  });

  it('identity() hashes label and size; the label never appears', async () => {
    const r = rig();
    const cam = await openCameraWith({}, r.env);
    const id = await cam.identity();
    const expected = createHash('sha256')
      .update('Integrated Webcam (0bda:5634)|320x240')
      .digest('hex');
    expect(id).toEqual({ key: `sha256:${expected}`, aspect: 320 / 240 });
    expect(JSON.stringify(id)).not.toContain('Webcam');
    expect(id.key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('lists only video inputs', async () => {
    const r = rig();
    expect(await listCamerasWith(r.env)).toEqual([{ deviceId: 'v1', label: 'Webcam' }]);
    r.env.mediaDevices = null;
    expect(await listCamerasWith(r.env)).toEqual([]);
  });
});
