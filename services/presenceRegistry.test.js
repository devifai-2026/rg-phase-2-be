/**
 * presenceRegistry — tenant scoping + the Redis-unavailable degradation contract.
 *
 * These two properties are the ones that would cause real damage if they
 * regressed: a missing tenant segment would let one tenant's presence overwrite
 * another's, and treating "Redis is down" as "offline" would mass-offline every
 * astrologer on the platform at once.
 */
const env = require('../config/env');
const cacheService = require('./cacheService');
const presenceRegistry = require('./presenceRegistry');

const ctxFor = (slug) => ({ tenant: { slug } });

describe('presenceRegistry key scoping', () => {
  it('namespaces the socket lease per tenant', () => {
    expect(presenceRegistry.sockKey(ctxFor('rudraganga'), 'u1'))
      .toBe(`${env.cache.keyPrefix}:rudraganga:sock:u1`);
    expect(presenceRegistry.sockKey(ctxFor('astrotalk'), 'u1'))
      .toBe(`${env.cache.keyPrefix}:astrotalk:sock:u1`);
  });

  it('never collides across tenants for the same user id', () => {
    const a = presenceRegistry.sockKey(ctxFor('tenant-a'), 'same-user');
    const b = presenceRegistry.sockKey(ctxFor('tenant-b'), 'same-user');
    expect(a).not.toBe(b);
  });

  it('refuses to build a key with no tenant in multi-tenant mode', () => {
    const saved = env.saas.enabled;
    env.saas.enabled = true;
    expect(presenceRegistry.sockKey({}, 'u1')).toBeNull();
    env.saas.enabled = saved;
  });

  it('falls back to the "default" slug in single-tenant mode', () => {
    const saved = env.saas.enabled;
    env.saas.enabled = false;
    expect(presenceRegistry.sockKey({}, 'u1'))
      .toBe(`${env.cache.keyPrefix}:default:sock:u1`);
    env.saas.enabled = saved;
  });
});

describe('presenceRegistry degradation contract', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns null (UNKNOWN) — never false — when Redis is unavailable', async () => {
    jest.spyOn(cacheService, 'raw').mockResolvedValue(null);
    // null tells presenceService to fall back to Mongo. Returning false here
    // would mark every astrologer offline the moment Redis blipped.
    await expect(presenceRegistry.isConnected(ctxFor('t'), 'u1')).resolves.toBeNull();
    await expect(presenceRegistry.socketCount(ctxFor('t'), 'u1')).resolves.toBeNull();
  });

  it('returns null (UNKNOWN) when the Redis call throws', async () => {
    jest.spyOn(cacheService, 'raw').mockResolvedValue({
      exists: () => { throw new Error('connection reset'); },
    });
    await expect(presenceRegistry.isConnected(ctxFor('t'), 'u1')).resolves.toBeNull();
  });

  it('reports true only when a lease actually exists', async () => {
    jest.spyOn(cacheService, 'raw').mockResolvedValue({ exists: async () => 1 });
    await expect(presenceRegistry.isConnected(ctxFor('t'), 'u1')).resolves.toBe(true);
  });

  it('reports false when Redis answers that the lease is gone', async () => {
    jest.spyOn(cacheService, 'raw').mockResolvedValue({ exists: async () => 0 });
    await expect(presenceRegistry.isConnected(ctxFor('t'), 'u1')).resolves.toBe(false);
  });

  it('drops the online-set membership when the last socket unregisters', async () => {
    const calls = [];
    jest.spyOn(cacheService, 'raw').mockResolvedValue({
      hDel: async (...a) => calls.push(['hDel', ...a]),
      hLen: async () => 0, // last socket gone
      del: async (...a) => calls.push(['del', ...a]),
      sRem: async (...a) => calls.push(['sRem', ...a]),
    });
    const remaining = await presenceRegistry.unregister(ctxFor('rudraganga'), 'u1', 'sock1');
    expect(remaining).toBe(0);
    expect(calls.some(([op]) => op === 'sRem')).toBe(true);
    // The online-set key must be the tenant-scoped one presenceService reads.
    const sRem = calls.find(([op]) => op === 'sRem');
    expect(sRem[1]).toBe(`${env.cache.keyPrefix}:rudraganga:presence:online-astrologers`);
  });

  it('keeps the user online while another socket survives', async () => {
    const calls = [];
    jest.spyOn(cacheService, 'raw').mockResolvedValue({
      hDel: async () => {},
      hLen: async () => 1, // a second device is still connected
      del: async (...a) => calls.push(['del', ...a]),
      sRem: async (...a) => calls.push(['sRem', ...a]),
    });
    const remaining = await presenceRegistry.unregister(ctxFor('t'), 'u1', 'sock1');
    expect(remaining).toBe(1);
    expect(calls).toHaveLength(0); // must NOT clear the lease or the online set
  });
});
