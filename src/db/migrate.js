'use strict';

const db = require('./index');
db.init();
console.log('migrated');
process.exit(0);
