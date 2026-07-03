'use strict';

const repo = require('../db/repo');

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'unauthorized' });
}

module.exports = { requireAdmin };
