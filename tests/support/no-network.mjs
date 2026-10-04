// Fails any attempt to open a non-loopback network connection.
//
// Loaded by Vitest (setupFiles) and by child processes spawned in integration tests
// (`node --import`). M0 has no external integrations, so any outbound connection from a
// test is a bug. Loopback (the API's own socket, a local test database) and IPC are allowed.
import net from 'node:net';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(host) {
  return host === undefined || LOOPBACK_HOSTS.has(host) || /^127\./.test(host);
}

function targetOf(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null) {
    return { host: first.host, path: first.path };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) {
    return { path: first };
  }
  return { host: typeof args[1] === 'string' ? args[1] : undefined };
}

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
  const { host, path } = targetOf(args);
  if (path === undefined && !isLoopback(host)) {
    throw new Error(`External network access is forbidden in tests (attempted host: ${host})`);
  }
  return originalConnect.apply(this, args);
};
