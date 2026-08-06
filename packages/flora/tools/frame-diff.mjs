/**
 * Сравнение двух снимков экрана: сколько пикселей разошлось и насколько.
 *
 * Нужно ровно для одного: убедиться, что качание кроны действительно происходит.
 * Ветер живёт в вершинном шейдере, тестом его не достать, а на неподвижном снимке
 * его не видно по определению. Поэтому проверка такая: два кадра в штиль и два
 * кадра на ветру, и разница между ними должна отличаться на порядок.
 *
 *   node tools/frame-diff.mjs a.png b.png
 */
import { readFileSync } from "node:fs";
import { decodePng } from "./png.mjs";

const [, , left, right] = process.argv;
if (!left || !right) throw new Error("нужны два пути к PNG");

const a = decodePng(readFileSync(left));
const b = decodePng(readFileSync(right));
if (a.width !== b.width || a.height !== b.height) throw new Error("снимки разного размера");

let moved = 0;
let sum = 0;
const pixels = a.width * a.height;
for (let i = 0; i < pixels; i++) {
  const d =
    Math.abs(a.pixels[i * a.channels] - b.pixels[i * b.channels]) +
    Math.abs(a.pixels[i * a.channels + 1] - b.pixels[i * b.channels + 1]) +
    Math.abs(a.pixels[i * a.channels + 2] - b.pixels[i * b.channels + 2]);
  sum += d;
  if (d > 24) moved++;
}
console.log(
  `разошлось ${((moved / pixels) * 100).toFixed(2)}% пикселей, средняя разница ${(sum / pixels).toFixed(2)}`,
);
