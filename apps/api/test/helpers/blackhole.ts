/**
 * A TCP server that accepts connections and never answers: what a Postgres host that hangs
 * looks like to node-postgres (the connect times out with no error code). Also a closed port.
 */
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

export interface Blackhole {
  url: string;
  close(): Promise<void>;
}

export async function startBlackhole(): Promise<Blackhole> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgres://centrate:secret@127.0.0.1:${port}/centrate`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A local port nothing listens on (ECONNREFUSED). */
export async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `postgres://centrate:secret@127.0.0.1:${port}/centrate`;
}
