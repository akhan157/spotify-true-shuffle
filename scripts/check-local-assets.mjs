#!/usr/bin/env node
// CI guard: every local file referenced by index.html or manifest.json must
// exist, and no unreferenced app*.js bundles may be left in the repo root.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const referenced = new Set();

function check(ref, from) {
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return; // data:, https:, //cdn, #anchor
  const clean = ref.split(/[?#]/)[0];
  if (!clean) return;
  const target = resolve(root, clean.replace(/^\//, ''));
  referenced.add(target);
  if (!target.startsWith(root)) {
    problems.push(`${from}: ${ref} points outside the repo`);
  } else if (!existsSync(target)) {
    problems.push(`${from}: ${ref} does not exist`);
  } else if (ref.endsWith('/') && !existsSync(join(target, 'index.html'))) {
    problems.push(`${from}: ${ref} has no index.html`);
  }
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
for (const [, ref] of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
  check(ref, 'index.html');
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
check(manifest.start_url, 'manifest.json');
for (const icon of manifest.icons ?? []) check(icon.src, 'manifest.json');

for (const file of readdirSync(root)) {
  if (/^app(-v\d+)?\.js$/.test(file) && !referenced.has(join(root, file))) {
    problems.push(`${file} is not referenced by index.html (dead bundle)`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('local assets ok');
