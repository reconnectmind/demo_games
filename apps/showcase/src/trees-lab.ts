/**
 * Стенд деревьев: отдельная страница витрины, `/trees.html`.
 *
 * В сборку витрины она не входит — это инструмент разработки, а не часть демонстрации:
 * Vite отдаёт её в режиме разработки по имени файла, а `vite build` собирает только
 * `index.html`.
 */
import { mountGarden } from "@gamespace/race/lab";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLElement;

const garden = await mountGarden(canvas, hud);
window.addEventListener("resize", () => garden.resize());
// Сцена в консоли: стенд открывают, чтобы в нём копаться, и половина вопросов к
// деревьям решается одной строкой в отладчике, а не правкой исходника.
(window as unknown as { garden: typeof garden }).garden = garden;
