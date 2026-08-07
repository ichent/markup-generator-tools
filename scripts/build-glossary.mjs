#!/usr/bin/env node
// Ubiquitous language: собрать глоссарий компонентов из Storybook index.json
//
// Запуск:
//   node build-glossary.mjs ./storybook-static/index.json [флаги]
//
// Флаги (опциональны, по умолчанию выключены):
//   --seed-overlay    заполнить overlay.json черновыми summary/whenToUse (B)
//   --merge-overlay   вмерджить overlay.json (смысл + алиасы Pixso) в артефакты (A)
//   --help            показать справку
//
// Ничего не скачивает, не требует npm install, не ходит в интернет.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. аргументы и флаги ---
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const indexPath = args.find((a) => !a.startsWith("--"));
const SEED = flags.has("--seed-overlay");   // B: черновые описания в overlay.json
const MERGE = flags.has("--merge-overlay");  // A: overlay -> glossary.json + GLOSSARY.md

if (flags.has("--help") || !indexPath) {
  console.log(`Использование:
  node build-glossary.mjs <path/to/index.json> [флаги]

Флаги:
  --seed-overlay    заполнить overlay.json черновыми summary/whenToUse по известным
                    компонентам (не затирает уже заполненные вручную поля)
  --merge-overlay   вмерджить overlay.json (summary/whenToUse/aliasesPixso)
                    в glossary.json и GLOSSARY.md
  --help            показать эту справку`);
  process.exit(indexPath ? 0 : 1);
}
const index = JSON.parse(readFileSync(indexPath, "utf8"));
const entries = Object.values(index.entries ?? {});

// --- 2. группируем записи по title (title = имя компонента) ---
const byTitle = new Map();
for (const e of entries) {
  if (!e.title) continue;
  if (!byTitle.has(e.title)) byTitle.set(e.title, []);
  byTitle.get(e.title).push(e);
}

// имя компонента — это идентификатор (PascalCase/camelCase), а не фраза с пробелами
const isComponentName = (name) => /^[A-Za-z][A-Za-z0-9]*$/.test(name);

// словарь черновых описаний для --seed-overlay (составлен вручную, без LLM)
// формат: term -> [summary, whenToUse]
const SEED_DICT = {
  Autocomplete: ["Поле ввода с подсказками из списка по мере набора.", "Выбор из большого набора значений с поиском."],
  AutocompleteSearch: ["Autocomplete в режиме поиска по данным.", "Поиск с подсказками по большому справочнику."],
  Box: ["Базовый контейнер-обёртка для лейаута и отступов.", "Нейтральный блок под вёрстку без своей семантики."],
  Collapse: ["Сворачиваемая секция контента.", "Контент нужно скрывать/раскрывать по клику."],
  Drawer: ["Боковая выезжающая панель поверх контента.", "Второстепенные действия/детали сбоку, не блокируя поток."],
  Modal: ["Модальное окно поверх контента, требует явного закрытия.", "Блокирующие сценарии: подтверждение, форма поверх контента."],
  ModalConfirmation: ["Модалка подтверждения действия (да/нет).", "Подтверждение необратимого или важного действия."],
  Popover: ["Всплывающий блок, привязанный к элементу-триггеру.", "Контекстные действия/инфо рядом с элементом."],
  Popup: ["Всплывающее окно поверх контента.", "Небольшой контент поверх страницы без полной блокировки."],
  Switch: ["Переключатель вкл/выкл (тумблер).", "Булевы настройки с мгновенным применением."],
  TextArea: ["Многострочное поле ввода текста.", "Длинный текст: комментарии, описания."],
  TextField: ["Однострочное поле ввода текста.", "Короткие значения: имя, email и т.п."],
  TextFieldSearch: ["Поле ввода в режиме поиска.", "Строка поиска по списку/таблице."],
  Tooltip: ["Всплывающая подсказка при наведении.", "Короткое пояснение к элементу без клика."],
  TooltipList: ["Тултип со списком элементов.", "В подсказке нужно показать перечень."],
  Typography: ["Типографика: заголовки, текст, стили шрифта.", "Единый способ выводить текст по дизайн-системе."],
  Notification: ["Уведомление о событии/статусе.", "Неблокирующее сообщение пользователю."],
  Table: ["Таблица данных с набором фич (сортировка, фильтры, группировка).", "Отображение и работа с табличными данными."],
  TableCanvas: ["Высокопроизводительная таблица на canvas.", "Большие объёмы данных: виртуализация и скорость."],
  Container: ["Композиционный контейнер страницы/блока.", "Группировка контента в лейауте."],
  Layout: ["Каркас страницы (сетка/области).", "Общая структура экрана."],
  PageLayout: ["Каркас страницы с типовыми зонами.", "Стандартный лейаут страницы приложения."],
  PageTitle: ["Заголовок страницы.", "Шапка с названием текущего раздела."],
  EmptyState: ["Заглушка «нет данных».", "Список/таблица пусты — объяснить и предложить действие."],
  Widget: ["Виджет — самостоятельный блок на дашборде.", "Переиспользуемый блок с данными/действиями."],
};

// подбираем описание по term, учитывая суффикс DF (ModalDF -> Modal и т.п.)
function seedFor(term) {
  const d = SEED_DICT[term] ?? SEED_DICT[term.replace(/DF/, "")];
  return d ? { summary: d[0], whenToUse: d[1] } : null;
}

// --- 3. первичный разбор групп ---
const rawComponents = []; // есть примеры И имя похоже на компонент
const suspicious = [];    // есть примеры, но имя — фраза (скорее страница-пример)
const docsOnly = [];      // только документация, без примеров => скорее всего не компонент
for (const [title, group] of byTitle) {
  const term = title.split("/").pop();            // "Components/Modal" -> "Modal"
  const groupPath = title.split("/").slice(0, -1).join("/"); // "Components"
  const stories = group
    .filter((e) => e.type === "story")
    .map((e) => e.name);
  const importPath = group.find((e) => e.importPath)?.importPath ?? null;

  const record = {
    id: title,          // полный title = уникальный ключ (без коллизий)
    term,               // короткое имя для удобства
    group: groupPath,   // категория из структуры сторибука
    stories,
    source: importPath,
  };

  if (stories.length === 0) docsOnly.push(record);
  else if (isComponentName(term)) rawComponents.push(record);
  else suspicious.push(record);
}
suspicious.sort((a, b) => a.term.localeCompare(b.term));
docsOnly.sort((a, b) => a.term.localeCompare(b.term));

// --- 3.5 сворачиваем агрегаты ---
// Правило (доменное решение): title из 2 сегментов ("Категория/Term") — самостоятельный
// компонент. Title из >2 сегментов — это ФИЧА агрегата segs[1] (напр. Table, TableCanvas):
// сам агрегат становится ОДНИМ компонентом, а вложенное уходит в его список features.
const byId = new Map();
const ensure = (id, term, category, source, kind) => {
  if (!byId.has(id)) {
    byId.set(id, { id, term, group: category, kind, stories: [], features: [], source });
  }
  return byId.get(id);
};
for (const r of rawComponents) {
  const segs = r.id.split("/");
  const category = segs[0];
  if (segs.length <= 2) {
    const c = ensure(r.id, r.term, category, r.source, "component");
    c.stories.push(...r.stories);
  } else {
    const aggTerm = segs[1];
    const agg = ensure(`${category}/${aggTerm}`, aggTerm, category, null, "aggregate");
    agg.kind = "aggregate";
    agg.features.push({ name: segs.slice(2).join(" / "), examples: r.stories.length, source: r.source });
  }
}
const components = [...byId.values()].sort((a, b) => a.term.localeCompare(b.term));

// схлопываем дубликаты фич по имени (суммируем кол-во примеров)
for (const c of components) {
  if (!c.features.length) continue;
  const merged = new Map();
  for (const f of c.features) {
    const prev = merged.get(f.name);
    if (prev) prev.examples += f.examples;
    else merged.set(f.name, { ...f });
  }
  c.features = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const byCategory = new Map();
for (const c of components) byCategory.set(c.group, (byCategory.get(c.group) ?? 0) + 1);

const glossary = {
  version: 1,
  boundedContext: "design-system",
  generatedAt: new Date().toISOString(),
  components,
};

// --- 4. overlay: синхронизируем ключи (не теряя ручные правки) + опц. сидинг ---
const overlayPath = join(here, "overlay.json");
const existingOverlay = existsSync(overlayPath)
  ? JSON.parse(readFileSync(overlayPath, "utf8")).components ?? {}
  : {};
const overlayComponents = {};
let seeded = 0;
for (const c of components) {
  const prev = existingOverlay[c.id] ?? {};
  const entry = {
    summary: prev.summary ?? "",       // одна строка: что это
    whenToUse: prev.whenToUse ?? "",   // когда использовать
    aliasesPixso: prev.aliasesPixso ?? [], // имена в Pixso — это ACL
  };
  if (SEED && !entry.summary) {         // сидим только пустые, ручное не трогаем
    const s = seedFor(c.term);
    if (s) {
      entry.summary = s.summary;
      if (!entry.whenToUse) entry.whenToUse = s.whenToUse;
      seeded++;
    }
  }
  overlayComponents[c.id] = entry;
}
writeFileSync(overlayPath, JSON.stringify({ components: overlayComponents }, null, 2) + "\n");

// --- 5. (опц.) вмердживаем overlay в компоненты, чтобы смысл попал в артефакты ---
if (MERGE) {
  for (const c of components) {
    const o = overlayComponents[c.id];
    if (!o) continue;
    if (o.summary) c.summary = o.summary;
    if (o.whenToUse) c.whenToUse = o.whenToUse;
    if (o.aliasesPixso?.length) c.aliasesPixso = o.aliasesPixso;
  }
}

// --- 5.1 пишем машиночитаемый глоссарий ---
writeFileSync(join(here, "glossary.json"), JSON.stringify(glossary, null, 2) + "\n");

// --- 6. отделяем шум в свои файлы, чтобы глазами проверить ---
writeFileSync(join(here, "docs-only.json"),
  JSON.stringify({ items: docsOnly }, null, 2) + "\n");
writeFileSync(join(here, "suspicious.json"),
  JSON.stringify({ items: suspicious }, null, 2) + "\n");

// --- 6.5 читаемый GLOSSARY.md = сам ubiquitous language ---
const cats = new Map(); // категория -> [компоненты и агрегаты]
for (const c of components) {
  if (!cats.has(c.group)) cats.set(c.group, []);
  cats.get(c.group).push(c);
}

let md = `# Ubiquitous Language — Design System\n\n`;
md += `> Сгенерировано автоматически из Storybook \`index.json\`. Не редактируй руками — правь через overlay.\n\n`;
md += `Всего терминов: **${components.length}**\n`;
for (const [category, list] of [...cats].sort((a, b) => b[1].length - a[1].length)) {
  md += `\n## ${category} (${list.length})\n\n`;
  const plain = list.filter((c) => c.kind === "component").sort((a, b) => a.term.localeCompare(b.term));
  const aggs = list.filter((c) => c.kind === "aggregate").sort((a, b) => a.term.localeCompare(b.term));
  for (const c of plain) {
    md += `- **${c.term}** — ${c.stories.length} прим.`;
    if (c.summary) md += ` — ${c.summary}`;
    md += `\n`;
    if (c.aliasesPixso?.length) md += `  - Pixso: ${c.aliasesPixso.join(", ")}\n`;
  }
  for (const a of aggs) {
    md += `\n### ${a.term} (агрегат · ${a.features.length} фич)\n\n`;
    if (a.summary) md += `${a.summary}\n\n`;
    if (a.aliasesPixso?.length) md += `Pixso: ${a.aliasesPixso.join(", ")}\n\n`;
    for (const f of a.features) md += `- ${f.name} — ${f.examples} прим.\n`;
  }
}
writeFileSync(join(here, "GLOSSARY.md"), md);

// --- 7. краткий отчёт ---
const nComp = components.filter((c) => c.kind === "component").length;
const nAgg = components.filter((c) => c.kind === "aggregate").length;
console.log(`Готово.`);
console.log(`  Терминов всего:                    ${components.length}  -> glossary.json`);
console.log(`    из них самостоятельных:          ${nComp}`);
console.log(`    из них агрегатов (с фичами):     ${nAgg}`);
console.log(`  Подозрительные (имя-фраза):        ${suspicious.length}  -> suspicious.json`);
console.log(`  Без примеров (docs-only):          ${docsOnly.length}  -> docs-only.json`);
console.log(`\nКатегории:`);
for (const [cat, n] of [...byCategory].sort((a, b) => b[1] - a[1])) {
  console.log(`  - ${cat}: ${n}`);
}
console.log(`\nАгрегаты:`);
for (const c of components.filter((c) => c.kind === "aggregate")) {
  console.log(`  - ${c.term}: ${c.features.length} фич`);
}
console.log(`\nФлаги: --seed-overlay=${SEED} --merge-overlay=${MERGE}`);
if (SEED) console.log(`  засижено черновых описаний: ${seeded}`);
if (MERGE) console.log(`  overlay вмерджен в glossary.json и GLOSSARY.md`);
