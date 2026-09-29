/**
 * A minimal guardian over real HTTP on 127.0.0.1 for the wire tests (docs/DESKTOP.md §12
 * «wire»): the app's main process reaches it with Node's `fetch` through the production
 * client, with the token from `client.json` in a temporary `CENTRATE_DATA_DIR`.
 *
 * It serves `/v1/health`, `/v1/state` (ETag `"s-<stateVersion>"`, 304 on `If-None-Match`),
 * `/v1/events` (an empty log: the first page at once, then empty long polls),
 * `POST /v1/pairing/code` and daily limits (`GET`/`POST /v1/limits`, `POST /v1/usage`), with payloads from the harness fixture builders (they pass the
 * shared response validators), and records every request's method, path and headers. Like
 * the real guardian, it rejects app-token requests that carry an `Origin` (403
 * `origin_not_allowed`) and wrong tokens (401).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DailyLimit, LimitId } from '@centrate/shared/domain';
import {
  APP_TOKEN_PREFIX,
  GUARDIAN_PATHS,
  isDailyLimitInput,
  isUsageReportRequest,
} from '@centrate/shared/guardian-api';
import { harnessFixture, makeGuardianState, makeHealth } from '../../src/shared/fixtures';

export interface RecordedRequest {
  at: number;
  method: string;
  path: string;
  status: number;
  headers: Record<string, string | undefined>;
}

export interface GuardianServer {
  port: number;
  /** Folder holding `client.json` (`CENTRATE_DATA_DIR`). */
  dataDir: string;
  token(): string;
  requests(): RecordedRequest[];
  /** New token, written to `client.json` like a guardian restart does. */
  rotateToken(): string;
  /** Stop answering: close the listener and every open connection. */
  stop(): Promise<void>;
  /** Listen again on the same port. */
  start(): Promise<void>;
  dispose(): Promise<void>;
}

function newToken(): string {
  return `${APP_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export async function startGuardianServer(): Promise<GuardianServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'centrate-sys-'));
  const recorded: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let token = newToken();
  let port = 0;
  const started = Date.now();
  // One state for the whole run: its version (and ETag) only changes if a test asks. Its event
  // log is the empty one `/v1/events` serves (`lastEventSeq` 0, not the fixture's 420): a state
  // ahead of its own log leaves the app's local copy behind for good, and the app keeps
  // re-reading it (Progreso retries every 2 s for 10 s), publishing mid-test.
  const state = { ...makeGuardianState(started), lastEventSeq: 0 };
  const etag = `"s-${state.stateVersion}"`;
  const bootHealth = makeHealth(started);
  const pairing = harnessFixture('idle').fake.pairingCode;
  const limits: DailyLimit[] = [];

  const readJson = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw) as unknown);
        } catch {
          resolve(null);
        }
      });
    });

  const writeClientJson = (): void => {
    const file = join(dataDir, 'client.json');
    const body = {
      v: 1,
      port,
      token,
      guardianVersion: '0.1.0',
      pid: process.pid,
      issuedAt: new Date().toISOString(),
    };
    writeFileSync(`${file}.tmp`, JSON.stringify(body));
    renameSync(`${file}.tmp`, file);
  };

  const send = (res: ServerResponse, status: number, body?: unknown, headers = {}): number => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
    return status;
  };
  const error = (res: ServerResponse, status: number, code: string): number =>
    send(res, status, { error: { code, message: code, details: null } });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authed = req.headers.authorization === `Bearer ${token}`;
    const needsToken = url.pathname !== GUARDIAN_PATHS.health;
    if (needsToken && req.headers.origin !== undefined)
      return error(res, 403, 'origin_not_allowed');
    if (needsToken && !authed) return error(res, 401, 'unauthorized');

    if (req.method === 'GET' && url.pathname === GUARDIAN_PATHS.health) {
      // Only `serverNow` moves between answers: `startedAt` is the process's, like the real one's
      // (the app republishes a health that changed in anything else).
      return send(res, 200, { ...makeHealth(Date.now()), startedAt: bootHealth.startedAt });
    }
    if (req.method === 'GET' && url.pathname === GUARDIAN_PATHS.state) {
      if (req.headers['if-none-match'] === etag) return send(res, 304, undefined, { ETag: etag });
      return send(res, 200, state, { ETag: etag });
    }
    if (req.method === 'GET' && url.pathname === GUARDIAN_PATHS.events) {
      // Like the real guardian (store.ReadEvents): another epoch (none on the first sync) or a
      // cursor past the end is answered at once with `reset`; a caught-up cursor waits (up to
      // 1 s here) for events that never come.
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      const reset = url.searchParams.get('epoch') !== state.epoch || after > state.lastEventSeq;
      if (!reset) {
        const waitMs = Math.min(Number(url.searchParams.get('waitMs') ?? 0) || 0, 1_000);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      return send(res, 200, {
        epoch: state.epoch,
        reset,
        events: [],
        lastSeq: reset ? 0 : after,
        hasMore: false,
      });
    }
    if (req.method === 'POST' && url.pathname === GUARDIAN_PATHS.pairingCode) {
      return send(res, 201, pairing);
    }
    if (req.method === 'GET' && url.pathname === GUARDIAN_PATHS.limits) {
      return send(res, 200, { limits });
    }
    if (req.method === 'POST' && url.pathname === GUARDIAN_PATHS.limits) {
      const body = await readJson(req);
      if (!isDailyLimitInput(body)) return error(res, 400, 'validation_failed');
      const now = new Date().toISOString();
      const { acknowledgeNoEmergency: _ack, ...definition } = body;
      const limit: DailyLimit = {
        ...definition,
        id: `lim_wire${String(limits.length + 1).padStart(12, '0')}` as LimitId,
        createdAt: now,
        updatedAt: now,
        day: now.slice(0, 10),
        appliesToday: true,
        usedTodaySeconds: 0,
        remainingTodaySeconds: body.dailyMinutes * 60,
        reachedAt: null,
        activeBlockId: null,
        pendingChange: null,
      };
      limits.push(limit);
      return send(res, 201, { limit });
    }
    if (req.method === 'POST' && url.pathname === GUARDIAN_PATHS.usage) {
      const body = await readJson(req);
      if (!isUsageReportRequest(body)) return error(res, 400, 'validation_failed');
      return send(res, 200, {
        day: state.points.today.day,
        limits: [],
        serverNow: new Date().toISOString(),
      });
    }
    return error(res, 404, 'not_found');
  };

  const server = createServer((req, res) => {
    const at = Date.now();
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    void handle(req, res)
      .catch(() => error(res, 500, 'internal'))
      .then((status) => {
        recorded.push({
          at,
          method: req.method ?? '',
          path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
          status,
          headers,
        });
      });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const listen = (onPort: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(onPort, '127.0.0.1', () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });

  await listen(0);
  writeClientJson();

  return {
    get port() {
      return port;
    },
    dataDir,
    token: () => token,
    requests: () => [...recorded],
    rotateToken() {
      token = newToken();
      writeClientJson();
      return token;
    },
    stop: close,
    start: () => listen(port),
    async dispose() {
      if (server.listening) await close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
