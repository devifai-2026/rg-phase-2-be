/**
 * Post-session presence grace + the `connected` contract.
 *
 * Two invariants worth locking down:
 *
 *  1. The grace marker must be tenant-scoped and must DEGRADE TO UNKNOWN (null)
 *     when Redis can't answer — never to `true`, which would keep a genuinely
 *     offline astrologer green, and never crash the end-session path.
 *
 *  2. `connected: true` must not be asserted by anything that isn't holding the
 *     socket. That single mistake is what published a green dot for astrologers
 *     nobody could reach (seeker pays, wallet locks, incoming-request lands in an
 *     empty room). A grep test is crude but it is the guard that actually stops
 *     the bug class from coming back.
 */
const fs = require('fs');
const path = require('path');

const env = require('../config/env');
const cacheService = require('./cacheService');
const presenceRegistry = require('./presenceRegistry');

const ctxFor = (slug) => ({ tenant: { slug } });

describe('post-session grace key', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is namespaced per tenant so one tenant cannot mask another', async () => {
    const store = new Map();
    jest.spyOn(cacheService, 'raw').mockResolvedValue({
      set: async (k) => { store.set(k, '1'); return 'OK'; },
      exists: async (k) => (store.has(k) ? 1 : 0),
      del: async (k) => { store.delete(k); return 1; },
    });

    await presenceRegistry.markPostSessionGrace(ctxFor('rudraganga'), 'u1');

    await expect(presenceRegistry.inPostSessionGrace(ctxFor('rudraganga'), 'u1')).resolves.toBe(true);
    // Same user id, different tenant → must NOT see the other tenant's grace.
    await expect(presenceRegistry.inPostSessionGrace(ctxFor('astrotalk'), 'u1')).resolves.toBe(false);
    expect([...store.keys()][0]).toContain(':rudraganga:sockgrace:u1');
  });

  it('reports UNKNOWN (null), not true, when Redis is unavailable', async () => {
    jest.spyOn(cacheService, 'raw').mockResolvedValue(null);
    await expect(presenceRegistry.inPostSessionGrace(ctxFor('rudraganga'), 'u1')).resolves.toBeNull();
  });

  it('reports UNKNOWN (null) when Redis throws', async () => {
    jest.spyOn(cacheService, 'raw').mockResolvedValue({
      exists: async () => { throw new Error('CONN_BROKEN'); },
    });
    await expect(presenceRegistry.inPostSessionGrace(ctxFor('rudraganga'), 'u1')).resolves.toBeNull();
  });

  it('marking never throws into the end-session path when Redis is down', async () => {
    jest.spyOn(cacheService, 'raw').mockResolvedValue(null);
    await expect(presenceRegistry.markPostSessionGrace(ctxFor('rudraganga'), 'u1')).resolves.toBe(false);
  });

  it('expires via a TTL rather than needing a sweeper', async () => {
    const calls = [];
    jest.spyOn(cacheService, 'raw').mockResolvedValue({
      set: async (k, v, opts) => { calls.push(opts); return 'OK'; },
    });
    await presenceRegistry.markPostSessionGrace(ctxFor('rudraganga'), 'u1');
    expect(calls[0]).toHaveProperty('EX');
    expect(calls[0].EX).toBeGreaterThan(0);
    expect(calls[0].EX).toBe(env.presence.postSessionGraceSec);
  });

  it('clear() removes the marker so an explicit going-away is not masked', async () => {
    const store = new Map();
    jest.spyOn(cacheService, 'raw').mockResolvedValue({
      set: async (k) => { store.set(k, '1'); return 'OK'; },
      exists: async (k) => (store.has(k) ? 1 : 0),
      del: async (k) => { store.delete(k); return 1; },
    });
    await presenceRegistry.markPostSessionGrace(ctxFor('rudraganga'), 'u1');
    await presenceRegistry.clearPostSessionGrace(ctxFor('rudraganga'), 'u1');
    await expect(presenceRegistry.inPostSessionGrace(ctxFor('rudraganga'), 'u1')).resolves.toBe(false);
  });
});

describe('the `connected: true` contract', () => {
  // Only code holding the socket may assert a live connection. The sweeps may
  // pass `connected: false` freely — that can only reduce visibility.
  const ALLOWED = new Set(['websockets/index.js']);

  it('is asserted nowhere outside the socket handlers', () => {
    const root = path.join(__dirname, '..');
    const skip = new Set(['node_modules', '.git', 'coverage', 'dist', 'uploads']);
    const offenders = [];

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;
        const src = fs.readFileSync(full, 'utf8');
        // `connected: true` means "a socket lease exists" and may only be
        // asserted by the socket layer. Presence itself is derived from
        // REACHABILITY (toggle + socket beat or FCM ACK), so no HTTP/service
        // caller ever needs to claim a socket — and a caller that does would
        // resurrect the bug where a seeker saw green with nothing behind it.
        src.split('\n').forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '').trim();
          if (code.startsWith('*') || code.startsWith('/*')) return; // doc block
          if (!/connected:\s*true/.test(code)) return;
          offenders.push(`${rel}:${i + 1}`);
        });
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
