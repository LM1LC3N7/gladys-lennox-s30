// Ports that misbehave: one that accepts and never answers, one that refuses.

import { createServer } from 'node:net';
import { HOST, closed, listen } from './util.mjs';

/** Accepts every connection, reads and never writes a byte. */
export async function blackhole() {
  const sockets = new Set();
  const hole = {
    host: HOST,
    port: 0,
    connections: 0,
    received: 0,
    get open() {
      return sockets.size;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await closed(server);
    },
  };
  const server = createServer((socket) => {
    hole.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      hole.received += chunk.length;
    });
  });
  hole.port = await listen(server);
  return hole;
}

/** A port nothing listens on any more: a connection is refused (ECONNREFUSED). */
export async function refusePort() {
  const server = createServer();
  const port = await listen(server);
  await closed(server);
  return port;
}
