/**
 * emit — cross-tenant leak regression tests.
 *
 * Two rooms used to be global:
 *   - `admin-room`  → every tenant's admins got every other tenant's activity
 *   - `io.emit()`   → astrologer-status was announced to every user of EVERY
 *                     tenant, carrying profileId / isOnline / currentCallStatus
 *
 * These assert the room a payload is addressed to, so a regression fails here
 * rather than silently shipping.
 */
const emit = require('./emit');

/** Minimal io fake that records which room each emit targeted. */
function fakeIo() {
  const sent = [];
  return {
    sent,
    to(room) { return { emit: (event, payload) => sent.push({ room, event, payload }) }; },
    emit(event, payload) { sent.push({ room: '__GLOBAL__', event, payload }); },
  };
}

const ctx = (slug) => ({ tenant: { slug } });

describe('emit tenant scoping', () => {
  let io;
  beforeEach(() => { io = fakeIo(); emit.setIo(io); });
  afterAll(() => emit.setIo(null));

  it('toTenant addresses only the one tenant room — never a global broadcast', () => {
    emit.toTenant(ctx('rudraganga'), 'astrologer-status', { profileId: 'p1', isOnline: true });
    expect(io.sent).toHaveLength(1);
    expect(io.sent[0].room).toBe('tenant:rudraganga');
    // The old behaviour — this is the leak.
    expect(io.sent[0].room).not.toBe('__GLOBAL__');
  });

  it('two tenants never share a fan-out room', () => {
    emit.toTenant(ctx('tenant-a'), 'astrologer-status', {});
    emit.toTenant(ctx('tenant-b'), 'astrologer-status', {});
    expect(io.sent.map((s) => s.room)).toEqual(['tenant:tenant-a', 'tenant:tenant-b']);
  });

  it('toAdmins is scoped per tenant', () => {
    emit.toAdmins(ctx('rudraganga'), 'escalation-raised', { id: 'e1' });
    expect(io.sent[0].room).toBe('admin-room:rudraganga');
  });

  it('adminActivity is scoped per tenant and keeps its payload shape', () => {
    emit.adminActivity(ctx('astrotalk'), 'withdrawal', { id: 'w1', title: 'Withdrawal pending' });
    expect(io.sent[0].room).toBe('admin-room:astrotalk');
    expect(io.sent[0].event).toBe('admin-activity');
    expect(io.sent[0].payload).toEqual({ kind: 'withdrawal', id: 'w1', title: 'Withdrawal pending' });
  });

  it('accepts a ctx, a tenant doc, or a raw slug', () => {
    emit.toTenant(ctx('a'), 'e', {});
    emit.toTenant({ slug: 'b' }, 'e', {});
    emit.toTenant('c', 'e', {});
    expect(io.sent.map((s) => s.room)).toEqual(['tenant:a', 'tenant:b', 'tenant:c']);
  });

  it('user/session/live rooms stay unprefixed (per-tenant ObjectIds cannot collide)', () => {
    emit.toUser('u1', 'incoming-request', {});
    emit.toSession('s1', 'session-started', {});
    emit.toLive('l1', 'live-comment', {});
    expect(io.sent.map((s) => s.room)).toEqual(['user:u1', 'session:s1', 'live:l1']);
  });

  it('broadcastAllTenants is the ONLY path that reaches every socket', () => {
    emit.broadcastAllTenants('server-draining', { instance: 'i1' });
    expect(io.sent[0].room).toBe('__GLOBAL__');
  });

  it('is a safe no-op before io is injected', () => {
    emit.setIo(null);
    expect(() => {
      emit.toTenant(ctx('a'), 'e', {});
      emit.toAdmins(ctx('a'), 'e', {});
      emit.adminActivity(ctx('a'), 'k', {});
    }).not.toThrow();
  });
});
