import pilot from "../examples/reconnect-pilot.json" with { type: "json" };
import type { Protocol } from "./protocol.types.js";

/** Пилотный сценарий из бэклога: покой, обучение, две составные игры, покой. */
export const pilotProtocol = pilot as Protocol;
