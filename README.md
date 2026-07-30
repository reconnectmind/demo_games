# demo_games

Две витрины в одном репозитории.

`index.html` в корне — прежняя витрина всего каталога игр, одним файлом. Она остаётся эталоном механик и продолжает публиковаться на GitHub Pages, пока новая архитектура не догонит её по охвату.

`packages/` и `apps/showcase` — новая архитектура: десять модулей протокола на общем runtime с чистыми ядрами, журналом событий, политиками сложности, оркестрацией составных задач и слоем расписания (`packages/protocol`), который проигрывает сценарий эксперимента целиком. Архитектура описана в `../microgame-architecture.md`, правила для авторов модулей — в `packages/games/AUTHORING.md`.

## Запуск

```bash
npm install
npm run dev        # витрина протокола на http://localhost:5173
npm test           # 280 тестов: контракт, восстановление, оркестрация, расписание, длинная сессия
npm run typecheck
npm run build      # сборка витрины в apps/showcase/dist
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
| `org.reconnect.squash` | аркада на канвасе: непрерывное слежение и моторный контроль |
| `org.reconnect.baseline` | покой с инструкцией и таймером: участок расписания как обычный модуль |
| `org.reconnect.adaptive-battery` | оркестратор: блоки разных задач подряд |
| `org.reconnect.interrupt-resume` | оркестратор: прерывание и лаг возобновления |

## Протокол эксперимента

Сценарий — это документ, а не код: `packages/protocol/schema/protocol.schema.json` описывает участки, стратегии завершения (`by-time`, `by-runs`, `run-limit`, `first`), политики сложности и контрбалансировку. Пилотный сценарий на 110 минут лежит в `packages/protocol/examples/reconnect-pilot.json`.

В витрине он доступен в левой панели под заголовком «Сценарий»: участки можно сжать до десятков секунд, увидеть предпросмотр расписания и выгрузить общий журнал сессии.

## Схемы

Источники истины — JSON Schema; типы генерируются из них и правке руками не подлежат:

```bash
npm run gen:manifest-types   # packages/core/src/manifest.types.ts
npm run gen:protocol-types   # packages/protocol/src/protocol.types.ts
```
