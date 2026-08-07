#!/usr/bin/env node

/**
 * UIKIT-MCP — единый MCP-сервер для обоих UI-KIT репозиториев.
 *
 *   node server.mjs <df-path> <finai-path>
 *   UIKIT_DF_ROOT=… UIKIT_FINAI_ROOT=… node server.mjs
 *
 * Важно: handshake (initialize) отвечает сразу; реестры строятся лениво
 * при первом tools/call — иначе Cursor даёт -32001 request timed out.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const DF_ROOT = process.argv[2] ?? process.env.UIKIT_DF_ROOT ?? null;
const FINAI_ROOT = process.argv[3] ?? process.env.UIKIT_FINAI_ROOT ?? null;

const DF_STORYBOOK = DF_ROOT ? join(DF_ROOT, 'packages/storybook') : null;
const FINAI_COMPONENTS = FINAI_ROOT ? join(FINAI_ROOT, 'src', 'components') : null;

function walk(dir, filter = () => true) {
  let results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) results = results.concat(walk(full, filter));
      else if (filter(entry.name)) results.push(full);
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

function buildDFRegistry() {
  if (!DF_STORYBOOK || !statSafe(DF_STORYBOOK)?.isDirectory()) return [];
  const storiesStories = join(DF_STORYBOOK, 'src', 'stories');
  if (!statSafe(storiesStories)?.isDirectory()) return [];

  const dirs = readdirSync(storiesStories).filter((d) =>
    statSafe(join(storiesStories, d))?.isDirectory(),
  );

  return dirs.map((dir) => {
    const storyDir = join(storiesStories, dir);
    const mdxPath = join(storyDir, dir + '.mdx');
    const content = readSafe(mdxPath);
    if (!content || !content.includes('import { Meta, Stories }')) return null;

    const storiesFiles = walk(storyDir, (n) =>
      n.endsWith('.stories.tsx') || n.endsWith('.stories.ts'),
    );

    const titleMatch = content.match(/^# (\S+)/m);
    const descMatch = content.match(/^# \S+\n\n([^\n]+(?:\n[^\n]+)*?)(?=##|$)/m);
    const exampleNames = [];

    for (const sf of storiesFiles) {
      const sc = readSafe(sf);
      if (!sc) continue;
      exampleNames.push(...[...sc.matchAll(/export const (\w+):/g)].map((m) => m[1]));
      const catM = sc.match(/title: ['"]([^'"]+)\/([^'"]+)['"]/);
      if (catM) {
        return {
          source: 'df',
          name: dir,
          title: catM[2],
          category: catM[1],
          description: descMatch
            ? descMatch[1].replace(/^> /gm, '').replace(/\n{2,}/g, '\n').trim()
            : '',
          examples: [...new Set(exampleNames)].slice(0, 10),
        };
      }
    }

    return {
      source: 'df',
      name: dir,
      title: titleMatch?.[1] || dir,
      category: '',
      description: descMatch
        ? descMatch[1].replace(/^> /gm, '').replace(/\n{2,}/g, '\n').trim()
        : '',
      examples: [...new Set(exampleNames)].slice(0, 10),
    };
  }).filter(Boolean);
}

function buildFINAIRegistry() {
  if (!FINAI_COMPONENTS || !statSafe(FINAI_COMPONENTS)?.isDirectory()) return [];

  const dirs = readdirSync(FINAI_COMPONENTS).filter((d) => {
    const p = join(FINAI_COMPONENTS, d);
    return statSafe(p)?.isDirectory() && !d.startsWith('_');
  });

  return dirs.map((dir) => {
    const compDir = join(FINAI_COMPONENTS, dir);
    const storiesFile = readdirSync(compDir).find(
      (f) => f.endsWith('.stories.tsx') || f.endsWith('.stories.ts'),
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

// Ленивая загрузка — не блокируем initialize
let dfRegistry = null;
let finaiRegistry = null;

function ensureRegistries() {
  if (dfRegistry && finaiRegistry) return;
  const t0 = Date.now();
  dfRegistry = buildDFRegistry();
  finaiRegistry = buildFINAIRegistry();
  console.error(
    `[UIKIT-MCP] Loaded ${dfRegistry.length} DF, ${finaiRegistry.length} FINAI ` +
      `(${Date.now() - t0}ms). DF_ROOT=${DF_ROOT ?? '—'} FINAI_ROOT=${FINAI_ROOT ?? '—'}`,
  );
}

function send(msg) {
  // JSON-RPC: либо result, либо error — не оба и не error:null
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function handleToolsCall(args) {
  ensureRegistries();

  const name = args?.name;
  const query = (args?.arguments?.query || '').toLowerCase();
  const limit = args?.arguments?.limit ?? 8;
  const sourceFilter = args?.arguments?.source ?? 'all';
  const toolArgs = args?.arguments ?? {};

  if (!DF_ROOT && !FINAI_ROOT) {
    return textResult(
      'UIKIT-MCP: не заданы пути к репозиториям. Укажи в mcp.json args или env UIKIT_DF_ROOT / UIKIT_FINAI_ROOT.',
    );
  }

  switch (name) {
    case 'search_components': {
      const all = [...dfRegistry, ...finaiRegistry];
      const scored = all
        .filter((c) => {
          if (sourceFilter !== 'all' && c.source !== sourceFilter) return false;
          const n = c.name.toLowerCase();
          return n.includes(query) || (c.description || '').toLowerCase().includes(query);
        })
        .map((c) => {
          let score = 0;
          const n = c.name.toLowerCase();
          if (n.includes(query)) score += 10;
          if ((c.description || '').toLowerCase().includes(query)) score += 5;
          return { ...c, score };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return textResult(
        scored.length
          ? scored
              .map((c, i) => {
                const cat = c.category ? ` [${c.category}]` : '';
                return `${i + 1}. ${c.name} (${c.source})${cat} — ${(c.description || '').substring(0, 100)}`;
              })
              .join('\n')
          : `Ничего не найдено по «${toolArgs.query}»`,
      );
    }

    case 'get_component': {
      const compName = toolArgs.name?.trim();
      const explicitSource = toolArgs.source ?? 'auto';
      let comp = null;

      if (explicitSource === 'auto') {
        comp = dfRegistry.find((c) => c.name.toLowerCase() === compName?.toLowerCase())
          ?? finaiRegistry.find((c) => c.name.toLowerCase() === compName?.toLowerCase());
      } else {
        const reg = explicitSource === 'df' ? dfRegistry : finaiRegistry;
        comp = reg.find((c) => c.name.toLowerCase() === compName?.toLowerCase());
      }

      if (!comp) return textResult(`Компонент «${compName}» не найден.`);

      return textResult(
        `# ${comp.name}  (${comp.source})\n` +
          `Категория: ${comp.category || 'Без категории'}\n` +
          `Что это: ${comp.description || 'Без описания'}\n\n` +
          `Примеры (stories): ${comp.examples.join(', ') || '—'}\n\n` +
          `Чтобы увидеть КОД — вызови get_examples("${comp.name}") с source="${comp.source}"`,
      );
    }

    case 'get_examples': {
      const compName = toolArgs.name?.trim();
      const forceSource = toolArgs.source;
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
      if (!comp) return textResult(`Нет примеров для «${compName}»`);

      let code = null;
      if (src === 'df' && DF_STORYBOOK) {
        const storyDir = join(DF_STORYBOOK, 'src', 'stories', comp.name);
        if (statSafe(storyDir)?.isDirectory()) {
          const storiesFiles = walk(storyDir, (n) =>
            n.endsWith('.stories.tsx') || n.endsWith('.stories.ts'),
          );
          if (storiesFiles.length) code = readSafe(storiesFiles[0]);
        }
      } else if (FINAI_COMPONENTS) {
        const compDir = join(FINAI_COMPONENTS, comp.name);
        if (statSafe(compDir)?.isDirectory()) {
          const storiesFile = readdirSync(compDir).find(
            (f) => f.endsWith('.stories.tsx') || f.endsWith('.stories.ts'),
          );
          if (storiesFile) code = readSafe(join(compDir, storiesFile));
        }
      }

      if (!code) return textResult(`Не удалось прочитать stories для «${compName}» (${src})`);
      return textResult(`// === ${src.toUpperCase()} UI-KIT: ${compName}\n\n${code}`);
    }

    case 'list_components': {
      const listSource = toolArgs.source ?? 'all';
      const listCategory = toolArgs.category;
      const parts = [];

      if (listSource === 'all' || listSource === 'df') {
        let items = [...dfRegistry];
        if (listCategory) items = items.filter((c) => c.category === listCategory);
        if (items.length) {
          parts.push(`## DF UI-KIT (${items.length} шт.)\n${items.map((c, i) => `${i + 1}. ${c.name}`).join('\n')}`);
        }
      }
      if (listSource === 'all' || listSource === 'finai') {
        const items = [...finaiRegistry];
        if (items.length) {
          parts.push(`## FINAI UI-KIT (${items.length} шт.)\n${items.map((c, i) => `${i + 1}. ${c.name}`).join('\n')}`);
        }
      }
      return textResult(parts.join('\n\n') || 'Ничего не найдено');
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

const TOOLS = [
  {
    name: 'search_components',
    description: 'Ищет компоненты UI-KIT (DF + FINAI) по имени/описанию. В результатах — источник df|finai.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Имя/алиас/ключевое слово' },
        limit: { type: 'number', description: 'Сколько результатов (по умолч. 8)' },
        source: { type: 'string', enum: ['df', 'finai', 'all'], description: 'Фильтр источника' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_component',
    description: 'Карточка компонента: описание, категория, примеры. Источник df/finai.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Каноническое имя' },
        source: { type: 'string', enum: ['df', 'finai', 'auto'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_examples',
    description: 'Реальный код stories компонента.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        source: { type: 'string', enum: ['df', 'finai'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_components',
    description: 'Список компонентов с группировкой по источнику.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['df', 'finai', 'all'] },
        category: { type: 'string', description: 'Фильтр категории (df)' },
      },
    },
  },
];

async function main() {
  console.error(
    `[UIKIT-MCP] ready (lazy registries). DF_ROOT=${DF_ROOT ?? '—'} FINAI_ROOT=${FINAI_ROOT ?? '—'}`,
  );

  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      const { method, params, id } = msg;
      // уведомления без id — игнор (в т.ч. notifications/initialized от клиента)
      if (id === undefined || id === null) continue;

      try {
        switch (method) {
          case 'initialize':
            ok(id, {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'UIKIT-MCP', version: '1.0.1' },
              capabilities: { tools: {} },
            });
            break;

          case 'ping':
            ok(id, {});
            break;

          case 'tools/list':
            ok(id, { tools: TOOLS });
            break;

          case 'tools/call':
            ok(id, handleToolsCall(params));
            break;

          default:
            fail(id, -32601, `Unknown method: ${method}`);
        }
      } catch (e) {
        fail(id, e.code ?? -32603, e.message || String(e));
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
