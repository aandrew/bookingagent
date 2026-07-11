'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

const config = require('./config');
const db = require('./db');
const log = require('./logger');

db.init();

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const apiRoutes = require('./routes/api');
const sseHandler = require('./routes/sse');
const { requireAdmin } = require('./routes/_mw');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

// v4: serve static assets from src/views/public/ at /public/*.
// Currently used for live.js (the SSE push client). Files are cached
// for 1 hour in production, no cache in dev (since the server doesn't
// restart on file changes).
app.use('/public', express.static(path.join(__dirname, 'views', 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  fallthrough: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.use(session({
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.session.cookieMaxAgeMs,
  },
}));

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.user = req.session?.user || null;
  res.locals.flash = req.session?.flash || null;
  delete req.session?.flash;
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/api', apiRoutes);
// v4: SSE push endpoint. /api/events streams events to the admin
// dashboard in real time. requireAdmin gates it; EventSource can't
// set custom headers in the browser, so auth is via the admin cookie.
app.get('/api/events', requireAdmin, sseHandler);

app.use((err, req, res, next) => {
  log.error('server.error', { error: err.message, stack: err.stack, path: req.path });
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
  res.status(500).render('error', { message: err.message, stack: err.stack });
});

app.use((req, res) => res.status(404).render('error', { message: 'Not found', stack: '' }));

const adminHash = bcrypt.hashSync(config.admin.pass, 10);
app.locals.checkAdminLogin = (user, pass) => user === config.admin.user && bcrypt.compareSync(pass, adminHash);

const jobs = require('./agent/jobs');
jobs.start();

const server = app.listen(config.port, config.bind, () => {
  log.info('server.start', { bind: config.bind, port: config.port, env: config.nodeEnv });
});

function shutdown(sig) {
  log.info('server.shutdown', { signal: sig });
  jobs.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', { error: e?.message }));
process.on('uncaughtException', (e) => log.error('uncaughtException', { error: e.message, stack: e.stack }));
