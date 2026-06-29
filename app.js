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

// Marketing landing page + any static assets (served at the web root).
app.use(express.static(path.join(__dirname, 'public')));

// Health probes (no auth, no audit).
app.get('/healthz', (req, res) => res.json({ status: 'ok', instance: env.instanceId }));
app.get('/readyz', (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({ db: dbReady ? 'up' : 'down' });
});

// API docs.
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// API.
app.use('/api', apiLimiter, routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
