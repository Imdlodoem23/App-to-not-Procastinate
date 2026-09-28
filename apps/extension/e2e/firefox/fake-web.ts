/**
 * The fake web for Firefox: an HTTP forward proxy on 127.0.0.1 that Firefox uses for every
 * http(s) request (loopback excepted, so the guardian is reached directly). Plain http is
 * answered with a tiny page titled with its host (`fakeTitle`, as in the Chromium suite),
 * or with a 302 to the URL in `?centrate-redirect=` (a link through a redirector); https
 * CONNECT tunnels are refused, so nothing reaches the network. Blocked hosts never get
 * here: declarativeNetRequest redirects them to blocked.html before any connection.
 */
import type { Socket } from 'node:net';
import { createServer } from 'node:http';
import { fakeTitle } from '../support/extension';

/** Query parameter that makes the fake web answer `302 Location: <value>`. */
export const REDIRECT_PARAM = 'centrate-redirect';

export interface FakeWeb {
  readonly port: number;
  /** Absolute URLs requested through the proxy (CONNECT as `https://host:port`). */
  requests(): string[];
  close(): Promise<void>;
}

export async function startFakeWeb(): Promise<FakeWeb> {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'invalid'}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    seen.push(url.href);
    const target = url.searchParams.get(REDIRECT_PARAM);
    if (target !== null) {
      res.writeHead(302, { location: target, 'content-length': '0' }).end();
      return;
    }
    const title = fakeTitle(url.href);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="es"><meta charset="utf-8"><title>${title}</title><h1>${title}</h1></html>`,
    );
  });
  server.on('connect', (req, socket: Socket) => {
    seen.push(`https://${req.url ?? ''}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    requests: () => [...seen],
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
