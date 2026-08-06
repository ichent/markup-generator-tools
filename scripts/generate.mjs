#!/usr/bin/env node
// Единая обёртка над пайплайном: clean -> resolve -> assemble.
//
// Запуск (из корня проекта или откуда угодно):
//   node scripts/generate.mjs [data/pixso-to-json.json] [gens/GeneratedModal.tsx]
//
// Данные читаются из data/, все артефакты (в т.ч. промежуточные) пишутся в gens/.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DATA = join(ROOT, 'data');
const GENS = join(ROOT, 'gens');

const input = process.argv[2] ?? join(DATA, 'pixso-to-json.json');
const output = process.argv[3] ?? join(GENS, 'GeneratedModal.tsx');

const CLEAN = join(GENS, 'pixso-clean.json');
const SPEC = join(GENS, 'pixso-spec.json');

const steps = [
  { name: '1/3 clean   ', script: 'clean-pixso.mjs', args: [input, CLEAN] },
  { name: '2/3 resolve ', script: 'resolve-pixso.mjs', args: [CLEAN, SPEC] },
  { name: '3/3 assemble', script: 'assemble-pixso.mjs', args: [SPEC, output] },
];

for (const { name, script, args } of steps) {
  console.log(`\n=== ${name} (${script}) ===`);
  const r = spawnSync('node', [join(HERE, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✖ Ошибка на шаге ${script} (код ${r.status ?? 'null'})`);
    process.exit(r.status ?? 1);
  }
}

console.log(`\n✔ Пайплайн завершён: ${output}`);
