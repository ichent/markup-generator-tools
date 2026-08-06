# markup-generator-tools

Детерминированный конвейер: **Pixso JSON → черновик TSX** по компонентам UI-KIT.  
Без LLM и **без доступа к исходникам** UI-KIT: достаточно двух `index.json` сторибука.

Точный API пропсов и «живая» вёрстка — следующий слой (**LLM + MCP**), либо ручной `prop-map.json`.  
Обогащение `index.json` (пропсы, алиасы) — с командой UI-KIT — улучшит и скрипты, и MCP.

## Схема

```
1) Pixso JSON
      │  экспорт объекта из Pixso
      ▼
2) clean-pixso.mjs
      │  шум ↓, роли, слоты текста, direction/gap из autoLayout
      ▼  gens/pixso-clean.json
3) resolve-pixso.mjs
      │  + data/storybook-df.json      ← index.json текущего UI-KIT
      │  + data/strybook-plasma.json  ← index.json родительского UI-KIT
      │  имена → компоненты; layout → Flow; не найдено → fake
      ▼  gens/pixso-spec.json
4) assemble-pixso.mjs
      │  + data/prop-map.json         ← уже в репо; правится руками (не генерится)
      ▼  gens/GeneratedModal.tsx     ← черновик, не финальный прод-код
      │
5) (позже) LLM + MCP
      │  get_component / get_examples по обоим китам
      ▼  рабочая вёрстка
```

`npm run generate` = шаги **2 → 3 → 4**.

### Что даёт `index.json`

| Да | Нет (пока) |
|----|------------|
| Список имён компонентов | Полный API пропсов* |
| Привязка к киту (DF / Plasma) | Примеры кода |
| Отсечение docs-only | |

\*Если команда UI-KIT положит пропсы/алиасы в index — скрипты и MCP смогут использовать это без исходников.

### Два UI-KIT

Оба индекса обязательны для полного резолва. При коллизии имён **DF побеждает Plasma**.  
Исходники репозиториев **не нужны**.

## Структура

```
markup-generator-tools/
├── scripts/
│   ├── generate.mjs         clean → resolve → assemble
│   ├── clean-pixso.mjs
│   ├── resolve-pixso.mjs
│   └── assemble-pixso.mjs
├── data/
│   ├── pixso-to-json.json   экспорт из Pixso
│   ├── storybook-df.json    index.json DF
│   ├── strybook-plasma.json index.json Plasma
│   └── prop-map.json        ручной конфиг (уже в репо): слот Pixso → проп
├── gens/                    артефакты (.gitignore)
└── package.json
```

## Быстрый старт

### 1. Данные

1. Экспорт из Pixso → `data/pixso-to-json.json` (или путь аргументом).
2. `index.json` текущего кита → `data/storybook-df.json`.
3. `index.json` родительского кита → `data/strybook-plasma.json`  
   (допускается имя `storybook-plasma.json`).

### 2. Генерация черновика

```bash
npm run generate
# или:
node scripts/generate.mjs
node scripts/generate.mjs data/my-modal.json gens/MyModal.tsx
```

Результат: `gens/GeneratedModal.tsx`.

### 3. Откуда берётся `data/prop-map.json`

Файл **уже лежит в репозитории** со стартовыми правилами. Скрипты его **не создают и не обновляют** — это ручной конфиг команды.

Зачем: в Pixso слоты называются по-дизайнерски (`Title`, `value`, `Quantity`), а в React — по API кита (`label`, `defaultValue`, …). `prop-map.json` говорит ассемблеру, как перевести слот в атрибут черновика.

| Что делать | Когда |
|------------|--------|
| Ничего | Первый прогон: хватит дефолтов из репо |
| Править руками | Увидел в черновике неверный проп → поправил маппинг → снова `npm run generate` |
| Не трогать | Если доводка идёт через LLM + MCP — маппинг можно оставить грубым |

Формат:

```json
{
  "_default": {
    "Title": "label",
    "value": "value",
    "Placeholder": "placeholder",
    "Text": "$children",
    "Quantity": "count"
  },
  "TextField": {
    "value": "defaultValue"
  }
}
```

- `_default` — общие правила для всех компонентов  
- `"TextField": { … }` — оверрайды для конкретного имени (мержатся поверх `_default`)  
- `$children` — слот идёт в текст-ребёнка, не в атрибут  
- `null` — слот выкинуть  
- ключи с `_` — комментарии, игнорируются  

Это **черновик имён пропсов**, не контракт UI-KIT. Истина API — у LLM + MCP или у вас в правках после генерации.

### 4. Доводка (следующий этап)

Черновик + `pixso-spec.json` → LLM вызывает MCP (`get_examples` и т.д.) по **обоим** UI-KIT и приводит код к рабочему API.  
Набор компонентов из спеки не менять; `fake` оставлять явными.

Индексы и `prop-map` читаются из `data/`. Путь к исходникам UI-KIT **не используется**.

## Шаги по отдельности

| Скрипт | Вход | Выход |
|--------|------|--------|
| `clean-pixso.mjs` | сырой Pixso | компактное дерево |
| `resolve-pixso.mjs` | clean + два index | спека (kit / Flow / fake) |
| `assemble-pixso.mjs` | spec + prop-map | черновик TSX |
| `generate.mjs` | Pixso JSON | черновик TSX |

### Flow

FRAME/GROUP без семантики компонента → `layout`.  
`autoLayout.mode` → `HORIZONTAL`/`VERTICAL`, `itemSpacing` → `gap`.  
Resolve → `Flow` (Plasma). Assemble: `row` / `column`.

### Не найдено в index

`kind: "fake"` + имя из макета → в TSX заглушка `<Fake>` и комментарий. Без подбора «похожего».

## Типичный цикл

```bash
# положить Pixso JSON и актуальные index.json в data/
npm run generate
# забрать gens/GeneratedModal.tsx → доводка LLM+MCP / руками
```

## Требования

- Node.js (ESM, без npm-зависимостей пайплайна)
- Два `index.json` сторибука в `data/`
