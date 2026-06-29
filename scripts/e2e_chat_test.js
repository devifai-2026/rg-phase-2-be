/**
 * End-to-end chat-session test driven through the real REST + socket layer,
 * exactly as the two apps would. Verifies: request → accept → both-joined
 * handshake (timer/billing start only when both present) → messages both ways →
 * image message → per-minute billing → anonymity alias → end summary + refund.
 *
 * Run while the backend is up on :5050:  node scripts/e2e_chat_test.js
 */
const axios = require('axios');
const { io } = require('socket.io-client');

const BASE = process.env.E2E_BASE || 'http://localhost:5050';
const API = `${BASE}/api`;
const USER_PHONE = '8777468277';
const ASTRO_PHONE = '9674484502';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => { log(`${cond ? '✓' : '✗ FAIL'} ${name}`); if (!cond) failures++; };

async function login(phone) {
  await axios.post(`${API}/auth/request-otp`, { phone });
  const res = await axios.post(`${API}/auth/verify-otp`, { phone, code: '123456' });
  const d = res.data.data;
  return { token: d.accessToken, userId: (d.user && (d.user._id || d.user.id)) };
}

function connect(token, label) {
  const socket = io(BASE, { transports: ['websocket'], auth: { token } });
  socket.onAny((ev, payload) => log(`   [${label}] ⇠ ${ev}`, JSON.stringify(payload).slice(0, 160)));
  return socket;
}

(async () => {
  log('— logging in both parties —');
  const user = await login(USER_PHONE);
  const astro = await login(ASTRO_PHONE);
  check('user logged in', !!user.token);
  check('astrologer logged in', !!astro.token);

  const uSock = connect(user.token, 'USER');
  const aSock = connect(astro.token, 'ASTRO');
  await sleep(800);

  // Astrologer must be online to receive.
  aSock.emit('set-online', { online: true });
  await sleep(500);

  // Capture events.
  const ev = { incoming: null, accepted: { user: false, astro: false }, started: { user: null, astro: null }, userMsgs: [], astroMsgs: [], ended: null };
  aSock.on('incoming-request', (d) => { ev.incoming = d; });
  uSock.on('request-accepted', () => { ev.accepted.user = true; });
  aSock.on('request-accepted', () => { ev.accepted.astro = true; });
  uSock.on('session-started', (d) => { ev.started.user = d; });
  aSock.on('session-started', (d) => { ev.started.astro = d; });
  uSock.on('receive-message', (d) => ev.userMsgs.push(d));
  aSock.on('receive-message', (d) => ev.astroMsgs.push(d));
  uSock.on('session-ended', (d) => { ev.ended = d; });

  log('\n— user requests a CHAT session —');
  const startRes = await axios.post(`${API}/sessions/start`, { astrologerId: astro.userId, type: 'chat' },
    { headers: { Authorization: `Bearer ${user.token}` } });
  const sessionId = startRes.data.data.session.sessionId;
  check('session created (ringing)', startRes.data.data.session.status === 'ringing');
  check('seekerAlias assigned + anonymous', !!startRes.data.data.session.seekerAlias);
  log('   alias:', startRes.data.data.session.seekerAlias, '| sessionId:', sessionId);
  await sleep(700);
  check('astrologer received incoming-request', !!ev.incoming);
  check('incoming-request shows alias, NOT user identity', !!(ev.incoming && ev.incoming.from && ev.incoming.from.alias && !ev.incoming.from.id));

  log('\n— astrologer accepts (room opens; timer NOT started yet) —');
  await axios.post(`${API}/sessions/${sessionId}/accept`, {}, { headers: { Authorization: `Bearer ${astro.token}` } });
  await sleep(700);
  check('both sides got request-accepted', ev.accepted.user && ev.accepted.astro);
  check('session-started NOT fired yet (user has not joined)', !ev.started.user && !ev.started.astro);

  log('\n— user joins the room → both-joined → timer + billing start —');
  uSock.emit('join-session', { sessionId });
  // Wait for session-started (poll up to 5s; the markJoined round-trip + emit).
  for (let i = 0; i < 25 && !(ev.started.user && ev.started.astro); i++) await sleep(200);
  check('session-started fired to BOTH after both joined', !!ev.started.user && !!ev.started.astro);
  check('both got the SAME startedAt (no drift)', ev.started.user && ev.started.astro && ev.started.user.startedAt === ev.started.astro.startedAt);

  log('\n— messages both ways —');
  uSock.emit('send-message', { sessionId, message: 'Namaste, I have a question 🙏' });
  await sleep(500);
  aSock.emit('send-message', { sessionId, message: 'Welcome! Share your birth details.' });
  await sleep(500);
  // Image message (mediaUrl passthrough).
  uSock.emit('send-message', { sessionId, mediaUrl: 'https://i.ibb.co/test/chart.png', mediaType: 'image' });
  await sleep(700);
  check('astrologer received user text message', ev.astroMsgs.some((m) => (m.message || '').includes('Namaste')));
  check('user received astrologer text message', ev.userMsgs.some((m) => (m.message || '').includes('Welcome')));
  check('astrologer received the image (mediaUrl)', ev.astroMsgs.some((m) => m.mediaUrl && m.mediaType === 'image'));

  log('\n— verify billing (minute 1 charged at both-joined) —');
  const detail1 = await axios.get(`${API}/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${user.token}` } });
  const s1 = detail1.data.data;
  check('status ongoing', s1.status === 'ongoing');
  check('billedMinutes >= 1 (minute 1 charged)', s1.billedMinutes >= 1);
  check('totalAmount == ratePerMin * billedMinutes', s1.totalAmount === s1.ratePerMin * s1.billedMinutes);
  log('   billedMinutes:', s1.billedMinutes, '| totalAmount: ₹' + s1.totalAmount, '| rate ₹' + s1.ratePerMin + '/min');

  log('\n— astrologer view is anonymised —');
  const aDetail = await axios.get(`${API}/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${astro.token}` } });
  check('astrologer detail hides real user, shows alias', !aDetail.data.data.user && !!(aDetail.data.data.seeker && aDetail.data.data.seeker.alias));

  log('\n— end the session —');
  await axios.post(`${API}/sessions/${sessionId}/end`, {}, { headers: { Authorization: `Bearer ${user.token}` } });
  await sleep(900);
  check('session-ended received with summary', !!ev.ended && typeof ev.ended.totalAmount === 'number');
  check('summary has durationSec + billedMinutes', ev.ended && ev.ended.durationSec >= 0 && ev.ended.billedMinutes >= 1);
  log('   summary:', JSON.stringify(ev.ended));

  const detail2 = await axios.get(`${API}/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${user.token}` } });
  check('session completed', detail2.data.data.status === 'completed');
  check('astrologerEarning = (rate-adminCut) * minutes', detail2.data.data.astrologerEarning === (s1.ratePerMin - detail2.data.data.adminCutPerMin) * detail2.data.data.billedMinutes);

  uSock.close(); aSock.close();
  log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
