#!/usr/bin/env node
/**
 * Performance budget (spec §13, PLAN M6): no client route may need more than
 * 200 KB of gzipped JS + CSS on first load. A route's cost is the entry script
 * and stylesheet from index.html, plus the route's own chunk and everything it
 * imports statically. Runs after `vite build`; exits 1 when over budget.
 *
 *   node scripts/check-bundle.mjs            check dist/client
 *   node scripts/check-bundle.mjs --report   also print every route's size
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET = 200 * 1024;
const dist = fileURLToPath(new URL('../dist/client/', import.meta.url));
const assets = join(dist, 'assets');

const gz = new Map();
const sizeOf = (file) => {
  if (!gz.has(file)) gz.set(file, gzipSync(readFileSync(join(assets, file)), { level: 9 }).length);
  return gz.get(file);
};

const imports = new Map();
const staticImports = (file) => {
  if (!imports.has(file)) {
    const code = readFileSync(join(assets, file), 'utf8');
    const found = new Set();
    for (const m of code.matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([\w.-]+\.js)["']/g)) found.add(m[1]);
    imports.set(file, [...found]);
  }
  return imports.get(file);
};

const closure = (start) => {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...staticImports(f));
  }
  return seen;
};

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = /<script[^>]+src="\/assets\/([\w.-]+\.js)"/.exec(html)?.[1];
const css = [...html.matchAll(/<link[^>]+href="\/assets\/([\w.-]+\.css)"/g)].map((m) => m[1]);
if (!entry) {
  console.error('check-bundle: no entry script in dist/client/index.html; run vite build first');
  process.exit(1);
}
const base = closure(entry);
const baseCss = css.reduce((n, f) => n + sizeOf(f), 0);

const results = [];
for (const file of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
  const files = new Set([...base, ...closure(file)]);
  const total = [...files].reduce((n, f) => n + sizeOf(f), 0) + baseCss;
  results.push({ file, total });
}
results.sort((a, b) => b.total - a.total);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const over = results.filter((r) => r.total > BUDGET);

if (process.argv.includes('--report')) for (const r of results) console.log(`${kb(r.total).padStart(10)}  ${r.file}`);
console.log(`bundle budget: heaviest route ${results[0]?.file} is ${kb(results[0]?.total ?? 0)} gzipped (budget ${kb(BUDGET)})`);
if (over.length) {
  for (const r of over) console.error(`over budget: ${r.file} needs ${kb(r.total)} gzipped`);
  process.exit(1);
}
