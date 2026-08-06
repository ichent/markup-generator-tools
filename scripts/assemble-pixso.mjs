#!/usr/bin/env node
// Шаг 4 пайплайна: сборка TSX-разметки из спеки (pixso-spec.json).
//
// Запуск (из корня проекта или откуда угодно):
//   node scripts/assemble-pixso.mjs [gens/pixso-spec.json] [gens/GeneratedModal.tsx]
//
// Детерминированно. Пропсы компонентов пока берутся из текст-слотов Pixso;
// точные имена пропсов сверяются с примерами сторибука через MCP get_examples
// (это следующий слой). Пакеты-импорты — плейсхолдеры, поправишь под свой UI-KIT.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const GENS = join(ROOT, 'gens');

const inPath = process.argv[2] ?? join(GENS, 'pixso-spec.json');
const outPath = process.argv[3] ?? join(GENS, 'GeneratedModal.tsx');
mkdirSync(dirname(outPath), { recursive: true });

const DF_PKG = '@ui-kit/df';
const PLASMA_PKG = '@ui-kit/plasma';

const CHILDREN = '$children'; // sentinel в prop-map: слот рендерится как текст-ребёнок

// slot -> prop, из data/prop-map.json (глобальный _default + пер-компонентные оверрайды)
const loadJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const PROP_MAP = loadJson(join(DATA, 'prop-map.json'), {
  _default: { Title: 'label', value: 'value', Placeholder: 'placeholder', Text: CHILDREN, Quantity: 'count' },
});
// валидный набор пропсов из реальных примеров (gens/component-props.json), для проверки
const COMPONENT_PROPS = loadJson(join(GENS, 'component-props.json'), {});

const mappingFor = (name) => ({ ...(PROP_MAP._default ?? {}), ...(PROP_MAP[name] ?? {}) });

const used = new Map(); // name -> kit ('df' | 'plasma' | 'local')
const use = (name, kit) => used.set(name, kit);
const warnings = [];

const esc = (s) => String(s).replace(/"/g, '&quot;');
const indent = (str, pad = '  ') => str.split('\n').map((l) => (l ? pad + l : l)).join('\n');

function propsFromSlots(slots, name) {
  const map = mappingFor(name);
  const valid = COMPONENT_PROPS[name]?.props; // undefined => валидацию пропускаем
  const props = [];
  let childText = null;
  for (const s of slots ?? []) {
    const p = map[s.slot];
    if (p == null) continue; // нет маппинга или явный null — выкидываем
    if (p === CHILDREN) { childText = s.text; continue; }
    if (valid && !valid.includes(p)) {
      warnings.push(`${name}: проп "${p}" (слот "${s.slot}") не найден в примерах. Есть: ${valid.join(', ') || '—'}`);
    }
    props.push(`${p}="${esc(s.text)}"`);
  }
  return { props, childText };
}

const renderList = (nodes) => (nodes ?? []).map(render).filter(Boolean).join('\n');
const frag = (inner) => `<>\n${indent(inner)}\n</>`;

/** ModalDF-подобный контейнер: зоны header/footer -> пропсы, остальное -> children. */
function partition(children) {
  const header = [], footer = [], body = [];
  for (const c of children ?? []) {
    if (c.kind === 'region') {
      const r = (c.region ?? '').toLowerCase();
      if (r.includes('content')) {
        const p = partition(c.children);
        header.push(...p.header); footer.push(...p.footer); body.push(...p.body);
        continue;
      }
      if (r.includes('footer')) { footer.push(...(c.children ?? [])); continue; }
      if (r.includes('header')) { header.push(...(c.children ?? [])); continue; }
    }
    body.push(c);
  }
  return { header, footer, body };
}

function renderContainer(node) {
  use(node.name, node.kit);
  const { header, footer, body } = partition(node.children);
  const attrs = [...propsFromSlots(node.slots, node.name).props];
  if (header.length) attrs.push(`header={(\n${indent(indent(frag(renderList(header))))}\n  )}`);
  if (footer.length) attrs.push(`footer={(\n${indent(indent(frag(renderList(footer))))}\n  )}`);

  const head = attrs.length ? `<${node.name}\n${indent(attrs.join('\n'))}\n>` : `<${node.name}>`;
  return `${head}\n${indent(renderList(body))}\n</${node.name}>`;
}

function render(node) {
  switch (node.kind) {
    case 'text':
      return `{${JSON.stringify(node.text)}}`;

    case 'icon':
      use('Icon', 'local');
      return `<Icon name="${esc(node.icon)}" />`;

    case 'flow': {
      use('Flow', 'plasma');
      const dir = node.direction === 'VERTICAL' ? 'column' : 'row';
      const gap = node.gap ? ` gap={${node.gap}}` : '';
      return `<Flow direction="${dir}"${gap}>\n${indent(renderList(node.children))}\n</Flow>`;
    }

    case 'region': {
      // вложенная зона (напр. "Header actions") — рендерим как Flow/фрагмент
      const inner = renderList(node.children);
      if (node.direction) {
        use('Flow', 'plasma');
        const dir = node.direction === 'VERTICAL' ? 'column' : 'row';
        return `{/* ${node.region} */}\n<Flow direction="${dir}">\n${indent(inner)}\n</Flow>`;
      }
      return `{/* ${node.region} */}\n${inner}`;
    }

    case 'fake': {
      use('Fake', 'local');
      const { props, childText } = propsFromSlots(node.slots, node.name);
      const attrs = props.length ? ' ' + props.join(' ') : '';
      return `{/* ⚠ не найдено в UI-KIT (DF/Plasma): "${node.name}" */}\n<Fake name="${esc(node.name)}"${attrs}>${childText ? esc(childText) : ''}</Fake>`;
    }

    case 'component': {
      use(node.name, node.kit);
      if (node.children) return renderContainer(node);
      const { props, childText } = propsFromSlots(node.slots, node.name);
      const attrs = props.length ? ' ' + props.join(' ') : '';
      if (childText != null) return `<${node.name}${attrs}>${esc(childText)}</${node.name}>`;
      return `<${node.name}${attrs} />`;
    }

    default:
      return '';
  }
}

// --- рендер тела ---
const spec = JSON.parse(readFileSync(inPath, 'utf8')).spec ?? [];
const bodyJsx = renderList(spec);

// --- импорты по китам ---
const names = (kit) => [...used].filter(([, k]) => k === kit).map(([n]) => n).sort();
const dfNames = names('df');
const plasmaNames = names('plasma');
const localNames = names('local');

const imports = [`import React from 'react';`];
if (dfNames.length) imports.push(`import { ${dfNames.join(', ')} } from '${DF_PKG}';`);
if (plasmaNames.length) imports.push(`import { ${plasmaNames.join(', ')} } from '${PLASMA_PKG}';`);

// локальные заглушки (Icon/Fake), чтобы файл был самодостаточным
const stubs = [];
if (localNames.includes('Icon'))
  stubs.push(`const Icon = ({ name }: { name: string }) => <span data-icon={name} />;`);
if (localNames.includes('Fake'))
  stubs.push(
    `// ⚠ заглушка для компонентов, не найденных в UI-KIT — замени вручную\n` +
      `const Fake = ({ name, children }: { name: string; children?: React.ReactNode }) => (\n` +
      `  <div data-fake={name} style={{ outline: '1px dashed red' }}>{children ?? name}</div>\n` +
      `);`,
  );

const file = `${imports.join('\n')}
${stubs.length ? '\n' + stubs.join('\n\n') + '\n' : ''}
export const GeneratedModal = () => {
  return (
${indent(indent(bodyJsx))}
  );
};
`;

writeFileSync(outPath, file);
console.log(`Готово: ${outPath}`);
console.log(`  Импорт из DF (${DF_PKG}): ${dfNames.join(', ') || '—'}`);
console.log(`  Импорт из Plasma (${PLASMA_PKG}): ${plasmaNames.join(', ') || '—'}`);
console.log(`  Локальные заглушки: ${localNames.join(', ') || '—'}`);

if (Object.keys(COMPONENT_PROPS).length === 0) {
  console.log(`  ⓘ component-props.json нет — валидация пропсов пропущена (запусти props-from-examples.mjs)`);
} else if (warnings.length) {
  console.log(`\n  ⚠ Предупреждения по пропсам (${[...new Set(warnings)].length}):`);
  for (const w of [...new Set(warnings)]) console.log(`    - ${w}`);
} else {
  console.log(`  ✔ Все пропсы совпали с примерами`);
}
