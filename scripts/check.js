#!/usr/bin/env node
'use strict';

/**
 * Build gate for VeloFox Dispatch Software.
 *
 * There is no bundler in this project: the server is plain CommonJS and the
 * front end ships as-is. The meaningful checks are therefore that every
 * script parses, and that the files the server serves at runtime exist.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SCRIPT_DIRS = ['lib', 'public', 'public/js'];
const REQUIRED_FILES = [
  'server.js',
  'schema.sql',
  'neon.ts',
  'public/index.html',
  'public/booking.html',
  'public/dashboard.html',
  'public/client.html',
  'public/theme.css',
];

function collectScripts() {
  const files = ['server.js'];
  for (const dir of SCRIPT_DIRS) {
    const absolute = path.join(ROOT, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

function main() {
  const failures = [];

  const scripts = collectScripts();
  for (const relative of scripts) {
    try {
      const absolute = path.join(ROOT, relative);
      new vm.Script(fs.readFileSync(absolute, 'utf8'), { filename: absolute });
    } catch (error) {
      failures.push(`${relative}: ${error.message}`);
    }
  }

  for (const relative of REQUIRED_FILES) {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) {
      failures.push(`${relative}: missing or empty`);
    }
  }

  if (failures.length > 0) {
    console.error('Build check failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`Build check passed: ${scripts.length} scripts parsed, ${REQUIRED_FILES.length} required files present.`);
}

main();
