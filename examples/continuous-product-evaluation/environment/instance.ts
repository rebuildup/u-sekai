/**
 * A live, runnable versioned environment (ADR-0011, issue #69).
 *
 * ## Two instances coexist; a transition never mutates one into the other
 *
 * The central modelling decision of this ticket. An earlier reading of
 * "A→B environment transition" would be a single environment whose
 * contents are replaced when it is promoted from version A to version B.
 * That model destroys the thing being measured: once A has been
 * overwritten there is no A left to compare B against, and any evidence
 * gathered against A is now evidence about something that no longer
 * exists.
 *
 * So an `EnvironmentInstance` here is a *separate, simultaneously live*
 * deployment with its own process-local state and its own base URL. A
 * pair is `EnvironmentPair`, and a transition moves the **pointer**
 * between them — it does not touch either instance's state. Both stay
 * addressable for the whole comparison window, which is what lets a
 * returning Synthetic Identity be pointed at B while A remains available
 * as the baseline.
 *
 * ## Isolation is structural, not conventional
 *
 * #69's acceptance criteria require that A and B share no mutable state.
 * The failure this guards is specific and quiet: one leaked reference
 * means a "clean" B silently inherits A's tasks, and then every
 * longitudinal finding is a comparison of a thing against itself while
 * still reporting as a release transition.
 *
 * `assertNoSharedMutableState` below walks the object graphs of both
 * instances and fails on any shared object. It is exported and used in
 * tests so the property is checked rather than assumed — see the
 * isolation test, which also mutates A and asserts B is untouched.
 *
 * ## What an instance deliberately does not have
 *
 * No auth, no accounts, no cross-instance messaging. The demo app
 * (`src/demo/environment`) has none of these and adding them here would
 * be inventing product semantics. An instance is a versioned *fixture*
 * of a deployable, which is all a release-transition acceptance scenario
 * needs. Real provisioning is the World Operator's boundary (#59), which
 * this module neither duplicates nor bypasses.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { createAppRoutes } from '../../../src/demo/environment/app.js';
import { createDemoState, type DemoState } from '../../../src/demo/environment/state.js';
import {
  deriveInstanceKey,
  parseInstanceDeclaration,
  type EnvironmentInstanceKey,
  type InstanceDeclaration,
} from './keys.js';

/** Thrown for contract violations in an environment pair. */
export class EnvironmentIsolationError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'EnvironmentIsolationError';
    this.detail = detail;
  }
}

/**
 * One live versioned environment.
 *
 * The declaration is the durable identity; `baseUrl` and `port` are
 * per-process and deliberately *not* part of it. Two processes starting
 * the same declaration get the same `key` and different ports, which is
 * exactly the intended relationship: identity is stable, location is
 * not.
 */
export interface EnvironmentInstance {
  readonly key: EnvironmentInstanceKey;
  readonly declaration: InstanceDeclaration;
  /** The version label this instance serves. */
  readonly version: string;
  /** Live HTTP origin, once started. */
  readonly baseUrl: string;
  readonly port: number;
  /** The instance's own state. Never shared with another instance. */
  readonly state: DemoState;
  close(): Promise<void>;
}

/**
 * A versioned environment pair: the earlier version and the newer one,
 * both live at once.
 *
 * `active` is the pointer. Reading it does not start, stop or mutate
 * anything; it is the observable answer to "which environment is the
 * cohort on right now".
 */
export interface EnvironmentPair {
  /** The earlier version. Stays live for the whole comparison. */
  readonly before: EnvironmentInstance;
  /** The newer version. */
  readonly after: EnvironmentInstance;
  /** Which instance the cohort is currently pointed at. */
  active(): EnvironmentInstance;
  /**
   * Move the pointer from `before` to `after`. Idempotency and failure
   * recovery are *not* handled here — this is a synchronous pointer
   * swap with no durability. Use `applyTransition` in `transition.ts`,
   * which is the observable, resumable, idempotent path.
   */
  advancePointer(): void;
  closeAll(): Promise<void>;
}

/** Per-instance mutable bookkeeping. Not part of any identity. */
interface InstanceInternals {
  pointerTarget: 'before' | 'after';
  servers: Array<{ close: () => Promise<void> }>;
}

/**
 * Internals keyed by instance key.
 *
 * Deliberately a module-private `Map` rather than a field on
 * `EnvironmentInstance`: the pointer has to be shared between the two
 * instances of a pair, and putting it on either instance would be a
 * reference from A into B's lifecycle. A side table keeps the pair's
 * mutable state out of both instances' own state, which is what makes
 * the "no shared mutable state" assertion above meaningful.
 */
const internals = new Map<EnvironmentInstanceKey, InstanceInternals>();

/**
 * Start one versioned environment on an ephemeral port.
 *
 * Each call builds a *fresh* `DemoState` via `createDemoState()` and a
 * *fresh* route table, so two calls cannot alias. Nothing is shared
 * between them except the immutable, frozen declaration.
 */
export async function startEnvironmentInstance(
  input: unknown,
  field = 'declaration',
): Promise<EnvironmentInstance> {
  const declaration = parseInstanceDeclaration(input, field);
  const key = deriveInstanceKey(declaration);
  const state = createDemoState();
  const routes = createAppRoutes(state);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(routes, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const internalsEntry: InstanceInternals = { pointerTarget: 'before', servers: [] };
  internals.set(key, internalsEntry);

  const instance: EnvironmentInstance = {
    key,
    declaration,
    version: declaration.version,
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    state,
    close: async () => {
      internals.delete(key);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };

  // Registered so closeAll() can tear the pair down even if the caller
  // only kept the pair handle.
  internalsEntry.servers.push({
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  });

  return instance;
}

async function handleRequest(
  routes: ReturnType<typeof createAppRoutes>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
    const resp = await routes.handle({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers,
      body,
    });
    res.writeHead(resp.status, {
      'content-type': resp.contentType,
      ...(resp.location ? { location: resp.location } : {}),
    });
    res.end(resp.body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(err instanceof Error ? err.message : 'internal error');
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Start the two versions of an environment and return the pair.
 *
 * `before` and `after` must differ in `version`; a pair whose two sides
 * are the same version is not a release transition, and accepting it
 * would let #62's `resolveVersionLineage` report `same-version` later
 * with no indication that the pair itself was already wrong.
 */
export async function startEnvironmentPair(
  beforeInput: unknown,
  afterInput: unknown,
): Promise<EnvironmentPair> {
  const beforeDecl = parseInstanceDeclaration(beforeInput, 'before');
  const afterDecl = parseInstanceDeclaration(afterInput, 'after');
  if (beforeDecl.version === afterDecl.version) {
    throw new EnvironmentIsolationError(
      `a versioned pair requires two different versions; both sides declared "${beforeDecl.version}"`,
      'pair.before.version',
    );
  }
  if (deriveInstanceKey(beforeDecl) === deriveInstanceKey(afterDecl)) {
    throw new EnvironmentIsolationError(
      'the two sides of a pair must be distinct instances',
      'pair',
    );
  }

  const before = await startEnvironmentInstance(beforeDecl, 'before');
  const after = await startEnvironmentInstance(afterDecl, 'after');

  assertNoSharedMutableState(before, after);

  return {
    before,
    after,
    active: () => {
      const entry = internals.get(before.key);
      const target = entry?.pointerTarget ?? 'before';
      return target === 'after' ? after : before;
    },
    advancePointer: () => {
      const entry = internals.get(before.key);
      if (!entry) {
        throw new EnvironmentIsolationError(
          'cannot advance the pointer of a closed environment pair',
          'pair',
        );
      }
      entry.pointerTarget = 'after';
    },
    closeAll: async () => {
      await before.close();
      await after.close();
    },
  };
}

/**
 * Assert that two instances share no mutable object.
 *
 * Walks both state graphs and collects every object identity reachable
 * from each. A shared `Map`, array, object or function is a failure.
 *
 * This is deliberately a *structural* check over a behavioural one. A
 * behavioural test ("mutate A, assert B unchanged") passes for an empty
 * environment where nothing has been written yet, and only fails once a
 * test happens to exercise the leaked reference. The graph walk fails
 * immediately whether or not the shared container is currently empty,
 * which is the difference between a property the code has and a property
 * a test happened to observe.
 */
export function assertNoSharedMutableState(a: EnvironmentInstance, b: EnvironmentInstance): void {
  const aObjects = collectObjectIdentities(a.state);
  const bObjects = collectObjectIdentities(b.state);
  for (const identity of aObjects) {
    if (bObjects.has(identity)) {
      throw new EnvironmentIsolationError(
        `environments ${a.key} and ${b.key} share a mutable object; ` +
          'an A→B comparison would compare an environment against itself',
        'isolation',
      );
    }
  }
}

/**
 * Every object reachable from `root`, by reference identity.
 *
 * `Map` keys and values, `Set` members and plain-object values are all
 * followed, because the demo state stores tasks in a `Map` and a leak
 * through any one of them is still a leak.
 */
function collectObjectIdentities(root: unknown): Set<object> {
  const seen = new Set<object>();
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      continue;
    }
    const asObject = current as object;
    if (seen.has(asObject)) continue;
    seen.add(asObject);
    if (current instanceof Map) {
      for (const [k, v] of current) {
        queue.push(k, v);
      }
    } else if (current instanceof Set) {
      for (const v of current) queue.push(v);
    } else if (Array.isArray(current)) {
      queue.push(...current);
    } else {
      for (const v of Object.values(current)) queue.push(v);
    }
  }
  return seen;
}
