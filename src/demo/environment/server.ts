/**
 * Self-contained demo server. Uses Node's built-in http module so the
 * demo app has zero runtime dependencies beyond Node itself.
 *
 * Each test / run allocates its own port via `startServer({ port: 0 })`.
 * Pass `port: 0` to let the OS pick an ephemeral port.
 */

import { createServer, type IncomingMessage } from 'node:http';
import { createAppRoutes } from './app.js';
import { createDemoState } from './state.js';

export interface ServerHandle {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const state = createDemoState();
  const routes = createAppRoutes(state);
  const server = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const resp = await routes.handle({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: headersToRecord(req),
        body,
      });
      if (resp.location) {
        res.writeHead(resp.status, {
          location: resp.location,
          'content-type': resp.contentType,
        });
      } else {
        res.writeHead(resp.status, { 'content-type': resp.contentType });
      }
      res.end(resp.body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`server error: ${(err as Error).message}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
    server.once('error', (e) => reject(e));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('unexpected server address');
  }
  return {
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function headersToRecord(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(',');
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4321);
  startServer({ port }).then((h) => {
    console.info(`demo server listening at ${h.baseUrl}`);
  });
}
