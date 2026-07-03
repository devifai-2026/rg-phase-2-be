const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');

const env = require('./config/env');
const swaggerSpec = require('./config/swagger');
const routes = require('./routes');
const apiLogger = require('./middlewares/apiLogger');
const { errorHandler, notFound } = require('./middlewares/errorHandler');
const { apiLimiter } = require('./middlewares/rateLimit');
const { tenantResolver } = require('./middlewares/tenantResolver');
const mongoose = require('mongoose');
const pinoHttp = require('pino-http');


const app = express();
app.set('trust proxy', 1);

// Origins allowed to embed the landing page in an iframe (admin heatmap
// overlay). Same-origin always; plus the admin dev/app origins via env.
const frameAncestors = ["'self'", ...(env.adminOrigins || [])];

// Helmet's default CSP would block the landing page's CDN script, Google
// Fonts and Unsplash images, so allow exactly those hosts.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", 'https://cdnjs.cloudflare.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'https://images.unsplash.com'],
        'connect-src': ["'self'"],
        'frame-ancestors': frameAncestors,
      },
    },
    // X-Frame-Options would also block cross-origin framing; CSP
    // frame-ancestors is the modern control, so disable the legacy header.
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    // allow the landing page to be read cross-origin by the admin iframe
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
// PayU posts urlencoded form data to the callback.
app.use(express.urlencoded({ extended: true }));
if (env.isDev) app.use(morgan('dev'));
app.use(apiLogger);

// Per-tenant white-label landing page: when the Host is a tenant subdomain,
// render that tenant's branded landing at the site root (before static, so it
// takes precedence over the platform's own index.html). No-op in single-tenant.
if (env.saas.enabled) {
  app.use(require('./services/control/landingService').landingMiddleware());
}

// Marketing landing page + any static assets (served at the web root).
app.use(express.static(path.join(__dirname, 'public')));

// Caddy on-demand TLS authorization. Caddy calls this (?domain=<host>) before
// issuing a cert for a host, so we only mint certs for the platform host or a
// KNOWN tenant subdomain (prevents cert-abuse for arbitrary hosts). 200 = allow,
// 403 = deny. No auth/tenant resolution (Caddy hits it for unknown hosts).
app.get('/internal/tls-check', async (req, res) => {
  try {
    const domain = String(req.query.domain || '').toLowerCase().split(':')[0];
    if (!domain) return res.sendStatus(403);
    // Always allow the platform's own root host(s).
    const root = (env.saas.rootDomain || '').toLowerCase();
    if (domain === root) return res.sendStatus(200);
    if (!env.saas.enabled) return res.sendStatus(403);
    // Allow a tenant subdomain that resolves to an active tenant.
    const { slugFromHost } = require('./middlewares/tenantResolver');
    const slug = slugFromHost(domain);
    if (!slug) return res.sendStatus(403);
    const { Tenant } = require('./models/control');
    const exists = await Tenant.exists({ slug, status: 'active' });
    return res.sendStatus(exists ? 200 : 403);
  } catch (e) {
    return res.sendStatus(403);
  }
});

// Health probes (no auth, no audit).
app.get('/healthz', (req, res) => res.json({ status: 'ok', instance: env.instanceId }));
app.get('/readyz', (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({ db: dbReady ? 'up' : 'down' });
});

// API docs.
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Platform-owner control-plane API. Mounted OUTSIDE the tenant resolver — these
// routes operate on the control plane (Tenant/Plan/Subscription/…), never a
// tenant DB, and use separate owner auth. Only active when SaaS is enabled.
if (env.saas.enabled) {
  app.use('/platform', apiLimiter, require('./routes/platformRoutes'));
}

// API. tenantResolver runs first so req.tenant / req.db / req.model(name) are
// available to every route. In single-tenant mode (SAAS_ENABLED unset) it is a
// no-op that attaches the default connection, so behavior is unchanged.
app.use('/api', apiLimiter, tenantResolver, routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
