/* eslint-disable no-console */
/**
 * API-DRIVEN SEED — exercises every admin/auth/commerce/session endpoint over
 * HTTP so you can see which APIs break. Creates: 10 users (via OTP), 10
 * astrologers, 5 categories × ~10 products, coupons, bundles, poojas (catalog),
 * AI personas, then real activity: recharges, orders, sessions, reviews.
 *
 * Images are uploaded through the real /api/users/upload endpoint using a
 * rotating subset of files from ~/Downloads (so ImageBB + upload are tested).
 *
 * Usage:  node scripts/apiSeed.js        (backend must be running)
 *         BASE_URL=http://localhost:5050 node scripts/apiSeed.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const BASE = (process.env.BASE_URL || 'http://localhost:5050').replace(/\/$/, '') + '/api';
const DEV_OTP = process.env.OTP_DEV_CODE || '123456';
const SUPER_ADMIN_PHONE = '9999900000'; // seeded by scripts/seed.js
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

const http = axios.create({ baseURL: BASE, timeout: 60000 });
let pass = 0, fail = 0;
const failures = [];

// ── tiny test harness ──────────────────────────────────────────────
async function step(label, fn) {
  try {
    const out = await fn();
    pass++;
    console.log(`  ✓ ${label}`);
    return out;
  } catch (e) {
    fail++;
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message;
    failures.push(`${label} → ${msg}`);
    console.log(`  ✗ ${label} → ${msg}`);
    return null;
  }
}

function authHdr(token) { return { headers: { Authorization: `Bearer ${token}` } }; }
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const phone10 = (i) => `9${String(800000000 + i).padStart(9, '0')}`; // 9-prefixed unique 10-digit

// ── auth: OTP login, returns access token + user ────────────────────
async function login(phone) {
  await http.post('/auth/request-otp', { phone });
  const { data } = await http.post('/auth/verify-otp', { phone, code: DEV_OTP });
  return data.data; // { accessToken, refreshToken, user }
}

// ── image upload via real API (rotating Downloads subset) ───────────
function pickImages(n) {
  let files = [];
  try {
    files = fs.readdirSync(DOWNLOADS).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f)).slice(0, n);
  } catch { /* no downloads */ }
  return files.map((f) => path.join(DOWNLOADS, f));
}
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
async function uploadImage(filePath, token) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const fd = new FormData();
  // Set the Blob MIME type so multer's image fileFilter accepts it.
  fd.append('image', new Blob([buf], { type: MIME[ext] || 'image/jpeg' }), path.basename(filePath).replace(/[^\w.\-]/g, '_'));
  const { data } = await http.post('/users/upload', fd, authHdr(token));
  return data.data.url;
}

// ── data pools ──────────────────────────────────────────────────────
const FIRST = ['Aarav', 'Vivaan', 'Ananya', 'Diya', 'Kabir', 'Ishaan', 'Saanvi', 'Riya', 'Arjun', 'Myra', 'Reyansh', 'Aadhya', 'Vihaan', 'Anika', 'Krishna', 'Pari', 'Rohan', 'Sara', 'Dev', 'Tara'];
const EXPERTISE = ['Vedic', 'Numerology', 'Tarot', 'Vastu', 'Palmistry', 'Lal Kitab', 'KP'];
const LANGS = ['Hindi', 'English', 'Tamil', 'Telugu', 'Marathi', 'Bengali'];
const CITIES = [['Mumbai', 'MH', '400001'], ['Delhi', 'DL', '110001'], ['Bengaluru', 'KA', '560001'], ['Pune', 'MH', '411001'], ['Jaipur', 'RJ', '302001']];
// Unique-ish names to avoid colliding with base seed.js categories.
const CATEGORIES = ['Gemstones & Crystals', 'Rudraksha Beads', 'Sacred Yantras', 'Puja Samagri', 'Brass Idols'];
const POOJAS = ['Griha Pravesh', 'Satyanarayan Katha', 'Navagraha Shanti', 'Maha Mrityunjaya'];
const PERSONAS = [
  { name: 'Acharya Veda', tagline: 'Vedic remedies, any hour', expertise: ['Vedic'], systemPrompt: 'You are a warm Vedic astrologer focused on practical remedies.' },
  { name: 'Tara AI', tagline: 'Tarot & intuition', expertise: ['Tarot'], systemPrompt: 'You are an intuitive tarot reader; gentle and encouraging.' },
  { name: 'Numero Guru', tagline: 'Numbers reveal all', expertise: ['Numerology'], systemPrompt: 'You explain life through numerology with clarity.' },
];

(async () => {
  console.log(`\n▶ API seed against ${BASE}\n`);

  // 0. health
  await step('health check', async () => http.get(BASE.replace('/api', '') + '/healthz'));

  // 1. super-admin login
  const admin = await step('super-admin login (OTP)', () => login(SUPER_ADMIN_PHONE));
  if (!admin) { console.log('\nCannot proceed without admin. Is the backend running + seeded (npm run seed)?\n'); return summary(); }
  const A = authHdr(admin.accessToken);

  // 2. upload a rotating set of images via the real API
  console.log('\n• Uploading images via /api/users/upload …');
  const localImgs = pickImages(12);
  const urls = [];
  for (const f of localImgs) {
    const u = await step(`upload ${path.basename(f).slice(0, 30)}`, () => uploadImage(f, admin.accessToken));
    if (u) urls.push(u);
  }
  const img = (i) => (urls.length ? urls[i % urls.length] : 'https://placehold.co/600x600?text=RG');

  // 3. ten users via real OTP flow
  console.log('\n• Creating 10 users (OTP signup) …');
  const users = [];
  for (let i = 0; i < 10; i++) {
    const ph = phone10(i);
    const u = await step(`user ${ph} signup`, async () => {
      const auth = await login(ph);
      // set name + birth details via /auth/me
      await http.put('/auth/me', { name: `${FIRST[i]} ${rand(['Sharma', 'Verma', 'Iyer', 'Khan', 'Reddy'])}`, email: `${FIRST[i].toLowerCase()}${i}@example.com`, birthDetails: { dob: '1995-08-15', time: '08:30', place: 'Mumbai' } }, authHdr(auth.accessToken));
      return auth;
    });
    if (u) users.push(u);
  }

  // 4. ten astrologers via admin create
  console.log('\n• Creating 10 astrologers (admin) …');
  const astrologers = [];
  for (let i = 0; i < 10; i++) {
    const [city, state, pin] = rand(CITIES);
    const body = {
      name: `Pandit ${FIRST[(i + 5) % FIRST.length]}`,
      phone: phone10(100 + i),
      email: `astro${i}@example.com`,
      avatar: img(i),
      expertise: [rand(EXPERTISE), rand(EXPERTISE)],
      languages: [rand(LANGS), 'English'],
      experienceYears: 3 + i,
      applicationStatus: 'active',
      kycStatus: 'approved',
      isFeatured: i < 3,
      acceptsFreeChat: i % 2 === 0,
      location: { address: `${10 + i} Temple Road`, city, state, pincode: pin },
      rates: {
        call: { enabled: true, rateRupeesPerMin: 10 + i, adminCutRupeesPerMin: 2 },
        chat: { enabled: true, rateRupeesPerMin: 6 + i, adminCutRupeesPerMin: 1 },
        video: { enabled: true, rateRupeesPerMin: 15 + i, adminCutRupeesPerMin: 3 },
      },
    };
    const a = await step(`astrologer ${body.name}`, async () => (await http.post('/admin/astrologers', body, A)).data.data);
    if (a) astrologers.push(a);
  }

  // 5. categories + 10 products each
  console.log('\n• Creating 5 categories × 10 products …');
  const catIds = [];
  for (const name of CATEGORIES) {
    const c = await step(`category ${name}`, async () => (await http.post('/admin/categories', { name, image: img(catIds.length), isActive: true }, A)).data.data);
    if (c) catIds.push(c._id);
  }
  const products = [];
  for (let ci = 0; ci < catIds.length; ci++) {
    for (let p = 0; p < 10; p++) {
      const mrp = 500 + p * 250 + ci * 100;
      const body = { name: `${CATEGORIES[ci]} Item ${p + 1}`, category: catIds[ci], description: 'Authentic, lab-certified.', priceRupees: Math.round(mrp * 0.85), mrpRupees: mrp, stock: p === 0 ? 5 : 20 + p, images: [img(p + ci)] };
      const pr = await step(`product ${body.name}`, async () => (await http.post('/admin/products', body, A)).data.data);
      if (pr) products.push(pr);
    }
  }

  // 6. coupons (4)
  console.log('\n• Creating coupons …');
  await step('coupon SAVE20', () => http.post('/admin/coupons', { code: 'SAVE20', type: 'percentage', value: 20, maxDiscount: 200, minOrderValue: 500, scope: 'all', isActive: true }, A));
  await step('coupon FLAT100', () => http.post('/admin/coupons', { code: 'FLAT100', type: 'flat', value: 100, minOrderValue: 800, scope: 'all', isActive: true }, A));
  await step('coupon GEM15', () => http.post('/admin/coupons', { code: 'GEM15', type: 'percentage', value: 15, scope: 'category', targets: [catIds[0]], isActive: true }, A));
  await step('coupon NEW50', () => http.post('/admin/coupons', { code: 'NEW50', type: 'flat', value: 50, perUserLimit: 1, scope: 'all', isActive: true }, A));

  // 7. bundles (3)
  console.log('\n• Creating bundles …');
  for (let i = 0; i < 3 && products.length >= 3; i++) {
    const picks = [products[i], products[i + 1], products[i + 2]].map((p) => p._id);
    await step(`bundle ${i + 1}`, () => http.post('/admin/bundles', { name: `Combo Pack ${i + 1}`, products: picks, anchorProduct: picks[0], pricingMode: 'percent', discountPercent: 10 + i * 5, isActive: true }, A));
  }

  // 8. pooja catalog (4)
  console.log('\n• Creating pooja catalog …');
  for (let i = 0; i < POOJAS.length; i++) {
    await step(`pooja ${POOJAS[i]}`, () => http.post('/admin/pooja-types', { name: POOJAS[i], description: 'Performed by verified pandits.', basePrice: 1100 + i * 700, durationNote: 'approx 1 hr', image: img(i + 3), isActive: true }, A));
  }

  // 9. AI personas (3)
  console.log('\n• Creating AI personas …');
  for (let i = 0; i < PERSONAS.length; i++) {
    await step(`AI persona ${PERSONAS[i].name}`, () => http.post('/admin/ai-personas', { ...PERSONAS[i], avatar: img(i), isActive: true }, A));
  }

  // 10. activity — recharge wallets, place orders, run sessions
  console.log('\n• Generating activity (recharges, orders, sessions) …');
  // recharge first 6 users (admin manual)
  for (let i = 0; i < Math.min(6, users.length); i++) {
    await step(`recharge ${users[i].user.name || users[i].user.phone}`, () => http.post('/admin/users/recharge', { userId: users[i].user._id, amountRupees: 500 + i * 200, reason: 'Seed credit' }, A));
  }
  // orders by first 5 users (fetch fresh name via /auth/me)
  for (let i = 0; i < Math.min(5, users.length) && products.length >= 2; i++) {
    const u = users[i];
    const me = (await http.get('/auth/me', authHdr(u.accessToken))).data.data;
    const items = [{ productId: products[i]._id, qty: 1 }, { productId: products[i + 1]._id, qty: 2 }];
    await step(`order by ${me.name || me.phone}`, () => http.post('/orders', { items, address: { name: me.name || 'User', phone: phone10(i), line1: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' } }, authHdr(u.accessToken)));
  }
  // sessions: a few completed call/chat between users and astrologers.
  // The astrologer must be ONLINE to receive — toggle via their own token first.
  if (users.length && astrologers.length) {
    for (let i = 0; i < 4; i++) {
      const seeker = users[i];
      const astroIdx = i % astrologers.length;
      const astro = astrologers[astroIdx];
      const type = ['call', 'chat', 'video', 'chat'][i];
      await step(`session ${type} #${i + 1}`, async () => {
        const astroAuth = await login(phone10(100 + astroIdx));
        await http.post('/astrologers/me/online', { online: true }, authHdr(astroAuth.accessToken)); // go online
        const start = (await http.post('/sessions/start', { astrologerId: astro.user, type }, authHdr(seeker.accessToken))).data.data;
        const sid = start.session.sessionId;
        await http.post(`/sessions/${sid}/accept`, {}, authHdr(astroAuth.accessToken));
        await new Promise((r) => setTimeout(r, 1500));
        await http.post(`/sessions/${sid}/end`, {}, authHdr(seeker.accessToken));
        await http.post(`/sessions/${sid}/review`, { rating: 4 + (i % 2), comment: 'Very helpful!' }, authHdr(seeker.accessToken)).catch(() => {});
        return sid;
      });
    }
  }

  // 11. read-back: hit the dashboards/lists the admin UI uses
  console.log('\n• Reading back admin views …');
  await step('GET dashboard', () => http.get('/admin/dashboard', A));
  await step('GET leaderboard', () => http.get('/admin/leaderboard', A));
  await step('GET transactions', () => http.get('/admin/transactions?limit=10', A));
  await step('GET users list', () => http.get('/admin/users?limit=50', A));
  await step('GET astrologers list', () => http.get('/admin/astrologers?limit=50', A));
  await step('GET orders', () => http.get('/admin/orders', A));
  await step('GET pooja-bookings', () => http.get('/admin/pooja-bookings', A));
  if (users[0]) await step('GET user detail', () => http.get(`/admin/users/${users[0].user._id}`, A));
  if (astrologers[0]) await step('GET astrologer full', () => http.get(`/admin/astrologers/${astrologers[0]._id}/full`, A));

  summary();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });

function summary() {
  console.log(`\n──────────────────────────────`);
  console.log(`✓ ${pass} passed   ✗ ${fail} failed`);
  if (failures.length) {
    console.log('\nFailing endpoints:');
    failures.forEach((f) => console.log('  • ' + f));
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}
