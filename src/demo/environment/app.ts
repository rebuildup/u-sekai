/**
 * Demo task-tracker app: deliberate ambiguities + dead ends so a
 * Synthetic User has real exploration to do.
 *
 * Pages:
 *   GET  /                  -> index: list of tasks + add form
 *   POST /tasks             -> add a task (returns to /)
 *   POST /tasks/:id/toggle  -> toggle done (returns to /)
 *   GET  /settings          -> settings page (deliberate dead end)
 *   GET  /help              -> help page
 *
 * Form actions use plain HTML; the participant only needs to issue
 * `clickByCoords` or `typeText` against the demo server.
 */

import type { DemoState } from './state.js';

interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly location?: string;
}

export type RouteFn = (req: IncomingLike) => Promise<RouteResponse>;

export interface IncomingLike {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export function createAppRoutes(state: DemoState): {
  handle: (req: IncomingLike) => Promise<RouteResponse>;
} {
  async function handle(req: IncomingLike): Promise<RouteResponse> {
    const u = new URL(req.url, 'http://localhost');
    const path = u.pathname;
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return htmlResponse(renderIndex(state));
    }
    if (req.method === 'POST' && path === '/tasks') {
      return handleAdd(state, req);
    }
    if (req.method === 'POST' && /^\/tasks\/[^/]+\/toggle$/.test(path)) {
      const id = path.split('/')[2] ?? '';
      const t = state.tasks.get(id);
      if (t) {
        state.tasks.set(id, { ...t, done: !t.done });
      }
      return redirect('/');
    }
    if (req.method === 'GET' && path === '/settings') {
      return htmlResponse(renderSettings(state));
    }
    if (req.method === 'GET' && path === '/help') {
      return htmlResponse(renderHelp());
    }
    if (req.method === 'POST' && path === '/settings') {
      // settings form does nothing (dead end)
      return redirect('/settings');
    }
    return {
      status: 404,
      contentType: 'text/plain',
      body: 'not found',
    };
  }
  return { handle };
}

function handleAdd(state: DemoState, req: IncomingLike): RouteResponse {
  const body = req.body ?? '';
  const title = decodeFormField(body, 'title').trim();
  if (!title) {
    return htmlResponse(renderIndex(state, 'Please type a title before adding.'), 400);
  }
  const id = `${state.tasks.size + 1}`;
  state.tasks.set(id, {
    id,
    title,
    createdAt: new Date().toISOString(),
    done: false,
  });
  return redirect('/');
}

function redirect(location: string): RouteResponse {
  return { status: 303, contentType: 'text/plain', body: '', location };
}

function htmlResponse(body: string, status = 200): RouteResponse {
  return { status, contentType: 'text/html; charset=utf-8', body };
}

function renderIndex(state: DemoState, error?: string): string {
  const items = [...state.tasks.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((t) => `<li><span>${escapeHtml(t.title)}</span> <small>${t.done ? 'done' : 'open'}</small> <form method="post" action="/tasks/${t.id}/toggle" style="display:inline"><button type="submit">toggle</button></form></li>`)
    .join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Task Tracker</title></head><body>
<header><h1>Task Tracker</h1></header>
<nav><a href="/">Home</a> | <a href="/settings">Settings</a></nav>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<section>
  <h2>Add a task</h2>
  <form method="post" action="/tasks">
    <input name="title" type="text" placeholder="What needs doing?" autofocus>
    <button type="submit">Add</button>
  </form>
</section>
<section>
  <h2>Your tasks</h2>
  <ul>${items || '<li><em>No tasks yet.</em></li>'}</ul>
</section>
<footer><a href="/help">?</a></footer>
</body></html>`;
}

function renderSettings(state: DemoState): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Settings - Task Tracker</title></head><body>
<header><h1>Settings</h1></header>
<nav><a href="/">Home</a> | <a href="/settings">Settings</a></nav>
<section>
  <p>Theme: ${state.settings.theme}</p>
  <p>Notifications: ${state.settings.notifications ? 'on' : 'off'}</p>
  <form method="post" action="/settings">
    <button type="submit">Save (no effect)</button>
  </form>
  <p><small>Note: settings here are not yet wired up.</small></p>
</section>
</body></html>`;
}

function renderHelp(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Help - Task Tracker</title></head><body>
<header><h1>Help</h1></header>
<nav><a href="/">Home</a> | <a href="/settings">Settings</a></nav>
<section>
  <h2>How to add a task</h2>
  <ol>
    <li>Type a title in the input on the Home page.</li>
    <li>Click "Add".</li>
  </ol>
</section>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function decodeFormField(body: string, field: string): string {
  // application/x-www-form-urlencoded
  if (!body) return '';
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = eq >= 0 ? part.slice(0, eq) : part;
    if (decodeURIComponent(name.replace(/\+/g, ' ')) !== field) continue;
    const val = eq >= 0 ? part.slice(eq + 1) : '';
    return decodeURIComponent(val.replace(/\+/g, ' '));
  }
  return '';
}
