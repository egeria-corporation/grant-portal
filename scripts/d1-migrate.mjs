#!/usr/bin/env node
// Applies D1 migrations to the database bound as `DB`.
//
// Usage: node scripts/d1-migrate.mjs --remote | --local
//
// On a first CLI deploy the database does not exist yet (`wrangler deploy`
// would provision it, but migrations run before deploy). When wrangler reports
// the database is missing, create it by the name in wrangler.jsonc and retry.
// `wrangler deploy` then binds to that existing database by name.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripJsonc } from './jsonc.mjs';

const target = process.argv.includes('--local') ? '--local' : '--remote';

function wrangler(args) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, CI: process.env.CI ?? 'true' },
  });
  process.stdout.write(res.stdout ?? '');
  process.stderr.write(res.stderr ?? '');
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

function databaseName() {
  const cfg = JSON.parse(stripJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')));
  const db = (cfg.d1_databases ?? []).find((d) => d.binding === 'DB');
  if (!db?.database_name) throw new Error('wrangler.jsonc has no d1 binding DB with a database_name');
  return db.database_name;
}

const apply = ['d1', 'migrations', 'apply', 'DB', target];
let res = wrangler(apply);
if (res.code !== 0 && target === '--remote' && /Couldn't find (an auto-provisioned )?(a )?D1 DB/i.test(res.out)) {
  const name = databaseName();
  console.log(`\nDatabase "${name}" does not exist yet. Creating it…`);
  const created = wrangler(['d1', 'create', name]);
  if (created.code !== 0 && !/already exists/i.test(created.out)) process.exit(created.code);
  res = wrangler(apply);
}
process.exit(res.code);
