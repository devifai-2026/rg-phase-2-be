const fs = require('path') && require('fs');
const path = require('path');
const { slugFromHost } = require('../../middlewares/tenantResolver');

/**
 * Per-tenant white-label landing page. When SaaS is on and the request Host is a
 * tenant subdomain (of saas.rootDomain), we render the RICH app-marketing
 * template (templates/tenantLanding.html — the polished former-Rudraganga page)
 * with THIS tenant's brand injected: name, colours, app-store link, contact. One
 * template, every client's brand — no per-client deploy. Falls through to the
 * platform's own page otherwise.
 */
function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Load + cache the rich template once (it's static).
let _tpl = null;
function template() {
  if (_tpl == null) {
    try { _tpl = fs.readFileSync(path.join(__dirname, 'templates', 'tenantLanding.html'), 'utf8'); }
    catch (_) { _tpl = ''; }
  }
  return _tpl;
}

function renderLanding(tenant) {
  const b = tenant.branding || {};
  const name = b.displayName || tenant.displayName || 'Astro App';
  const primary = b.primaryColor || '#E0584A';
  const accent = b.accentColor || '#D9A441';
  const playId = (tenant.androidUser && tenant.androidUser.applicationId) || '';
  const playLink = playId ? `https://play.google.com/store/apps/details?id=${playId}` : '#download';
  const support = b.supportEmail || '';

  const tpl = template();
  if (tpl) {
    // The rich template's #download anchors scroll to its download section; the
    // real store link is wired via {{DOWNLOAD_ANCHOR}} (Play URL when known, else
    // an on-page anchor). Values are escaped where they land in HTML/attributes.
    return tpl
      .split('{{APP_NAME}}').join(esc(name))
      .split('{{PRIMARY}}').join(esc(primary))
      .split('{{ACCENT}}').join(esc(accent))
      .split('{{DOWNLOAD_ANCHOR}}').join(playId ? esc(playLink) : '#download')
      .split('{{TERMS_URL}}').join('#')
      .split('{{PRIVACY_URL}}').join('#')
      .split('{{REFUND_URL}}').join('#');
  }

  // Fallback (template missing): minimal self-contained page.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(name)}</title></head>
<body style="font-family:sans-serif;text-align:center;padding:48px">
<h1>${esc(name)}</h1><p>${esc(b.tagline || 'Talk to expert astrologers — anytime, anywhere.')}</p>
<a href="${esc(playLink)}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:${esc(primary)};color:#fff;text-decoration:none;font-weight:700">Get the App</a>
${support ? `<p style="color:#888;margin-top:24px">Contact: ${esc(support)}</p>` : ''}</body></html>`;
}

/**
 * Express middleware: if the Host resolves to a tenant subdomain, render that
 * tenant's landing page for the site root and 404-nothing else here (so API and
 * static assets still work). Best-effort; never blocks the chain on error.
 */
function landingMiddleware() {
  return async (req, res, next) => {
    // Only for the site root document, GET, and only in multi-tenant mode.
    if (req.method !== 'GET' || req.path !== '/') return next();
    const env = require('../../config/env');
    if (!env.saas.enabled) return next();

    const slug = slugFromHost(req.headers.host);
    if (!slug) return next(); // platform marketing page (static) handles it

    try {
      const { Tenant } = require('../../models/control');
      const tenant = await Tenant.findOne({ slug, status: 'active' }).lean();
      if (!tenant) return next();
      res.set('Content-Type', 'text/html; charset=utf-8').send(renderLanding(tenant));
    } catch (e) {
      next();
    }
  };
}

module.exports = { landingMiddleware, renderLanding };
