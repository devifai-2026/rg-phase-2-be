(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function revealAll() {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  /* ============================================================
     FIRST-PARTY TRACKING + LEAD FORMS
     anonId cookie → visit + click heatmap + duration + form funnel.
     All POST to /api/track and /api/enquiries (same-origin).
     ============================================================ */
  var API = '/api';

  function getCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function anonId() {
    var id = getCookie('rg_anon') || localStorage.getItem('rg_anon');
    if (!id) {
      id = 'a_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      var exp = new Date(Date.now() + 730 * 864e5).toUTCString();
      document.cookie = 'rg_anon=' + id + '; expires=' + exp + '; path=/; SameSite=Lax';
      try { localStorage.setItem('rg_anon', id); } catch (e) {}
    }
    return id;
  }
  var AID = anonId();
  window.__rgAnonId = AID;

  function post(path, body, keepalive) {
    try {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: !!keepalive,
      });
    } catch (e) { return Promise.resolve(); }
  }
  function track(path, body, keepalive) { return post('/track' + path, body, keepalive); }

  // Suppress all tracking when the page is loaded inside the admin heatmap
  // preview (?heatmap=1) or otherwise framed — so viewing the heatmap never
  // pollutes the data it's showing.
  var SUPPRESS_TRACKING =
    /[?&]heatmap=1/.test(window.location.search) ||
    (function () { try { return window.self !== window.top; } catch (e) { return true; } })();

  // When embedded in the admin heatmap preview, report our full document
  // height to the parent so it can size the overlay stage to the whole page.
  (function reportHeight() {
    if (window.self === window.top) return;
    var send = function () {
      var h = Math.max(
        document.body.scrollHeight, document.documentElement.scrollHeight,
        document.body.offsetHeight, document.documentElement.offsetHeight
      );
      try { window.parent.postMessage({ type: 'rg-page-height', height: h }, '*'); } catch (e) {}
    };
    window.addEventListener('load', send);
    setTimeout(send, 400);
    setTimeout(send, 1500); // after fonts/images settle
    window.addEventListener('resize', send);
  })();

  (function tracking() {
    if (SUPPRESS_TRACKING) return;
    var q = new URLSearchParams(window.location.search);
    // 1. record the visit (with any UTM params)
    track('/visit', {
      anonId: AID,
      utm_source: q.get('utm_source') || '',
      utm_medium: q.get('utm_medium') || '',
      utm_campaign: q.get('utm_campaign') || '',
      utm_content: q.get('utm_content') || '',
      utm_term: q.get('utm_term') || '',
      landingPath: window.location.pathname,
      referrer: document.referrer || '',
    });

    // 2. batch clicks → heatmap
    var buf = [];
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      var r = t.getBoundingClientRect();
      var docH = document.documentElement.scrollHeight || window.innerHeight;
      var x = ((r.left + r.width / 2) / window.innerWidth) * 100;
      var y = ((r.top + r.height / 2 + window.scrollY) / docH) * 100;
      var label = (t.getAttribute && (t.getAttribute('aria-label') || '')) || (t.textContent || '');
      buf.push({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        vw: window.innerWidth,
        path: window.location.pathname,
        label: label.trim().slice(0, 60),
      });
      if (buf.length >= 8) flush();
    }, { passive: true });

    function flush(keepalive) {
      if (!buf.length) return;
      var batch = buf.splice(0, 100);
      track('/click', { anonId: AID, clicks: batch }, keepalive);
    }
    setInterval(function () { flush(); }, 8000);

    // 3. time-on-page (sent on leave)
    var start = Date.now();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        flush(true);
        track('/duration', { anonId: AID, durationSec: Math.round((Date.now() - start) / 1000) }, true);
      }
    });
  })();

  // form-funnel step helper
  function formEvent(form, step, detail) {
    if (SUPPRESS_TRACKING) return;
    track('/signup-event', { anonId: AID, form: form, step: step, detail: detail || '' });
  }

  /* ---- lead form wiring (contact + astrologer apply) ---- */
  (function leadForms() {
    function bind(formId, msgId, formName, onBuild, endpoint, method) {
      var form = document.getElementById(formId);
      if (!form) return;
      var msg = document.getElementById(msgId);
      var started = false;
      formEvent(formName, 'form_view');
      form.addEventListener('input', function () {
        if (!started) { started = true; formEvent(formName, 'form_start'); }
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = form.querySelector('.submit');
        var payload = onBuild(form);
        if (payload.__error) { msg.textContent = payload.__error; msg.className = 'fmsg err'; return; }
        formEvent(formName, 'form_submit');
        btn.disabled = true; msg.textContent = 'Sending…'; msg.className = 'fmsg';
        post(endpoint, payload).then(function (res) {
          return res && res.json ? res.json() : {};
        }).then(function (data) {
          if (data && data.success) {
            msg.textContent = data.message || 'Thank you — we’ll be in touch.';
            msg.className = 'fmsg ok';
            form.reset();
            formEvent(formName, 'completed');
          } else {
            msg.textContent = (data && data.message) || 'Something went wrong. Please try again.';
            msg.className = 'fmsg err';
            btn.disabled = false;
            formEvent(formName, 'error', (data && data.message) || '');
          }
        }).catch(function () {
          msg.textContent = 'Network error. Please try again.';
          msg.className = 'fmsg err'; btn.disabled = false;
          formEvent(formName, 'error', 'network');
        });
      });
    }

    var val = function (form, name) { var el = form.elements[name]; return el ? el.value.trim() : ''; };

    bind('contactForm', 'contactMsg', 'contact', function (form) {
      var name = val(form, 'name'), message = val(form, 'message');
      var email = val(form, 'email'), phone = val(form, 'phone');
      if (!name || !message) return { __error: 'Please add your name and a message.' };
      if (!email && !phone) return { __error: 'Add an email or phone so we can reply.' };
      return { name: name, email: email, phone: phone, subject: val(form, 'subject'), message: message, anonId: AID };
    }, '/enquiries');

    bind('astroForm', 'astroMsg', 'astrologer_apply', function (form) {
      var name = val(form, 'name'), phone = val(form, 'phone');
      if (!name) return { __error: 'Please add your name.' };
      if (!/^\d{10}$/.test(phone)) return { __error: 'Enter a valid 10-digit phone number.' };
      var expertise = val(form, 'expertise');
      var exp = parseInt(val(form, 'experienceYears'), 10);
      var body = { name: name, phone: phone, anonId: AID, note: val(form, 'note') };
      var email = val(form, 'email'); if (email) body.email = email;
      if (expertise) body.expertise = expertise.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!isNaN(exp)) body.experienceYears = exp;
      return body;
    }, '/astrologers/apply');
  })();

  /* ---- nav background on scroll ---- */
  var nav = document.getElementById('nav');
  if (nav) {
    var navScroll = function () { nav.classList.toggle('scrolled', window.pageYOffset > 30); };
    navScroll();
    window.addEventListener('scroll', navScroll, { passive: true });
  }

  /* ---- hero cosmic background: starfield + orrery ---- */
  (function cosmicHero() {
    var header = document.getElementById('top');
    var starCv = document.getElementById('stars');
    var orrCv = document.getElementById('orrery');
    if (!header || !starCv || !orrCv) return;

    var sx = starCv.getContext('2d');
    var ox = orrCv.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0, stars = [];
    var glyphs = ['♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓'];
    // little constellations (unit coords, scaled to a ring radius)
    var consts = [
      [[-0.55,-0.12],[-0.38,-0.30],[-0.16,-0.10],[0.04,-0.30],[0.22,-0.08]],
      [[-0.30,0.40],[-0.12,0.30],[0.04,0.46],[0.22,0.34],[0.30,0.52]],
      [[0.34,0.10],[0.50,0.00],[0.62,0.16],[0.52,0.30]]
    ];

    function resize() {
      W = header.clientWidth; H = header.clientHeight;
      [starCv, orrCv].forEach(function (cv) {
        cv.width = W * dpr; cv.height = H * dpr;
        cv.style.width = W + 'px'; cv.style.height = H + 'px';
      });
      sx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ox.setTransform(dpr, 0, 0, dpr, 0, 0);
      // re-seed stars
      var n = Math.min(260, Math.floor(W * H / 6500));
      stars = [];
      for (var i = 0; i < n; i++) {
        stars.push({ x: Math.random() * W, y: Math.random() * H,
          r: Math.random() * 1.4 + 0.2, tw: Math.random() * Math.PI * 2,
          sp: Math.random() * 0.7 + 0.2, b: Math.random() * 0.5 + 0.5 });
      }
    }

    // orrery centre: right side, vertically centred
    function centre() { return { cx: W * (W > 900 ? 0.72 : 0.5), cy: H * 0.52, R: Math.min(W * 0.32, H * 0.42, 360) }; }

    function paintStars(t) {
      sx.clearRect(0, 0, W, H);
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var a = s.b * (0.45 + 0.55 * Math.abs(Math.sin(t * 0.001 * s.sp + s.tw)));
        sx.beginPath(); sx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        sx.fillStyle = 'rgba(244,239,230,' + a + ')'; sx.fill();
      }
    }

    function paintOrrery(t) {
      ox.clearRect(0, 0, W, H);
      var C = centre(); var cx = C.cx, cy = C.cy, R = C.R;
      ox.save(); ox.translate(cx, cy);

      // faint orbit rings
      var rings = [0.42, 0.6, 0.78, 0.95, 1.12];
      for (var i = 0; i < rings.length; i++) {
        ox.beginPath(); ox.arc(0, 0, R * rings[i], 0, Math.PI * 2);
        ox.strokeStyle = 'rgba(244,239,230,' + (0.10 - i * 0.012) + ')';
        ox.lineWidth = 1; ox.setLineDash(i % 2 ? [2, 6] : []); ox.stroke();
      }
      ox.setLineDash([]);

      // zodiac glyph rim
      ox.font = (R * 0.085) + 'px serif'; ox.textAlign = 'center'; ox.textBaseline = 'middle';
      var rimRot = t * 0.00004;
      for (var g = 0; g < 12; g++) {
        var ga = g * (Math.PI * 2 / 12) + rimRot;
        var gx = Math.cos(ga) * R * 1.22, gy = Math.sin(ga) * R * 1.22;
        ox.fillStyle = 'rgba(240,183,174,0.5)';
        ox.fillText(glyphs[g], gx, gy);
      }
      // rim tick marks
      ox.save(); ox.rotate(rimRot);
      for (var k = 0; k < 60; k++) {
        ox.beginPath(); ox.moveTo(R * 1.12, 0); ox.lineTo(R * (k % 5 ? 1.09 : 1.06), 0);
        ox.strokeStyle = 'rgba(244,239,230,0.18)'; ox.lineWidth = 1; ox.stroke();
        ox.rotate(Math.PI * 2 / 60);
      }
      ox.restore();

      // constellations on the rings
      consts.forEach(function (pts, ci) {
        ox.beginPath();
        pts.forEach(function (p, pi) {
          var px = p[0] * R * 2.0, py = p[1] * R * 2.0;
          if (pi === 0) ox.moveTo(px, py); else ox.lineTo(px, py);
        });
        ox.strokeStyle = ci === 0 ? 'rgba(240,183,174,0.4)' : (ci === 1 ? 'rgba(160,190,160,0.35)' : 'rgba(150,170,210,0.35)');
        ox.lineWidth = 1.2; ox.stroke();
        pts.forEach(function (p) {
          ox.beginPath(); ox.arc(p[0] * R * 2.0, p[1] * R * 2.0, 2, 0, Math.PI * 2);
          ox.fillStyle = 'rgba(255,255,255,0.85)'; ox.fill();
        });
      });

      // a couple of orbiting planets (crimson + gold) for life
      var p1 = t * 0.0004, p2 = -t * 0.00026 + 1.6;
      [[R * 0.6, p1, '#F0B7AE', 4], [R * 0.95, p2, '#D9A441', 5], [R * 0.78, t * 0.0003 + 3, '#7FA37F', 3]].forEach(function (pl) {
        var x = Math.cos(pl[1]) * pl[0], y = Math.sin(pl[1]) * pl[0];
        var gl = ox.createRadialGradient(x, y, 0, x, y, pl[3] * 3);
        gl.addColorStop(0, pl[2]); gl.addColorStop(1, 'rgba(0,0,0,0)');
        ox.fillStyle = gl; ox.beginPath(); ox.arc(x, y, pl[3] * 3, 0, Math.PI * 2); ox.fill();
        ox.fillStyle = pl[2]; ox.beginPath(); ox.arc(x, y, pl[3], 0, Math.PI * 2); ox.fill();
      });

      // glowing central sun (crimson→gold, the Rudraganga accent)
      var pulse = reduce ? 1 : (1 + Math.sin(t * 0.002) * 0.04);
      var sunR = R * 0.16 * pulse;
      var halo = ox.createRadialGradient(0, 0, sunR * 0.4, 0, 0, sunR * 4);
      halo.addColorStop(0, 'rgba(232,140,80,0.5)');
      halo.addColorStop(0.5, 'rgba(192,57,43,0.18)');
      halo.addColorStop(1, 'rgba(192,57,43,0)');
      ox.fillStyle = halo; ox.beginPath(); ox.arc(0, 0, sunR * 4, 0, Math.PI * 2); ox.fill();
      var body = ox.createRadialGradient(-sunR * 0.3, -sunR * 0.3, sunR * 0.2, 0, 0, sunR);
      body.addColorStop(0, '#FCE3B0'); body.addColorStop(0.5, '#F2A93B'); body.addColorStop(1, '#C0392B');
      ox.fillStyle = body; ox.beginPath(); ox.arc(0, 0, sunR, 0, Math.PI * 2); ox.fill();
      ox.restore();
    }

    function frame(t) { paintStars(t); paintOrrery(t); if (!reduce) requestAnimationFrame(frame); }

    resize();
    window.addEventListener('resize', resize, { passive: true });
    if (reduce) { paintStars(0); paintOrrery(0); }
    else requestAnimationFrame(frame);
  })();

  /* ---- audio call waveform bars ---- */
  (function waveform() {
    var wrap = document.getElementById('wave');
    if (!wrap) return;
    var N = 26, bars = [];
    for (var i = 0; i < N; i++) { var b = document.createElement('i'); wrap.appendChild(b); bars.push(b); }
    if (reduce) { bars.forEach(function (b) { b.style.height = '40%'; }); return; }
    var f = 0;
    (function tick() {
      f += 0.12;
      for (var i = 0; i < N; i++) {
        var h = 18 + (Math.sin(f + i * 0.6) * 0.5 + 0.5) * 70;
        bars[i].style.height = h + '%';
      }
      requestAnimationFrame(tick);
    })();
  })();

  /* ---- testimonials marquee: JS-driven auto-scroll (robust vs CSS strip) ---- */
  (function testimonialMarquee() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('.tmarquee .trow'));
    if (!rows.length) return;
    if (reduce) return;                       // reduced-motion: leave as manual scroll strip
    document.documentElement.classList.add('js-marquee');  // disable the CSS-keyframe fallback

    var sect = document.querySelector('.tsection');
    var paused = false;
    if (sect) {
      sect.addEventListener('mouseenter', function () { paused = true; });
      sect.addEventListener('mouseleave', function () { paused = false; });
    }

    var state = rows.map(function (row, i) {
      // each row's content is duplicated, so half its width is one full loop
      return { row: row, x: 0, half: row.scrollWidth / 2, speed: (i % 2 === 0 ? -0.45 : 0.45) };
    });
    // start the reverse row shifted so it scrolls the other way from a filled position
    state.forEach(function (s) { if (s.speed > 0) s.x = -s.half; });

    var last = 0;
    function step(t) {
      var dt = last ? Math.min(t - last, 50) : 16; last = t;
      if (!paused) {
        state.forEach(function (s) {
          if (!s.half) s.half = s.row.scrollWidth / 2;   // re-measure if it was 0 at start
          s.x += s.speed * dt * 0.06;
          if (s.x <= -s.half) s.x += s.half;
          if (s.x >= 0) s.x -= s.half;
          s.row.style.transform = 'translateX(' + s.x + 'px)';
        });
      }
      requestAnimationFrame(step);
    }
    // wait a frame so scrollWidth is measured after layout/images
    requestAnimationFrame(function () {
      state.forEach(function (s) { s.half = s.row.scrollWidth / 2; if (s.speed > 0) s.x = -s.half; });
      requestAnimationFrame(step);
    });
  })();

  /* ---- cursor-follow glow ---- */
  (function cursorGlow() {
    var el = document.getElementById('cursor-glow');
    if (!el || reduce || !window.matchMedia('(hover:hover)').matches) { if (el) el.style.display = 'none'; return; }
    var tx = window.innerWidth / 2, ty = window.innerHeight / 2, x = tx, y = ty;
    window.addEventListener('pointermove', function (e) { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function loop() {
      x += (tx - x) * 0.12; y += (ty - y) * 0.12;
      el.style.transform = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-50%)';
      requestAnimationFrame(loop);
    })();
  })();

  /* ---- daily horoscope zodiac picker ---- */
  (function horoscope() {
    var wheel = document.getElementById('wheel');
    if (!wheel) return;
    var signs = [
      { g: '♈', name: 'Aries', el: 'Fire · Mar 21 – Apr 19', mood: 'Bold', love: 4, career: 5, money: 3, num: 9, color: '#C0392B', line: 'Move first today — momentum is on your side and hesitation costs more than a wrong turn.' },
      { g: '♉', name: 'Taurus', el: 'Earth · Apr 20 – May 20', mood: 'Grounded', love: 3, career: 4, money: 4, num: 6, color: '#2a9d52', line: 'Being your true self today will open a door you have been circling for weeks.' },
      { g: '♊', name: 'Gemini', el: 'Air · May 21 – Jun 20', mood: 'Curious', love: 4, career: 3, money: 3, num: 5, color: '#D9A441', line: 'A conversation you almost skip turns out to be the one that matters. Pick up.' },
      { g: '♋', name: 'Cancer', el: 'Water · Jun 21 – Jul 22', mood: 'Tender', love: 5, career: 3, money: 4, num: 2, color: '#6C8EBF', line: 'Trust the feeling you keep talking yourself out of. It has been right all along.' },
      { g: '♌', name: 'Leo', el: 'Fire · Jul 23 – Aug 22', mood: 'Radiant', love: 4, career: 5, money: 3, num: 1, color: '#E08A3D', line: 'Your warmth is the strategy today — lead with it and the room follows.' },
      { g: '♍', name: 'Virgo', el: 'Earth · Aug 23 – Sep 22', mood: 'Focused', love: 3, career: 5, money: 4, num: 5, color: '#4F7942', line: 'The small fix you keep postponing unlocks the big thing. Start there.' },
      { g: '♎', name: 'Libra', el: 'Air · Sep 23 – Oct 22', mood: 'Balanced', love: 5, career: 3, money: 3, num: 6, color: '#C77FB3', line: 'Stop weighing it. The choice that feels lighter is the one to make.' },
      { g: '♏', name: 'Scorpio', el: 'Water · Oct 23 – Nov 21', mood: 'Intense', love: 4, career: 4, money: 4, num: 8, color: '#8B0000', line: 'A truth surfaces today. Let it — what it clears away was never serving you.' },
      { g: '♐', name: 'Sagittarius', el: 'Fire · Nov 22 – Dec 21', mood: 'Restless', love: 3, career: 4, money: 3, num: 3, color: '#9C4DCC', line: 'Say yes to the thing slightly outside your map. That is exactly where it is.' },
      { g: '♑', name: 'Capricorn', el: 'Earth · Dec 22 – Jan 19', mood: 'Steady', love: 3, career: 5, money: 5, num: 4, color: '#5D4037', line: 'Patience is paying off in a way you cannot see yet. Keep climbing.' },
      { g: '♒', name: 'Aquarius', el: 'Air · Jan 20 – Feb 18', mood: 'Inventive', love: 4, career: 4, money: 3, num: 7, color: '#0277BD', line: 'Your odd idea is the right idea. Stop translating it for people who will not get it.' },
      { g: '♓', name: 'Pisces', el: 'Water · Feb 19 – Mar 20', mood: 'Dreamy', love: 5, career: 3, money: 3, num: 2, color: '#26A69A', line: 'Follow the daydream a little further today — it is pointing somewhere real.' }
    ];
    var $ = function (id) { return document.getElementById(id); };
    function stars(n) {
      var s = '';
      for (var i = 0; i < 5; i++) s += '<span class="' + (i < n ? 'on' : 'off') + '">★</span>';
      return s;
    }
    function select(i) {
      var d = signs[i];
      wheel.querySelectorAll('.sign').forEach(function (b) { b.classList.toggle('active', +b.dataset.i === i); });
      $('wheelCenter').textContent = d.g;
      $('hEyebrow').textContent = d.el;
      $('hName').textContent = d.name;
      $('hMood').textContent = d.mood;
      $('hLove').innerHTML = stars(d.love);
      $('hCareer').innerHTML = stars(d.career);
      $('hMoney').innerHTML = stars(d.money);
      $('hLine').textContent = d.line;
      $('hNum').textContent = d.num;
      $('hColor').style.background = d.color;
    }
    wheel.querySelectorAll('.sign').forEach(function (b) {
      b.addEventListener('click', function () { select(+b.dataset.i); });
    });
    select(1); // Taurus default
  })();

  function setNumbers() {
    document.querySelectorAll('[data-count]').forEach(function (el) {
      el.textContent = el.dataset.count + (el.dataset.decimal || '') +
        (el.dataset.suffix || (parseFloat(el.dataset.count) >= 100 ? '+' : ''));
    });
  }

  if (!reduce && window.gsap) {
    try {
      gsap.registerPlugin(ScrollTrigger);

      /* hero is never hidden: take it out of the reveal system first */
      var hc = document.querySelector('.hero-copy'); if (hc) hc.classList.add('in');
      var ps = document.querySelector('.phone-stage'); if (ps) ps.classList.add('in');

      document.documentElement.classList.add('js-anim');

      /* hero entrance — transform only, opacity stays 1 */
      var tl = gsap.timeline();
      tl.from('.hero-copy .kick', { y: 18, duration: .7, ease: 'power3.out', clearProps: 'transform' })
        .from('.hero-copy h1', { y: 26, duration: .9, ease: 'power4.out', clearProps: 'transform' }, '-=.4')
        .from('.hero-copy .sub', { y: 20, duration: .7, ease: 'power3.out', clearProps: 'transform' }, '-=.5')
        .from('.hero-copy .actions, .hero-copy .trustrow', { y: 18, duration: .6, stagger: .12, ease: 'power3.out', clearProps: 'transform' }, '-=.4')
        .from('#orrery', { opacity: 0, scale: .9, transformOrigin: '72% 52%', duration: 1.3, ease: 'power2.out' }, '-=1');

      /* scroll reveals — anything already on screen reveals immediately */
      gsap.utils.toArray('.reveal').forEach(function (el) {
        if (el.classList.contains('in')) return;
        if (el.getBoundingClientRect().top < window.innerHeight * 0.92) { el.classList.add('in'); return; }
        ScrollTrigger.create({ trigger: el, start: 'top 90%', onEnter: function () { el.classList.add('in'); } });
      });

      /* cosmic background gentle parallax as hero scrolls away */
      gsap.to('#orrery', { yPercent: 12, ease: 'none', scrollTrigger: { trigger: '#top', start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to('#stars', { yPercent: 6, ease: 'none', scrollTrigger: { trigger: '#top', start: 'top top', end: 'bottom top', scrub: true } });

      /* ===== STICKY-SCROLL MODES SHOWCASE =====
         As each .sc-step scrolls through the centre, activate its step and
         swap the matching phone screen. */
      var screens = gsap.utils.toArray('.sc-screen');
      var steps = gsap.utils.toArray('.sc-step');
      function activate(mode) {
        screens.forEach(function (s) { s.classList.toggle('active', s.dataset.mode === String(mode)); });
        steps.forEach(function (s) { s.classList.toggle('active', s.dataset.mode === String(mode)); });
      }
      steps.forEach(function (step) {
        ScrollTrigger.create({
          trigger: step,
          start: 'top 60%',
          end: 'bottom 60%',
          onEnter: function () { activate(step.dataset.mode); },
          onEnterBack: function () { activate(step.dataset.mode); }
        });
      });

      /* service image parallax */
      gsap.utils.toArray('.scard img').forEach(function (img) {
        gsap.fromTo(img, { yPercent: -5 }, { yPercent: 5, ease: 'none', scrollTrigger: { trigger: img.closest('.scard'), start: 'top bottom', end: 'bottom top', scrub: true } });
      });

      /* animated counters — pre-fill final value, then count up */
      gsap.utils.toArray('[data-count]').forEach(function (el) {
        var end = parseFloat(el.dataset.count);
        var dec = el.dataset.decimal || '';
        var suf = el.dataset.suffix || (end >= 100 ? '+' : '');
        var fin = end + dec + suf;
        el.textContent = fin;
        var obj = { v: 0 };
        ScrollTrigger.create({
          trigger: el, start: 'top 95%', once: true, onEnter: function () {
            gsap.fromTo(obj, { v: 0 }, {
              v: end, duration: 1.6, ease: 'power2.out',
              onUpdate: function () { el.textContent = Math.round(obj.v) + dec + suf; },
              onComplete: function () { el.textContent = fin; }
            });
          }
        });
      });
    } catch (err) {
      document.documentElement.classList.remove('js-anim');
      revealAll();
      setNumbers();
    }
  } else {
    revealAll();
    setNumbers();
  }
})();
