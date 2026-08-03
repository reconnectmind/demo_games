/**
 * Минимальные чтение и запись PNG для печати ассетов.
 *
 * Отдельная библиотека ради двух файлов не стоит ни зависимости, ни её
 * обновлений: нам нужны 8 бит на канал, RGB или RGBA, без чересстрочности —
 * ровно то, чем являются и палитра машины, и листва ez-tree.
 */
import { deflateSync, inflateSync } from "node:zlib";

export function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("не PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8) throw new Error(`ожидались 8 бит на канал, а не ${depth}`);
      if (color !== 2 && color !== 6) throw new Error(`ожидался RGB или RGBA, а не тип ${color}`);
      if (body[12] !== 0) throw new Error("чересстрочный PNG не поддержан");
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      parts.push(body);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  // Развёртка фильтров PNG: каждая строка предсказана по левому, верхнему и
  // левому-верхнему пикселю, и восстанавливается ровно в том же порядке.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = pixels.subarray(y * stride, y * stride + stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = previous ? previous[i] : 0;
      const upLeft = previous && i >= channels ? previous[i - channels] : 0;
      let value = source[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dl = Math.abs(p - left);
        const du = Math.abs(p - up);
        const dul = Math.abs(p - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      } else if (filter !== 0) throw new Error(`неизвестный фильтр строки: ${filter}`);
      row[i] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** Пишем без предсказания: картинки маленькие, а фильтры экономят единицы процентов. */
export function encodePng({ width, height, channels, pixels }) {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
