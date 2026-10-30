/* eslint-disable no-console -- dev check */
// Reproduces the host condition behind "body must be a FormData created by
// this undici package instance": another (newer) undici loaded first owns the
// process-wide global dispatcher. Sends a message with a file through the
// real createClient() to a local fake Discord API — once with the plugin's own
// REST agent, once without (control). Run: node dev/host-undici-check.mjs <path-to-undici8>
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { createClient } from '../src/discord-client.js';

const hostUndiciPath = process.argv[2];
if (!hostUndiciPath) throw new Error('usage: host-undici-check.mjs <path to a newer undici>');

// 1) Like the middleware: its undici loads first and claims the global slot.
const hostUndici = createRequire(import.meta.url)(hostUndiciPath) as {
  getGlobalDispatcher(): unknown;
};
hostUndici.getGlobalDispatcher();

// 2) Fake Discord API that accepts the multipart upload.
let received = '';
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString('latin1')));
  req.on('end', () => {
    received = `${req.method} ${req.url} ${req.headers['content-type']?.split(';')[0]} ${body.length}B`;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: '1' }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function send(label: string, ownAgent: boolean): Promise<void> {
  const client = createClient({ messageContent: false });
  const rest = client.rest as unknown as { options: { api: string }; agent: unknown };
  rest.options.api = api;
  if (!ownAgent) rest.agent = null;
  // Placeholder: only the local fake API above ever sees it.
  client.rest.setToken('local-fake-token');
  received = '';
  await client.rest
    .post('/channels/1/messages', {
      body: { content: 'test' },
      files: [{ name: 'tabelle-1.png', data: Buffer.from('fake-png') }],
    })
    .then(() => console.log(`${label}: OK → ${received}`))
    .catch((e: unknown) => console.log(`${label}: FAILED → ${(e as Error).message}`));
  await client.rest.agent?.close().catch(() => undefined);
}

await send('without own agent', false);
await send('with own agent   ', true);
server.close();
