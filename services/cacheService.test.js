/**
 * cacheService — tenant key isolation and the config-singleton accessor.
 *
 * The key-scoping tests matter because keys used to be `rg:<ns>:<id>` with no
 * tenant segment, and `withCache` is already used for REAL reads (astrologer
 * lists, profiles, recharge packs) — so with the cache enabled, tenant A would
 * have served tenant B's data.
 */
const env = require('../config/env');
const cacheService = require('./cacheService');

const ctx = (slug) => ({
  tenant: { slug },
  model: () => ({ get: async () => ({ toObject: () => ({ callMaxMinutes: 42, _from: slug }) }) }),
});

describe('cacheService key scoping', () => {
  it('includes the tenant slug in every key', () => {
    expect(cacheService.key(ctx('rudraganga'), 'astro', 'list'))
      .toBe(`${env.cache.keyPrefix}:rudraganga:astro:list`);
  });

  it('gives two tenants different keys for the same namespace+id', () => {
    const a = cacheService.key(ctx('tenant-a'), 'astro', 'list:online');
    const b = cacheService.key(ctx('tenant-b'), 'astro', 'list:online');
    expect(a).not.toBe(b);
  });

  it('accepts a raw slug or a tenant doc as well as a ctx', () => {
    const want = `${env.cache.keyPrefix}:acme:astro:x`;
    expect(cacheService.key('acme', 'astro', 'x')).toBe(want);
    expect(cacheService.key({ slug: 'acme' }, 'astro', 'x')).toBe(want);
  });

  it('uses the "default" segment in single-tenant mode', () => {
    const saved = env.saas.enabled;
    env.saas.enabled = false;
    expect(cacheService.key({}, 'astro', 'x'))
      .toBe(`${env.cache.keyPrefix}:default:astro:x`);
    env.saas.enabled = saved;
  });
});

/**
 * With CACHE_ENABLED unset (the default, and the current production state) the
 * cache is a transparent no-op: every read must fall through to the loader and
 * NEVER return stale or cross-tenant data. That is the property worth asserting
 * here — the live cache-hit path is covered by the two-tenant key assertions
 * above plus the on-VM verification, since `healthy` is private module state set
 * only by a real Redis connect.
 */
describe('cacheService.config (singleton accessor)', () => {
  it('falls through to the DB loader when the cache is off/unavailable', async () => {
    const s = await cacheService.config(ctx('rudraganga'), 'AdminSettings');
    expect(s.callMaxMinutes).toBe(42);
    expect(s._from).toBe('rudraganga');
  });

  it('returns each tenant its OWN config when uncached', async () => {
    const a = await cacheService.config(ctx('tenant-a'), 'AdminSettings');
    const b = await cacheService.config(ctx('tenant-b'), 'AdminSettings');
    expect(a._from).toBe('tenant-a');
    expect(b._from).toBe('tenant-b');
  });

  it('is safe to call invalidateConfig with the cache off', async () => {
    await expect(cacheService.invalidateConfig(ctx('rudraganga'), 'AdminSettings'))
      .resolves.not.toThrow();
    await expect(cacheService.invalidateConfig(ctx('rudraganga')))
      .resolves.not.toThrow();
  });

  it('builds a distinct cfg key per tenant (the leak regression)', () => {
    const a = cacheService.key(ctx('tenant-a'), cacheService.CONFIG_NS, 'AdminSettings');
    const b = cacheService.key(ctx('tenant-b'), cacheService.CONFIG_NS, 'AdminSettings');
    expect(a).toBe(`${env.cache.keyPrefix}:tenant-a:cfg:AdminSettings`);
    expect(b).toBe(`${env.cache.keyPrefix}:tenant-b:cfg:AdminSettings`);
    expect(a).not.toBe(b);
  });
});
