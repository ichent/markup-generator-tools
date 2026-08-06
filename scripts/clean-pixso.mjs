#!/usr/bin/env node
// Шаг 1 пайплайна: очистка сырого Pixso JSON в компактное семантическое дерево.
//
// Запуск (из корня проекта или откуда угодно):
//   node scripts/clean-pixso.mjs [data/pixso-to-json.json] [gens/pixso-clean.json]
//
// Детерминированно, без LLM. Убирает ~40x шума и размечает каждую ноду role,
// чтобы следующие шаги (resolve → map → assemble) были тривиальными.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const GENS = join(ROOT, 'gens');

const inPath = process.argv[2] ?? join(DATA, 'pixso-to-json.json');
const outPath = process.argv[3] ?? join(GENS, 'pixso-clean.json');
mkdirSync(dirname(outPath), { recursive: true });

const raw = JSON.parse(readFileSync(inPath, 'utf8'));
const roots = Array.isArray(raw.nodes) ? raw.nodes : [raw.nodes];

// --- декоративные ноды: внутренности иконок/векторов, дропаем целиком ---
const DECOR = new Set(['RECTANGLE', 'ELLIPSE', 'VECTOR', 'BOOLEAN_OPERATION', 'LINE']);

// --- нормализация имени ---
const DS_EMOJI = /[\u{1F537}\u{1F48E}\u{1F315}]/u; // 🔷 💎 🌕 — маркеры компонентов дизайн-системы
const REGION = /^\s*\u{1F449}/u; // 👉 — семантическая зона (header/content/footer)
const ACTIONS = /^\s*\u{21B3}/u; // ↳ — группа действий
const ICON_RE = /^\s*\d+\s*\/\s*[^/]+\/\s*[^/]+$/; // "16 / Arrows / ChevronLeft"
const SIZE_TOKEN = /^(XS|S|M|L|XL|\d{1,3})$/i;

/** Срезает ведущие эмодзи/точки/пробелы. */
function stripLead(name) {
  return (name ?? '')
    .replace(/^[\s.]+/, '')
    .replace(/^[\p{Extended_Pictographic}\u{1F449}\u{21B3}]+\s*/u, '')
    .replace(/^[\s.]+/, '')
    .trim();
}

/** "💎 TextField 40 S" -> { component: "TextField", size: "40 S" } */
function parseComponent(name) {
  const base = stripLead(name);
  const toks = base.split(/\s+/).filter(Boolean);
  const size = [];
  while (toks.length > 1 && SIZE_TOKEN.test(toks[toks.length - 1])) size.unshift(toks.pop());
  return { component: toks.join(' '), size: size.join(' ') || undefined };
}

/** Определяем роль ноды. */
function classify(node) {
  const t = node.type;
  const name = node.name ?? '';
  if (t === 'TEXT') return 'text';
  if (REGION.test(name) || ACTIONS.test(name)) return 'region';
  if (ICON_RE.test(name)) return 'icon';
  if (DS_EMOJI.test(name)) return 'component';
  if (t === 'INSTANCE') return 'element'; // instance без эмодзи — кандидат в компонент/обёртку
  return 'layout'; // FRAME/GROUP и прочее
}

let kept = 0;

function clean(node) {
  if (!node || DECOR.has(node.type)) return null;
  kept++;

  const role = classify(node);
  const out = { role, type: node.type, name: node.name };

  if (role === 'text') out.text = node.typography?.characters ?? '';

  if (role === 'region') out.region = stripLead(node.name);

  if (role === 'icon') {
    const m = node.name.match(/\/\s*([^/]+)$/);
    out.icon = m ? m[1].trim() : node.name;
    return out; // иконку не раскрываем — её векторные внутренности не нужны
  }

  if (role === 'component' || role === 'element') {
    const p = parseComponent(node.name);
    out.component = p.component;
    if (p.size) out.size = p.size;
  }

  // мета лейаута
  const al = node.autoLayout;
  if (al && al.mode && al.mode !== 'NONE') {
    out.direction = al.mode;
    if (al.itemSpacing) out.gap = al.itemSpacing;
  }
  const padCss = node.padding?.css;
  if (padCss && padCss !== '0px 0px 0px 0px') out.padding = padCss;

  const kids = (node.children ?? []).map(clean).filter(Boolean);
  if (kids.length) out.children = kids;
  return out;
}

/** Схлопываем пустые обёртки-лейауты (1 ребёнок, без padding/gap/семантики). */
function flatten(node) {
  if (node.children) node.children = node.children.map(flatten);
  if (
    node.role === 'layout' &&
    node.children?.length === 1 &&
    !node.padding &&
    !node.gap
  ) {
    return node.children[0];
  }
  return node;
}

/** Есть ли в поддереве семантическая зона 👉/↳ (значит это контейнер-композиция). */
function hasRegion(node) {
  if (node.role === 'region') return true;
  return (node.children ?? []).some(hasRegion);
}

/** Собираем текст-слоты из поддерева: label/value/caption и т.п. */
function harvestSlots(node, acc = []) {
  if (node.role === 'text' && node.text?.trim()) {
    const slot = (node.name ?? '').replace(/\.text$/i, '').trim() || 'text';
    acc.push({ slot, text: node.text.trim() });
  }
  for (const c of node.children ?? []) harvestSlots(c, acc);
  return acc;
}

/**
 * Схлопываем DS-компоненты (💎/🌕/🔷) в листья: их внутренняя реализация — шум,
 * берём только текст-слоты. Контейнеры с зонами 👉 (ModalDF) не трогаем.
 */
function collapseLeafComponents(node) {
  for (const c of node.children ?? []) collapseLeafComponents(c);
  if (node.role === 'component' && !hasRegion(node)) {
    const slots = harvestSlots(node);
    if (slots.length) node.slots = slots;
    delete node.children;
  }
  return node;
}

const cleaned = roots
  .map(clean)
  .filter(Boolean)
  .map(flatten)
  .map(collapseLeafComponents);

writeFileSync(outPath, JSON.stringify({ nodes: cleaned }, null, 2) + '\n');

// --- отчёт ---
const beforeBytes = readFileSync(inPath).length;
const afterBytes = readFileSync(outPath).length;
const countAfter = (function count(ns) {
  let n = 0;
  for (const x of ns) {
    n++;
    if (x.children) n += count(x.children);
  }
  return n;
})(cleaned);

console.log(`Готово: ${outPath}`);
console.log(`  Ноды: до=1632(из сырья) → оставлено=${kept} → после схлопывания=${countAfter}`);
console.log(`  Размер: ${(beforeBytes / 1024 / 1024).toFixed(2)}MB → ${(afterBytes / 1024).toFixed(1)}KB`);

// компактный скелет очищенного дерева
console.log(`\n=== CLEAN SKELETON ===`);
function sk(node, d = 0) {
  const meta = [];
  if (node.component) meta.push(`component=${node.component}${node.size ? ` (${node.size})` : ''}`);
  if (node.region) meta.push(`region=${node.region}`);
  if (node.icon) meta.push(`icon=${node.icon}`);
  if (node.text) meta.push(`text=${JSON.stringify(node.text.slice(0, 30))}`);
  if (node.slots) meta.push('slots=' + node.slots.map((s) => `${s.slot}:${JSON.stringify(s.text.slice(0, 24))}`).join(', '));
  if (node.direction) meta.push(node.direction);
  console.log('  '.repeat(d) + `[${node.role}] ${node.name}${meta.length ? '  · ' + meta.join(' ') : ''}`);
  for (const c of node.children ?? []) sk(c, d + 1);
}
cleaned.forEach((r) => sk(r));
