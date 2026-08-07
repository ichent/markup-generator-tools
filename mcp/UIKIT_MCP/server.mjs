#!/usr/bin/env node

/**
 * UIKIT-MCP — единый MCP-сервер для обоих UI-KIT репозиториев.
 *
 * Принимает пути к обоим репозиториям при старте:
 *   node server.mjs <df-path> <finai-path>
 *
 * Или через env:
 *   UIKIT_DF_ROOT=<path> UIKIT_FINAI_ROOT=<path> node server.mjs
 *
 * Инструменты:
 *   search_components  — ищет по обоим реестрам с пометкой источника
 *   get_component      — возвращает карточку с указанием df/finai
 *   get_examples       — читает stories из нужного репозитория
 *   list_components    — перечисляет с группировкой по источнику
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// ── paths ──────────────────────────────────────────────────────────────────

const DF_ROOT = process.argv[2] ?? process.env.UIKIT_DF_ROOT;
const FINAI_ROOT = process.argv[3] ?? process.env.UIKIT_FINAI_ROOT;

if (!DF_ROOT || !FINAI_ROOT) {
  console.error('');
  console.error('  Usage: UIKIT-MCP <path-to-digital_finance_ui> <path-to-sdds-finai>');
  console.error('');
  console.error('  or via env:');
  console.error('    UIKIT_DF_ROOT=/path/to/df UIKIT_FINAI_ROOT=/path/to/finai node server.mjs');
  console.error('');
  process.exit(1);
}

const DF_STORYBOOK = join(DF_ROOT, 'packages/storybook');
const FINAI_COMPONENTS = join(FINAI_ROOT, 'src', 'components');

// ── helpers ─────────────────────────────────────────────────────────────────

function walk(dir, filter = () => true) {
  let results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(walk(full, filter));
      } else if (filter(entry.name)) {
        results.push(full);
      }
    }
  } catch { /* skip */ }
  return results;
}

function readSafe(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function statSafe(path) {
  try { return statSync(path); } catch { return null; }
}

// ── registry builders ──────────────────────────────────────────────────────

function buildDFRegistry() {
  if (!statSafe(DF_STORYBOOK)?.isDirectory()) return [];

  const storiesStories = join(DF_STORYBOOK, 'src', 'stories');
  if (!statSafe(storiesStories)?.isDirectory()) return [];

  const dirs = readdirSync(storiesStories).filter((d) => {
    const p = join(storiesStories, d);
    return statSafe(p)?.isDirectory();
  });

  return dirs.map((dir) => {
    const storyDir = join(storiesStories, dir);
    const mdxPath = join(storyDir, dir + '.mdx');
    const content = readSafe(mdxPath);
    if (!content || !content.includes('import { Meta, Stories }')) return null;

    const storiesFiles = walk(storyDir, (n) => n.endsWith('.stories.tsx') || n.endsWith('.stories.ts'));

    const titleMatch = content.match(/^# (\S+)/m);
    const descMatch = content.match(/^# \S+\n\n([^\n]+(?:\n[^\n]+)*?)(?=##|$)/m);

    const exampleNames = [];
    const category = '';
    for (const sf of storiesFiles) {
      const sc = readSafe(sf);
      if (sc) {
        exampleNames.push(...[...sc.matchAll(/export const (\w+):/g)].map((m) => m[1]));
        const catM = sc.match(/title: ['"]([^'"]+)\/([^'"]+)['"]/);
        if (catM) return {
          source: 'df',
          name: dir,
          title: catM[2],
          category: catM[1],
          description: descMatch ? descMatch[1].replace(/^> /gm, '').replace(/\n{2,}/g, '\n').trim() : '',
          examples: [...new Set(exampleNames)].slice(0, 10),
        };
      }
    }

    return {
      source: 'df',
      name: dir,
      title: titleMatch?.[1] || dir,
      category: '',
      description: descMatch ? descMatch[1].replace(/^> /gm, '').replace(/\n{2,}/g, '\n').trim() : '',
      examples: [...new Set(exampleNames)].slice(0, 10),
    };
  }).filter(Boolean);
}

function buildFINAIRegistry() {
  if (!statSafe(FINAI_COMPONENTS)?.isDirectory()) return [];

  const dirs = readdirSync(FINAI_COMPONENTS).filter((d) => {
    const p = join(FINAI_COMPONENTS, d);
    return statSafe(p)?.isDirectory() && !d.startsWith('_');
  });

  return dirs.map((dir) => {
    const compDir = join(FINAI_COMPONENTS, dir);
    const storiesFile = readdirSync(compDir).find(
      (f) => (f.endsWith('.stories.tsx') || f.endsWith('.stories.ts'))
    );

    if (!storiesFile) {
      return { source: 'finai', name: dir, title: '', category: '', description: '', examples: [] };
    }

    const code = readSafe(join(compDir, storiesFile));
    if (!code) {
      return { source: 'finai', name: dir, title: '', category: '', description: '', examples: [] };
    }

    const titleMatch = code.match(/title: ['"]([^'"]+)\/([^'"]+)['"]/);

    return {
      source: 'finai',
      name: dir,
      title: titleMatch?.[2] || dir,
      category: titleMatch?.[1] || '',
      description: '',
      examples: [...code.matchAll(/export const (\w+):/g)].map((m) => m[1]),
    };
  }).filter((c) => c.examples.length > 0 || c.title);
}

// ── registries ─────────────────────────────────────────────────────────────

const dfRegistry = buildDFRegistry();
const finaiRegistry = buildFINAIRegistry();

console.error(`[UIKIT-MCP] Loaded ${dfRegistry.length} DF components, ${finaiRegistry.length} FINAI components`);

// ── MCP server ─────────────────────────────────────────────────────────────

function send(stdout, msg) {
  stdout.write(JSON.stringify(msg) + '\n');
}

async function main() {
  const stdin = process.stdin;
  const stdout = process.stdout;

  let buffer = '';

  for await (const chunk of stdin) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      const { method, params, id } = msg;
      if (!id) continue;

      let result = null;
      let error = null;

      try {
        switch (method) {
          case 'initialize': {
            send(stdout, { jsonrpc: '2.0', id, result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'UIKIT-MCP', version: '1.0.0' },
              capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
            }});
            // notifications/initialized отправляем ПОСЛЕ ответа на initialize
            send(stdout, { jsonrpc: '2.0', method: 'notifications/initialized' });
            continue;
          }

          case 'tools/list': {
            result = {
              tools: [
                {
                  name: 'search_components',
                  description: 'Ищет компоненты UI-KIT (DF + FINAI) по имени, описанию или фиче. В результатах указан источник: df или finai.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      query: { type: 'string', description: 'Имя/алиас/ключевое слово' },
                      limit: { type: 'number', description: 'Сколько результатов (по умолч. 8)' },
                      source: { type: 'string', description: 'Фильтр: "df", "finai" или "all" (по умолч.)', enum: ['df', 'finai', 'all'] },
                    },
                    required: ['query'],
                  },
                },
                {
                  name: 'get_component',
                  description: 'Возвращает карточку компонента: описание, категорию, примеры. Источник (df/finai) определяется автоматически.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'Каноническое имя компонента' },
                      source: { type: 'string', description: 'Опционально: "df", "finai" или "auto" (по умолч.)', enum: ['df', 'finai', 'auto'] },
                    },
                    required: ['name'],
                  },
                },
                {
                  name: 'get_examples',
                  description: 'Возвращает реальный код stories компонента. Источник определяется автоматически по имени.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'Каноническое имя компонента' },
                      source: { type: 'string', description: 'Опционально: "df" или "finai" для принудительного выбора', enum: ['df', 'finai'] },
                    },
                    required: ['name'],
                  },
                },
                {
                  name: 'list_components',
                  description: 'Перечисляет компоненты UI-KIT с группировкой по источнику (df / finai).',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      source: { type: 'string', description: '"df", "finai" или "all" (по умолч.)', enum: ['df', 'finai', 'all'] },
                      category: { type: 'string', description: 'Фильтр по категории (только для df)' },
                    },
                  },
                },
              ],
            };
            break;
          }

          case 'tools/call': {
            const { name, arguments: args } = params;
            const query = (args?.query || '').toLowerCase();
            const limit = args?.limit ?? 8;
            const sourceFilter = args?.source ?? 'all';

            switch (name) {
              case 'search_components': {
                const all = [
                  ...dfRegistry.map((c) => ({ ...c, score: 0 })),
                  ...finaiRegistry.map((c) => ({ ...c, score: 0 })),
                ];

                const scored = all
                  .filter((c) => {
                    // filter by source
                    if (sourceFilter !== 'all' && c.source !== sourceFilter) return false;
                    const n = c.name.toLowerCase();
                    return n.includes(query) || c.description.toLowerCase().includes(query);
                  })
                  .map((c) => {
                    const n = c.name.toLowerCase();
                    if (n.includes(query)) c.score += 10;
                    if (c.description?.toLowerCase().includes(query)) c.score += 5;
                    return c;
                  })
                  .filter((c) => c.score > 0)
                  .sort((a, b) => b.score - a.score)
                  .slice(0, limit);

                result = {
                  content: [{
                    type: 'text',
                    text: scored.length > 0
                      ? scored.map((c, i) => {
                          const src = c.source === 'df' ? 'df' : 'finai';
                          const cat = c.category ? ` [${c.category}]` : '';
                          return `${i + 1}. ${c.name} (${src})${cat} — ${c.description?.substring(0, 100) || ''}`;
                        }).join('\n')
                      : `Ничего не найдено по «${args?.query}»`,
                  }],
                };
                break;
              }

              case 'get_component': {
                const compName = args?.name?.trim();
                const explicitSource = args?.source ?? 'auto';

                let comp = null;
                let foundSource = '';

                if (explicitSource === 'auto') {
                  // try DF first (it has richer descriptions)
                  comp = dfRegistry.find((c) => c.name.toLowerCase() === compName?.toLowerCase());
                  foundSource = 'df';
                  if (!comp) {
                    comp = finaiRegistry.find((c) => c.name.toLowerCase() === compName?.toLowerCase());
                    foundSource = 'finai';
                  }
                } else {
                  const reg = explicitSource === 'df' ? dfRegistry : finaiRegistry;
                  comp = reg.find((c) => c.name.toLowerCase() === compName?.toLowerCase());
                  foundSource = explicitSource;
                }

                if (!comp) {
                  result = { content: [{ type: 'text', text: `Компонент «${compName}» не найден.` }] };
                  break;
                }

                const srcLabel = comp.source === 'df' ? 'df' : 'finai';
                result = {
                  content: [{
                    type: 'text',
                    text: `# ${comp.name}  (${srcLabel})\n` +
                          `Категория: ${comp.category || 'Без категории'}\n` +
                          `Что это: ${comp.description || 'Без описания'}\n\n` +
                          `Примеры (stories): ${comp.examples.join(', ') || '—'}\n\n` +
                          `Чтобы увидеть КОД — вызови get_examples("${comp.name}", source="${srcLabel}")`,
                  }],
                };
                break;
              }

              case 'get_examples': {
                const compName = args?.name?.trim();
                const forceSource = args?.source;

                // Determine source
                let comp = dfRegistry.find((c) => c.name.toLowerCase() === compName?.toLowerCase());
                let src = 'df';

                if (!comp) {
                  comp = finaiRegistry.find((c) => c.name.toLowerCase() === compName?.toLowerCase());
                  src = 'finai';
                }

                if (forceSource) {
                  const reg = forceSource === 'df' ? dfRegistry : finaiRegistry;
                  comp = reg.find((c) => c.name.toLowerCase() === compName?.toLowerCase());
                  src = forceSource;
                }

                if (!comp) {
                  result = { content: [{ type: 'text', text: `Нет примеров для «${compName}»` }] };
                  break;
                }

                let code = null;

                if (src === 'df') {
                  // find stories file
                  const storyDir = join(DF_STORYBOOK, 'src', 'stories', comp.name);
                  if (statSafe(storyDir)?.isDirectory()) {
                    const storiesFiles = walk(storyDir, (n) => n.endsWith('.stories.tsx') || n.endsWith('.stories.ts'));
                    if (storiesFiles.length > 0) {
                      code = readSafe(storiesFiles[0]);
                    }
                  }
                } else {
                  // FINAI
                  const compDir = join(FINAI_COMPONENTS, comp.name);
                  if (statSafe(compDir)?.isDirectory()) {
                    const storiesFile = readdirSync(compDir).find(
                      (f) => f.endsWith('.stories.tsx') || f.endsWith('.stories.ts')
                    );
                    if (storiesFile) {
                      code = readSafe(join(compDir, storiesFile));
                    }
                  }
                }

                if (!code) {
                  result = { content: [{ type: 'text', text: `Не удалось прочитать stories для «${compName}» (${src})` }] };
                  break;
                }

                result = {
                  content: [{
                    type: 'text',
                    text: `// === ${src.toUpperCase()} UI-KIT: ${compName}\n\n${code}`,
                  }],
                };
                break;
              }

              case 'list_components': {
                const listSource = args?.source ?? 'all';
                const listCategory = args?.category;

                let parts = [];

                if (listSource === 'all' || listSource === 'df') {
                  let items = [...dfRegistry];
                  if (listCategory) items = items.filter((c) => c.category === listCategory);
                  if (items.length > 0) {
                    parts.push(`## DF UI-KIT (${items.length} шт.)\n${items.map((c, i) => `${i + 1}. ${c.name}`).join('\n')}`);
                  }
                }

                if (listSource === 'all' || listSource === 'finai') {
                  let items = [...finaiRegistry];
                  if (items.length > 0) {
                    parts.push(`## FINAI UI-KIT (${items.length} шт.)\n${items.map((c, i) => `${i + 1}. ${c.name}`).join('\n')}`);
                  }
                }

                result = {
                  content: [{
                    type: 'text',
                    text: parts.join('\n\n') || 'Ничего не найдено',
                  }],
                };
                break;
              }

              default:
                error = { code: -32601, message: `Unknown tool: ${name}` };
            }
            break;
          }

          default:
            error = { code: -32601, message: `Unknown method: ${method}` };
        }
      } catch (e) {
        error = { code: -32603, message: e.message || String(e) };
      }

      send(stdout, { jsonrpc: '2.0', id, error, result });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
