#!/usr/bin/env node
// Шаг 2 пайплайна: резолв очищенного дерева против двух Storybook-индексов (DF + Plasma).
//
// Запуск (из корня проекта или откуда угодно):
//   node scripts/resolve-pixso.mjs [gens/pixso-clean.json] [gens/pixso-spec.json]
//
// Правила:
//  - ищем компонент в обоих UI-KIT (текущий DF перебивает родительский Plasma);
//  - матч регистронезависимо + фолбэк на первое слово ("Combobox Single" -> Combobox);
//  - строки-обёртки (layout) -> компонент Flow;
//  - НЕ найдено -> fake-компонент с явным именем (никаких выдумок).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const GENS = join(ROOT, 'gens');

const inPath = process.argv[2] ?? join(GENS, 'pixso-clean.json');
const outPath = process.argv[3] ?? join(GENS, 'pixso-spec.json');
mkdirSync(dirname(outPath), { recursive: true });

const DF_PATH = join(DATA, 'storybook-df.json');
const PLASMA_PATH = existsSync(join(DATA, 'storybook-plasma.json'))
  ? join(DATA, 'storybook-plasma.json')
  : join(DATA, 'strybook-plasma.json');

// --- индекс компонентов из Storybook index.json ---
function loadKit(path, kit, index) {
  const idx = JSON.parse(readFileSync(path, 'utf8'));
  const byTitle = new Map();
  for (const e of Object.values(idx.entries ?? {})) {
    if (!e.title) continue;
    if (!byTitle.has(e.title)) byTitle.set(e.title, []);
    byTitle.get(e.title).push(e);
  }
  for (const [title, group] of byTitle) {
    if (!group.some((e) => e.type === 'story')) continue; // только реальные компоненты
    const name = title.split('/').pop();
    const key = name.toLowerCase();
    if (!index.has(key)) index.set(key, { name, kit }); // DF грузим первым => он побеждает
  }
}

const index = new Map();
loadKit(DF_PATH, 'df', index); // текущий — приоритетный
loadKit(PLASMA_PATH, 'plasma', index); // родительский — фолбэк

/** Резолв имени: точное (ci); first-word-фолбэк — только для DS-компонентов (эмодзи). */
function resolveName(base, allowFirstWord) {
  const b = (base ?? '').trim();
  const tries = [b];
  const first = b.split(/\s+/)[0];
  if (allowFirstWord && first && first !== b) tries.push(first);
  for (const t of tries) {
    const hit = index.get(t.toLowerCase());
    if (hit) return { status: 'resolved', name: hit.name, kit: hit.kit };
  }
  return { status: 'not_found', query: b };
}

// --- чистка текст-слотов от шаблонного шума ---
const SLOT_BLACKLIST = new Set(['tooltip text you can replace', '(no required)', 'title caption', 'placeholder']);
function cleanSlots(slots) {
  return (slots ?? []).filter((s) => {
    const slot = s.slot.trim().toLowerCase();
    const text = s.text.trim().toLowerCase();
    if (text === slot) return false; // TB:"TB", TA:"TA"
    if (SLOT_BLACKLIST.has(text)) return false;
    if (/^tooltip text/i.test(s.text)) return false;
    if (slot === 'label') return false; // сетка календаря DatePicker
    return true;
  });
}

/** Собрать тексты из поддерева (для element-обёрток без предсобранных слотов). */
function harvest(node, acc = []) {
  if (node.role === 'text' && node.text?.trim()) {
    acc.push({ slot: (node.name ?? '').replace(/\.text$/i, '').trim() || 'text', text: node.text.trim() });
  }
  for (const c of node.children ?? []) harvest(c, acc);
  return acc;
}

// --- статистика резолва ---
const report = { resolved: new Map(), notFound: new Map(), flow: 0, fake: 0 };
const mark = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

const fakeNote = (base) => `не найдено в storybook (DF/Plasma): «${base}»`;
const recurse = (node) => (node.children ?? []).flatMap(resolveNode);

/** Обход: cleaned-нода -> массив spec-нод (0..n, т.к. обёртки разворачиваются). */
function resolveNode(node) {
  if (node.role === 'text') return node.text?.trim() ? [{ kind: 'text', text: node.text.trim() }] : [];
  if (node.role === 'icon') return [{ kind: 'icon', icon: node.icon }];
  if (node.role === 'region') return [{ kind: 'region', region: node.region, direction: node.direction, children: recurse(node) }];
  if (node.role === 'layout') {
    const kids = recurse(node);
    if (kids.length === 0) return [];
    report.flow++;
    return [{ kind: 'flow', name: 'Flow', kit: 'plasma', direction: node.direction, gap: node.gap, children: kids }];
  }

  const base = node.component ?? node.name;
  const isEmoji = node.role === 'component';
  const isContainer = (node.children ?? []).some((c) => c.role === 'region'); // ModalDF держит зоны

  // --- контейнер: сохраняем детей, не превращаем в лист ---
  if (isContainer) {
    const r = resolveName(base, isEmoji);
    const kids = recurse(node);
    if (r.status === 'resolved') {
      mark(report.resolved, `${r.name} [${r.kit}]`);
      return [{ kind: 'component', name: r.name, kit: r.kit, ...(node.size ? { size: node.size } : {}), children: kids }];
    }
    report.fake++;
    mark(report.notFound, base);
    return [{ kind: 'fake', name: base, found: false, note: fakeNote(base), children: kids }];
  }

  // --- лист-компонент: резолвим, детей не рекурсим (реализацию берём из сторибука) ---
  const r = resolveName(base, isEmoji);
  if (r.status === 'resolved') {
    mark(report.resolved, `${r.name} [${r.kit}]`);
    const spec = { kind: 'component', name: r.name, kit: r.kit };
    if (node.size) spec.size = node.size;
    const slots = cleanSlots(node.slots ?? harvest(node));
    if (slots.length) spec.slots = slots;
    return [spec];
  }

  // --- не найдено ---
  if (node.role === 'element') {
    // обёртка над реальным компонентом (ButtonBack -> Button, primary -> Button) — разворачиваем
    const kids = recurse(node);
    const hasReal = kids.some((k) => k.kind === 'component' || k.kind === 'flow' || k.kind === 'fake');
    if (hasReal) return kids;
    const slots = cleanSlots(node.slots ?? harvest(node));
    if (!slots.length) return []; // пустой мусор-обёртка
    report.fake++;
    mark(report.notFound, base);
    return [{ kind: 'fake', name: base, found: false, note: fakeNote(base), slots }];
  }

  // эмодзи-компонент, но не найден в сторибуке — честный fake
  report.fake++;
  mark(report.notFound, base);
  const slots = cleanSlots(node.slots ?? []);
  return [{ kind: 'fake', name: base, found: false, note: fakeNote(base), ...(slots.length ? { slots } : {}) }];
}

const roots = JSON.parse(readFileSync(inPath, 'utf8')).nodes ?? [];
const spec = roots.flatMap(resolveNode);
writeFileSync(outPath, JSON.stringify({ spec }, null, 2) + '\n');

// --- отчёт ---
console.log(`Индекс: DF=${[...index.values()].filter((v) => v.kit === 'df').length}, Plasma=${[...index.values()].filter((v) => v.kit === 'plasma').length}`);
console.log(`Готово: ${outPath}\n`);
console.log('=== РЕЗОЛВНУТО ===');
for (const [k, n] of [...report.resolved].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
console.log(`\n=== FLOW (строки-обёртки): ${report.flow} ===`);
console.log(`\n=== НЕ НАЙДЕНО → fake (${report.fake}) ===`);
for (const [k, n] of [...report.notFound].sort((a, b) => b[1] - a[1])) console.log(`  «${k}»: ${n}`);

// компактный скелет спеки
console.log('\n=== SPEC SKELETON ===');
function sk(n, d = 0) {
  const meta = [];
  if (n.kit) meta.push(`[${n.kit}]`);
  if (n.size) meta.push(`size=${n.size}`);
  if (n.region) meta.push(`region=${n.region}`);
  if (n.icon) meta.push(`icon=${n.icon}`);
  if (n.text) meta.push(`text=${JSON.stringify(n.text.slice(0, 28))}`);
  if (n.slots) meta.push('slots=' + n.slots.map((s) => `${s.slot}:${JSON.stringify(s.text.slice(0, 20))}`).join(','));
  if (n.direction) meta.push(n.direction);
  const label = n.kind === 'component' ? n.name : n.kind === 'fake' ? `FAKE(${n.name})` : n.kind;
  console.log('  '.repeat(d) + `${label}${meta.length ? '  · ' + meta.join(' ') : ''}`);
  for (const c of n.children ?? []) sk(c, d + 1);
}
spec.forEach((r) => sk(r));
