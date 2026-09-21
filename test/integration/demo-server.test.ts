import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type ServerHandle } from '../../src/demo/environment/server.js';

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe('demo server', () => {
  it('serves the index page with the expected text', async () => {
    const r = await fetch(`${server.baseUrl}/`);
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toContain('Task Tracker');
    expect(text).toContain('Add a task');
    expect(text).toContain('Settings');
  });

  it('redirects POST /tasks back to /', async () => {
    const r = await fetch(`${server.baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=Buy+milk',
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/');
    const after = await fetch(`${server.baseUrl}/`);
    const afterText = await after.text();
    expect(afterText).toContain('Buy milk');
  });

  it('returns 404 on unknown paths', async () => {
    const r = await fetch(`${server.baseUrl}/no/such/page`);
    expect(r.status).toBe(404);
  });
});
