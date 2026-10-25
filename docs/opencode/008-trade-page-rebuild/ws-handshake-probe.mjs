// WS handshake probe: does the browser-facing WS URL actually upgrade?
// Compares the page-origin socket (ws://127.0.0.1:3000/ws/realtime) with the
// direct backend socket (ws://127.0.0.1:8000/ws/realtime) the frontend
// contract documents as path B.
const token = process.argv[2] || '';
const targets = [
  `ws://127.0.0.1:3000/ws/realtime?token=${token}`,
  `ws://127.0.0.1:8000/ws/realtime?token=${token}`,
];

async function probe(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ url, result: 'TIMEOUT (no upgrade / no open)' });
    }, 6000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ url, result: 'OPEN (101 upgrade OK)' });
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve({ url, result: 'ERROR (handshake failed)' });
    });
  });
}

for (const t of targets) {
  const r = await probe(t);
  console.log(`${r.result}  <-  ${r.url}`);
}
