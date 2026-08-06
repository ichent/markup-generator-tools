#!/usr/bin/env node
// Детерминированно вытаскивает валидный набор пропсов каждого компонента из
// реальных примеров сторибука (без LLM).
//
// Запуск (исходники могут быть только у одного кита — это ок):
//   node scripts/props-from-examples.mjs /path/to/df-ui-kit
//   FRONTDRIVE_STORYBOOK_ROOT_DF=/path/df FRONTDRIVE_STORYBOOK_ROOT_PLASMA=/path/plasma ...
//
// Читает .stories.tsx (пути из data/storybook-df.json / data/strybook-plasma.json),
// извлекает имена пропсов из JSX и args/argTypes.
// Результат -> gens/component-props.json
// Для кита без ROOT / без найденных файлов — просто пропускаем (resolve имён
// всё равно работает по index.json; пропсы для такого кита — только из prop-map).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(PROJ, 'data');
const GENS = join(PROJ, 'gens');

// ROOT по китам. Общий FRONTDRIVE_STORYBOOK_ROOT / argv[2] — фолбэк для обоих.
const ROOT_FALLBACK = process.env.FRONTDRIVE_STORYBOOK_ROOT ?? process.argv[2] ?? null;
const ROOTS = {
  df: process.env.FRONTDRIVE_STORYBOOK_ROOT_DF ?? ROOT_FALLBACK,
  plasma: process.env.FRONTDRIVE_STORYBOOK_ROOT_PLASMA ?? ROOT_FALLBACK,
};
if (!ROOTS.df && !ROOTS.plasma) {
  console.error(
    '✖ Задай хотя бы один ROOT:\n' +
      '  FRONTDRIVE_STORYBOOK_ROOT=/path  (или argv)\n' +
      '  FRONTDRIVE_STORYBOOK_ROOT_DF=/path\n' +
      '  FRONTDRIVE_STORYBOOK_ROOT_PLASMA=/path',
  );
  process.exit(1);
}
for (const [kit, root] of Object.entries(ROOTS)) {
  if (root && !existsSync(root)) {
    console.error(`✖ ROOT для ${kit} не существует: ${root}`);
    process.exit(1);
  }
}

// Индексы сторибука: env-оверрайд -> FRONTDRIVE_KITS_DIR -> data/ -> cwd.
const KITS_DIR = process.env.FRONTDRIVE_KITS_DIR ?? null;
function findKit(fileName, envVar) {
  const candidates = [
    process.env[envVar],
    KITS_DIR && join(KITS_DIR, fileName),
    join(DATA, fileName),
    // опечатка в имени plasma-индекса (историческая)
    fileName === 'strybook-plasma.json' ? join(DATA, 'storybook-plasma.json') : null,
    join(process.cwd(), fileName),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

const KITS = [
  { path: findKit('storybook-df.json', 'FRONTDRIVE_STORYBOOK_DF'), kit: 'df' },
  { path: findKit('strybook-plasma.json', 'FRONTDRIVE_STORYBOOK_PLASMA'), kit: 'plasma' },
];
if (!KITS.some((k) => k.path)) {
  console.error(
    `✖ Не найдены индексы сторибука (storybook-df.json / strybook-plasma.json).\n` +
      `  Укажи FRONTDRIVE_KITS_DIR=/dir или FRONTDRIVE_STORYBOOK_DF=/path/to/storybook-df.json`,
  );
  process.exit(1);
}

const isSource = (p) => /\.(stories\.(tsx?|jsx?)|mdx|tsx?|jsx?)$/.test(p ?? '');

// name(lowercase) -> { name, kit, sources:Set<string> } — собираем ВСЕ entry компонента
const catalog = new Map();
for (const { path, kit } of KITS) {
  if (!path) { console.warn(`  ⚠ индекс для kit=${kit} не найден — пропускаю`); continue; }
  const entries = JSON.parse(readFileSync(path, 'utf8')).entries ?? {};
  for (const e of Object.values(entries)) {
    const name = (e.title ?? '').split('/').pop()?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    let rec = catalog.get(key);
    if (!rec) { rec = { name, kit, sources: new Set() }; catalog.set(key, rec); }
    if (rec.kit !== kit) continue; // df приоритетнее — plasma не подмешиваем
    if (isSource(e.importPath)) rec.sources.add(e.importPath);
    for (const p of e.storiesImports ?? []) if (isSource(p)) rec.sources.add(p);
  }
}

// Резолв устойчив к уровню ROOT: пробуем все «хвосты» относительного пути,
// отбрасывая ведущие сегменты (packages/, packages/storybook/, ...).
const firstTried = {}; // kit -> path
function resolveSource(relSource, kit) {
  const root = ROOTS[kit];
  if (!root) return null;
  const parts = relSource.replace(/^\.\//, '').split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const cand = join(root, parts.slice(i).join('/'));
    if (!firstTried[kit]) firstTried[kit] = cand;
    if (existsSync(cand)) return cand;
  }
  return null;
}

// ключи верхнего уровня объектного литерала (без вложенных)
function topLevelKeys(body) {
  const keys = [];
  let depth = 0, i = 0;
  const atTop = () => depth === 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; i++; continue; }
    if (atTop() && /[A-Za-z_]/.test(ch)) {
      const m = /^([A-Za-z_][\w]*)\s*:/.exec(body.slice(i));
      if (m) { keys.push(m[1]); i += m[0].length; continue; }
    }
    i++;
  }
  return keys;
}

function extractProps(src, name) {
  const props = new Set();

  // 1) JSX-использования: <Name ...props...>
  const tagRe = new RegExp(`<${name}\\b([\\s\\S]*?)(?:/>|>)`, 'g');
  let m;
  while ((m = tagRe.exec(src))) {
    const attr = m[1];
    // проп со значением: name=...
    for (const pm of attr.matchAll(/([A-Za-z_][\w]*)\s*=/g)) props.add(pm[1]);
    // булев-проп (shorthand без =): убираем присваивания и берём оставшиеся идентификаторы
    const bare = attr.replace(/([A-Za-z_][\w]*)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^{}]*\})/g, ' ');
    for (const bm of bare.matchAll(/(?:^|\s)([A-Za-z_][\w]*)(?=\s|$)/g)) props.add(bm[1]);
  }

  // 2) args: { prop: ... } и argTypes: { prop: {...} } — только ключи верхнего уровня
  for (const block of ['args', 'argTypes']) {
    const re = new RegExp(`${block}\\s*:\\s*\\{`, 'g');
    let bm;
    while ((bm = re.exec(src))) {
      let i = bm.index + bm[0].length - 1; // на открывающей {
      let depth = 0;
      const start = i + 1;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
      }
      for (const k of topLevelKeys(src.slice(start, i))) props.add(k);
    }
  }
  return [...props].sort();
}

const out = {};
let ok = 0, miss = 0, nofile = 0, noRoot = 0, resolvedFiles = 0;
const byKit = { df: { ok: 0, nofile: 0, noRoot: 0 }, plasma: { ok: 0, nofile: 0, noRoot: 0 } };

for (const [, info] of catalog) {
  if (info.sources.size === 0) { miss++; continue; }
  if (!ROOTS[info.kit]) {
    noRoot++;
    byKit[info.kit].noRoot++;
    continue;
  }
  const props = new Set();
  const files = [];
  for (const src of info.sources) {
    const abs = resolveSource(src, info.kit);
    if (!abs) continue;
    resolvedFiles++;
    files.push(src);
    for (const p of extractProps(readFileSync(abs, 'utf8'), info.name)) props.add(p);
  }
  if (files.length === 0) {
    nofile++;
    byKit[info.kit].nofile++;
    continue;
  }
  out[info.name] = { kit: info.kit, files, props: [...props].sort() };
  if (props.size) { ok++; byKit[info.kit].ok++; }
}

mkdirSync(GENS, { recursive: true });
const outFile = join(GENS, 'component-props.json');
writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(`Готово: ${outFile}`);
console.log(`  ROOT df:     ${ROOTS.df ?? '— (пропсы DF не извлекаем)'}`);
console.log(`  ROOT plasma: ${ROOTS.plasma ?? '— (пропсы Plasma не извлекаем)'}`);
console.log(`  Индексы: ${KITS.map((k) => `${k.kit}=${k.path ?? '—'}`).join(', ')}`);
console.log(`  Компонентов в каталоге: ${catalog.size}`);
console.log(`  Прочитано файлов примеров: ${resolvedFiles}`);
console.log(`  С извлечёнными пропсами: ${ok} (df=${byKit.df.ok}, plasma=${byKit.plasma.ok})`);
console.log(`  Без source в индексе: ${miss}`);
console.log(`  Без ROOT для кита: ${noRoot} (df=${byKit.df.noRoot}, plasma=${byKit.plasma.noRoot})`);
console.log(`  Файл не найден под ROOT: ${nofile} (df=${byKit.df.nofile}, plasma=${byKit.plasma.nofile})`);

for (const kit of ['df', 'plasma']) {
  if (!ROOTS[kit] && KITS.find((k) => k.kit === kit)?.path) {
    console.log(`\n  ⓘ kit=${kit}: index есть, исходников нет — имена резолвятся, пропсы только из data/prop-map.json`);
  } else if (ROOTS[kit] && byKit[kit].ok === 0 && byKit[kit].nofile > 0) {
    console.log(`\n  ⚠ kit=${kit}: под ROOT ничего не найдено. Пример пути:\n    ${firstTried[kit] ?? '—'}`);
  }
}

if (resolvedFiles === 0) {
  console.log(`\n  ⚠ Ни один файл примеров не прочитан. Проверь ROOT'ы.`);
}
