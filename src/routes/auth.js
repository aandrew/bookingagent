'use strict';

const express = require('express');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session?.user?.role === 'admin') return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (req.app.locals.checkAdminLogin(username, password)) {
    req.session.user = { role: 'admin', username };
    return res.redirect('/');
  }
  res.status(401).render('login', { error: 'Invalid credentials' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
