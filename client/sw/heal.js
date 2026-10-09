/* Runs inside the generated service worker via workbox `importScripts`.
 * When a new build's worker activates, pages served from a previous build
 * can no longer load their hashed chunks (the old precache is purged) and
 * carry no recovery code of their own — the worker is the only code path
 * stale clients fetch fresh. Ping every window client; reload the ones
 * that cannot answer. */
const PING_TYPE = 'LC_SW_PING';
const PONG_TYPE = 'LC_SW_PONG';
const PONG_TIMEOUT_MS = 1500;

const pendingPongs = new Map();

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== PONG_TYPE || !event.source) {
    return;
  }
  const resolvePong = pendingPongs.get(event.source.id);
  if (resolvePong) {
    pendingPongs.delete(event.source.id);
    resolvePong(true);
  }
});

function pingClient(client) {
  return new Promise((resolve) => {
    pendingPongs.set(client.id, resolve);
    setTimeout(() => {
      if (pendingPongs.delete(client.id)) {
        resolve(false);
      }
    }, PONG_TIMEOUT_MS);
    client.postMessage({ type: PING_TYPE });
  });
}

async function reloadUnresponsiveClients() {
  await self.clients.claim();
  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const topLevelClients = windowClients.filter((client) => client.frameType !== 'nested');
  await Promise.all(
    topLevelClients.map(async (client) => {
      const responsive = await pingClient(client);
      if (responsive) {
        return;
      }
      try {
        await client.navigate(client.url);
      } catch {
        /* client closed or no longer controllable */
      }
    }),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(reloadUnresponsiveClients());
});
