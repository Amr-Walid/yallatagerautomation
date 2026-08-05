'use strict';
const fs = require('fs');
const path = require('path');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

class Logger {
  constructor({ file = null, quiet = false } = {}) {
    this.quiet = quiet;
    this.file = file;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.stream = fs.createWriteStream(file, { flags: 'a' });
      this.stream.write(`\n===== ${new Date().toISOString()} =====\n`);
    }
  }
  _w(plain, colored) {
    if (!this.quiet) console.log(colored);
    if (this.stream) this.stream.write(plain + '\n');
  }
  info(m) { this._w(m, m); }
  dim(m) { this._w(m, C.gray + m + C.reset); }
  step(m) { this._w('▸ ' + m, C.cyan + '▸ ' + m + C.reset); }
  ok(m) { this._w('✔ ' + m, C.green + '✔ ' + m + C.reset); }
  warn(m) { this._w('⚠ ' + m, C.yellow + '⚠ ' + m + C.reset); }
  fail(m) { this._w('✘ ' + m, C.red + '✘ ' + m + C.reset); }
  head(m) {
    const bar = '─'.repeat(Math.min(64, m.length + 4));
    this._w(`\n${bar}\n  ${m}\n${bar}`, `\n${C.blue}${bar}\n  ${C.bold}${m}${C.reset}${C.blue}\n${bar}${C.reset}`);
  }
  close() { if (this.stream) this.stream.end(); }
}

module.exports = { Logger, COLORS: C };
