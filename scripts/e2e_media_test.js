/**
 * E2E for CALL + VIDEO sessions: request → accept (returns Agora token) →
 * both-joined → per-minute billing → end. Recording is server-side (mock unless
 * Agora creds are set). Run with: node scripts/e2e_media_test.js
 */
const axios = require('axios');
const { io } = require('socket.io-client');

const BASE = process.env.E2E_BASE || 'http://localhost:5050';
const API = `${BASE}/api`;
const USER_PHONE = '8777468277';
const ASTRO_PHONE = '9674484502';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, c) => { console.log(`${c ? '✓' : '✗ FAIL'} ${n}`); if (!c) failures++; };

async function login(phone) {
  await axios.post(`${API}/auth/request-otp`, { phone });
  const d = (await axios.post(`${API}/auth/verify-otp`, { phone, code: '123456' })).data.data;
  return { token: d.accessToken, userId: d.user && (d.user._id || d.user.id) };
}

async function runType(type, user, astro) {
  console.log(`\n========== ${type.toUpperCase()} ==========`);
  const uSock = io(BASE, { transports: ['websocket'], auth: { token: user.token } });
  const aSock = io(BASE, { transports: ['websocket'], auth: { token: astro.token } });
  const ev = { started: { u: null, a: null }, acceptToken: null, ended: null };
  uSock.on('session-started', (d) => { ev.started.u = d; });
  aSock.on('session-started', (d) => { ev.started.a = d; });
  uSock.on('session-ended', (d) => { ev.ended = d; });
  await sleep(600);
  aSock.emit('set-online', { online: true });
  await sleep(400);

  const start = await axios.post(`${API}/sessions/start`, { astrologerId: astro.userId, type },
    { headers: { Authorization: `Bearer ${user.token}` } });
  const sessionId = start.data.data.session.sessionId;
  check(`${type}: created ringing`, start.data.data.session.status === 'ringing');
  // Media sessions return a caller token immediately + have agora uids.
  check(`${type}: caller Agora token issued on request`, !!start.data.data.token);
  await sleep(500);

  const acc = await axios.post(`${API}/sessions/${sessionId}/accept`, {}, { headers: { Authorization: `Bearer ${astro.token}` } });
  check(`${type}: accept returns astrologer Agora token`, !!(acc.data.data && acc.data.data.token));
  await sleep(400);

  uSock.emit('join-session', { sessionId });
  for (let i = 0; i < 25 && !(ev.started.u && ev.started.a); i++) await sleep(200);
  check(`${type}: session-started to both, same startedAt`, !!ev.started.u && ev.started.u.startedAt === (ev.started.a && ev.started.a.startedAt));

  const d1 = (await axios.get(`${API}/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${user.token}` } })).data.data;
  check(`${type}: minute 1 billed (totalAmount == rate)`, d1.totalAmount === d1.ratePerMin && d1.billedMinutes === 1);
  check(`${type}: agora uids assigned (channel ready)`, !!(d1.agora && d1.agora.callerUid && d1.agora.receiverUid));
  console.log(`   rate ₹${d1.ratePerMin}/min · billed ${d1.billedMinutes}m · ₹${d1.totalAmount}`);

  await axios.post(`${API}/sessions/${sessionId}/end`, {}, { headers: { Authorization: `Bearer ${user.token}` } });
  await sleep(800);
  check(`${type}: ended with summary`, !!ev.ended && ev.ended.billedMinutes >= 1);
  const d2 = (await axios.get(`${API}/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${user.token}` } })).data.data;
  check(`${type}: completed + astrologer earned (rate-cut)`, d2.status === 'completed' && d2.astrologerEarning === (d2.ratePerMin - d2.adminCutPerMin) * d2.billedMinutes);

  uSock.close(); aSock.close();
  await sleep(300);
}

(async () => {
  const user = await login(USER_PHONE);
  const astro = await login(ASTRO_PHONE);
  await runType('call', user, astro);
  await runType('video', user, astro);
  console.log(`\n${failures === 0 ? '✅ ALL MEDIA CHECKS PASSED' : '❌ ' + failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
