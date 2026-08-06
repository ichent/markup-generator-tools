# markup-generator-tools

Детерминированный конвейер: **Pixso JSON → TSX** по компонентам UI-KIT.  
Без LLM на пути генерации: скрипты чистят макет, резолвят имена в два кита (DF + Plasma) и собирают разметку.

## Схема работы

```
1) Pixso JSON
      │  экспорт объекта из Pixso
      ▼
2) clean-pixso.mjs
      │  убирает шум, роли (component/layout/region/…),
      │  слоты текста, direction/gap из autoLayout
      ▼  gens/pixso-clean.json
3a) resolve-pixso.mjs
      │  + data/storybook-df.json
      │  + data/strybook-plasma.json   ← index.json обоих китов
      │  имена → компоненты UI-KIT; layout → Flow; не найдено → fake
      ▼  gens/pixso-spec.json
3b) props-from-examples.mjs          ← отдельно, по возможности
      │  + те же index.json
      │  + исходники .stories.tsx (хотя бы одного кита)
      ▼  gens/component-props.json   (какие пропсы реально есть)
4) assemble-pixso.mjs
      │  + data/prop-map.json         (слот Pixso → имя пропа)
      │  + component-props.json       (проверка, если есть)
      ▼  gens/GeneratedModal.tsx
```

`npm run generate` = шаги **2 → 3a → 4**.  
Шаг **3b** не входит в generate — его запускают отдельно (`npm run props`).

### Два UI-KIT

| | DF (текущий) | Plasma (родительский) |
|--|--------------|------------------------|
| Имена | `data/storybook-df.json` | `data/strybook-plasma.json` |
| Приоритет при коллизии имён | выше | ниже |
| Исходники для пропсов | опционально | опционально |

Можно передать **оба** `index.json`, а исходники — **только одного** кита.  
Имена резолвятся по индексам; пропсы извлекаются только там, где есть `.stories.tsx`.  
Для кита без исходников пропсы задаются вручную в `data/prop-map.json`.

## Структура проекта

```
markup-generator-tools/
├── scripts/                 код
│   ├── generate.mjs         обёртка clean → resolve → assemble
│   ├── clean-pixso.mjs
│   ├── resolve-pixso.mjs
│   ├── assemble-pixso.mjs
│   └── props-from-examples.mjs
├── data/                    входные данные (правки руками)
│   ├── pixso-to-json.json   экспорт из Pixso
│   ├── storybook-df.json    index.json текущего UI-KIT
│   ├── strybook-plasma.json index.json родительского UI-KIT
│   └── prop-map.json        слот Pixso → проп компонента
├── gens/                    артефакты (в .gitignore, пересоздаются)
│   ├── pixso-clean.json
│   ├── pixso-spec.json
│   ├── component-props.json
│   └── GeneratedModal.tsx
└── package.json
```

Пути резолвятся от корня репозитория — можно запускать скрипты из любой директории.

## Быстрый старт

### 1. Подготовка данных

1. Экспортируй объект из Pixso как JSON → положи в `data/pixso-to-json.json`  
   (или передай путь аргументом).
2. Положи `index.json` сторибуков:
   - текущий кит → `data/storybook-df.json`
   - родительский → `data/strybook-plasma.json`  
     (допускается и имя `storybook-plasma.json`).

### 2. (Опционально) Извлечь пропсы из примеров

Нужен путь к **корню репозитория UI-KIT**, внутри которого лежат story-файлы  
(типа `packages/storybook/src/stories/...`).

```bash
# исходники только DF — нормально
npm run props -- /path/to/df-ui-kit

# или явно по китам
FRONTDRIVE_STORYBOOK_ROOT_DF=/path/to/df \
FRONTDRIVE_STORYBOOK_ROOT_PLASMA=/path/to/plasma \
npm run props
```

Результат: `gens/component-props.json`.

### 3. Сгенерировать вёрстку

```bash
npm run generate
# то же самое:
node scripts/generate.mjs

# свои пути:
node scripts/generate.mjs data/my-modal.json gens/MyModal.tsx
```

Готовый файл: `gens/GeneratedModal.tsx` (или путь из аргумента).

### 4. Подправить маппинг пропсов

`data/prop-map.json`:

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
  },
  "Button": {
    "Text": "$children",
    "Quantity": "count"
  }
}
```

- `$children` — слот идёт в текст-ребёнка, не в атрибут  
- `null` — слот выкинуть  
- ключи с `_` — комментарии, игнорируются  
- блок с именем компонента мержится поверх `_default`

После правок снова `npm run generate`.

## Переменные окружения

| Переменная | Назначение |
|------------|------------|
| `FRONTDRIVE_STORYBOOK_ROOT` | Общий ROOT исходников (фолбэк для обоих китов); можно передать argv |
| `FRONTDRIVE_STORYBOOK_ROOT_DF` | ROOT только для DF |
| `FRONTDRIVE_STORYBOOK_ROOT_PLASMA` | ROOT только для Plasma |
| `FRONTDRIVE_KITS_DIR` | Директория с `storybook-df.json` / `strybook-plasma.json` |
| `FRONTDRIVE_STORYBOOK_DF` | Полный путь к index DF |
| `FRONTDRIVE_STORYBOOK_PLASMA` | Полный путь к index Plasma |

По умолчанию индексы читаются из `data/`.

## Что делают отдельные шаги

| Скрипт | Вход | Выход |
|--------|------|--------|
| `clean-pixso.mjs` | сырой Pixso JSON | компактное дерево с ролями и слотами |
| `resolve-pixso.mjs` | clean + оба index | спека: kit, Flow, fake |
| `props-from-examples.mjs` | index + исходники | список валидных пропсов |
| `assemble-pixso.mjs` | spec + prop-map | TSX |
| `generate.mjs` | Pixso JSON | TSX (три шага подряд) |

### Как появляется Flow

FRAME/GROUP без семантики компонента → роль `layout`.  
Из Pixso `autoLayout.mode` берётся `HORIZONTAL` / `VERTICAL`, из `itemSpacing` — `gap`.  
Resolve превращает layout в `Flow` (Plasma).  
Assemble: `HORIZONTAL` → `direction="row"`, `VERTICAL` → `direction="column"`.

### Если компонент не найден

В спеке — `kind: "fake"` с именем из макета.  
В TSX — заглушка `<Fake name="...">` и комментарий. Никаких «похожих» подстановок.

## Типичный цикл на новую модалку

```bash
# один раз на машине (если есть исходники DF)
npm run props -- /path/to/df-ui-kit

# на каждый макет
# 1. положить экспорт Pixso в data/pixso-to-json.json
# 2. при необходимости поправить data/prop-map.json
npm run generate
# 3. забрать gens/GeneratedModal.tsx в продукт
```

## Требования

- Node.js (ESM, без внешних npm-зависимостей для пайплайна)
- Два `index.json` сторибука в `data/`
- Для точных пропсов — доступ к исходникам хотя бы одного UI-KIT
