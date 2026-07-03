'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[current] ?? LEVELS.info;

function fmt(level, msg, meta) {
  const base = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (meta && typeof meta === 'object') Object.assign(base, meta);
  return JSON.stringify(base);
}

function log(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = fmt(level, msg, meta);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

module.exports = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
