import pilot from "../examples/reconnect-pilot.json" with { type: "json" };
import type { Protocol } from "./protocol.types.js";

/**
 * Пилотный сценарий из бэклога: покой, обучение, две составные игры, покой.
 *
 * Приведение через `unknown` неизбежно: схема требует непустых кортежей, а JSON
 * из импорта их не различает. Документ всё равно проверяется схемой при
 * компиляции — там ошибка и всплывёт, если появится.
 */
export const pilotProtocol = pilot as unknown as Protocol;
