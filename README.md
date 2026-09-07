# Webdemo

Конструктор экспериментальных протоколов и витрина когнитивных микроигр.
В репозитории остаются только платформенные пакеты (`core`, `games`,
`protocol`, `ui-web`), веб-витрина `apps/showcase` и настольное приложение
`apps/experiment`.

Симуляция автомобиля и заезд вынесены в `projects/games/car`, а пакеты стихий
и их стенды — в `projects/games/elements` и `projects/games/elements-stand`.
Реализованная система описана в `../docs/architecture.md`, замысел и план — в
`../microgame-architecture.md`, правила для авторов модулей — в
`packages/games/AUTHORING.md`.

## Запуск

```bash
npm install
npm run dev        # витрина протокола на http://localhost:5173
npm test           # контракт, восстановление, оркестрация, расписание, длинная сессия
npm run typecheck
npm run build      # сборка витрины в apps/showcase/dist
npm run experiment:dev    # Tauri host на macOS, protocols/data рядом в apps/experiment/portable
npm run experiment:test   # Rust storage + настоящий LSL loopback
npm run experiment:build  # macOS .app bundle в apps/experiment/build/macos
npm run experiment:build:windows # Windows x64 portable ZIP локально на macOS
```

Флаги Vite передаются через workspace напрямую, иначе npm съест их как позиционные аргументы:

```bash
npm run dev --workspace @gamespace/showcase -- --port 5188
```

## Модули протокола

| id | что измеряет |
|---|---|
| `org.reconnect.arithmetic` | скорость счёта под давлением времени |
| `org.reconnect.n-back` | рабочая память, глубина N |
| `org.reconnect.stroop` | подавление интерференции, цена конфликта |
| `org.reconnect.rule-switch` | цена переключения между правилами |
| `org.reconnect.dual-load` | цена совмещения двух задач |
| `org.reconnect.number-sequence` | фоновая задача с возвратом после прерывания |
| `org.reconnect.squash` | аркада на канвасе: непрерывное слежение и моторный контроль, блок по времени |
| `org.reconnect.baseline` | покой с инструкцией и таймером: участок расписания как обычный модуль |
| `org.reconnect.adaptive-battery` | оркестратор: блоки разных задач подряд |
| `org.reconnect.interrupt-resume` | оркестратор: прерывание и лаг возобновления |

## Длина блока

Манифест называет параметр, который задаёт длину блока: `"blockLength": { "param": "blockMs", "unit": "ms" }`. Единица `count` означает счёт проб или подблоков, `ms` — время. В витрине этот параметр вынесен в отдельный раздел «Блок» над сложностью и меняется при любой политике, потому что расписание не должно зависеть от адаптации; кнопка «по уровню» возвращает значение, которое даёт текущий уровень.

## Протокол эксперимента

Сценарий — это документ, а не код: `packages/protocol/schema/protocol.schema.json` описывает участки, стратегии завершения (`by-time`, `by-runs`, `run-limit`, `first`), политики сложности и контрбалансировку. Пилотный сценарий на 110 минут лежит в `packages/protocol/examples/reconnect-pilot.json`.

В витрине он доступен в левой панели под заголовком «Сценарий»: участки можно сжать до десятков секунд, увидеть предпросмотр расписания и выгрузить общий журнал сессии.

## Публикация

Сайт живёт на GitHub Pages: <https://reconnectmind.github.io/demo_games/>.
Корень сайта — витрина протокола.

Сборку делает `.github/workflows/deploy-pages.yml` при пуше в `main` (или
вручную через `workflow_dispatch`): `npm ci` → `typecheck` → `test` → `build`,
и только потом публикуется `apps/showcase/dist`.

Репозиторий публичный, так что минуты Actions и Pages бесплатны.

Windows-лабораторная сборка создаётся workflow
`.github/workflows/experiment-windows.yml` как portable ZIP с executable,
fixed WebView2, пилотным протоколом и папкой данных. Инструкция оператора и
preflight: [`apps/experiment/README.md`](./apps/experiment/README.md). Все
локальные и CI-артефакты складываются в `apps/experiment/build/`.

## Схемы

Источники истины — JSON Schema; типы генерируются из них и правке руками не подлежат:

```bash
npm run gen:manifest-types   # packages/core/src/manifest.types.ts
npm run gen:protocol-types   # packages/protocol/src/protocol.types.ts
```
