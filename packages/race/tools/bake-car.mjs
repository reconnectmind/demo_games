/**
 * Печём машину в готовую геометрию: `npm run bake:car -w @gamespace/race`.
 *
 * Исходник — модель Porsche Cayenne GTS, выгруженная из SketchUp в OBJ и
 * положенная в `tools/source/cayenne.zip` архивом как есть. Распаковывается она
 * здесь же, во временную папку: пять с половиной мегабайт текста незачем держать
 * в репозитории, когда рядом лежит архив вчетверо меньше.
 *
 * Почему печать, а не загрузка модели в рантайме. Загрузчик OBJ (как и glTF)
 * тянет в бандл разбор материалов и текстур — сотни килобайт ради одной сетки,
 * которая от заезда к заезду не меняется. А цвет у этой модели материальный:
 * два с половиной десятка материалов на всю машину, у каждого один плоский тон.
 * Поэтому тон снимается здесь, на машине разработчика, и пишется прямо в вершину.
 * В рантайме остаётся обычный материал без текстур и массивы чисел.
 *
 * Модель в миллиметрах и стоит углом в начале координат, нос смотрит в −X. Печать
 * переводит её в метры, ставит серединой на осевую и разворачивает носом в +Z —
 * туда, куда едет физика.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("./source/cayenne.zip", import.meta.url));
const OUT = fileURLToPath(new URL("../src/assets/car.json", import.meta.url));

/** Миллиметры модели в метры сцены. */
const MM = 0.001;

/**
 * Колесо — всё, что покрашено этими материалами. Разложить колёса по углам можно
 * и без имён узлов: у SketchUp их нет вовсе, а четыре кучи в четырёх углах машины
 * ни с чем не спутать.
 */
const WHEEL_MATERIALS = new Set(["Tire", "rims_1", "brake_calipers", "steel1"]);

/**
 * Фонари печатаются отдельными сетками, а не одним куском кузова: гореть они
 * должны по отдельности. У модели для этого всё есть — своё стекло на задние
 * огни, своё на фары и своё на указатели поворота, — и это ровно те три группы,
 * которые нужны сцене: габарит сзади, габарит спереди и поворотник по борту.
 *
 * Указатели ещё и делятся по бортам: мигать обязан тот, в чью сторону руль.
 */
const LAMP_GROUPS = [
  { id: "tail", material: "glass_lamp_red", split: null },
  // Отражатель `light_main` у модели один на обе стороны машины: спереди это
  // фара, сзади — блестящая подложка в фонаре. Гореть им положено по-разному.
  { id: "head", material: "light_main", split: "ends" },
  { id: "turn", material: "glass_lamp_signal", split: "sides" },
];
const LAMP_MATERIALS = new Set(LAMP_GROUPS.map((group) => group.material));

/**
 * Салон выкидывается целиком. У модели он подробный — сиденья, ковёр, потолок, —
 * но стёкла у нас непрозрачные (см. ниже), и увидеть его нельзя ни с одного
 * ракурса. Это тринадцать сотен треугольников, которые иначе ехали бы по сети.
 */
const DROPPED_MATERIALS = new Set([
  "interior_1",
  "interior_2_seat",
  "interior_black",
  "interior_carpet",
  "interior_roof",
]);

/**
 * Цвет стекла на просвет. У модели остекление честно прозрачное (`d 0.5`), а у нас
 * материал без прозрачности и без отражений: белёсое стекло вышло бы самым ярким
 * пятном в кадре — при том что камера смотрит машине в затылок весь заезд.
 */
const GLAZING = [34, 41, 50];

/**
 * Правки к материалам модели.
 *
 * `FrontColor` — материал SketchUp «ничего не назначено», чисто белый: у модели им
 * покрыты мелочи под порогами, и белыми им быть незачем.
 */
const RECOLOR = {
  glass_window1: GLAZING,
  glass_window_2: GLAZING,
  glass_window_3: GLAZING,
  glass_lamp: [70, 74, 78],
  FrontColor: [46, 46, 48],
};

// ---------------------------------------------------------------- исходник

function unpack() {
  const dir = mkdtempSync(join(tmpdir(), "race-car-"));
  try {
    execFileSync("unzip", ["-o", "-q", SOURCE, "-d", dir]);
    const inner = readdirSync(join(dir, "source")).find((name) => name.endsWith(".zip"));
    if (!inner) throw new Error("во внешнем архиве нет архива с моделью");
    execFileSync("unzip", ["-o", "-q", join(dir, "source", inner), "-d", join(dir, "obj")]);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`не удалось распаковать ${SOURCE}: ${error.message}`);
  }
  const objDir = join(dir, "obj");
  const obj = readdirSync(objDir).find((name) => name.endsWith(".obj"));
  const mtl = readdirSync(objDir).find((name) => name.endsWith(".mtl"));
  if (!obj || !mtl) throw new Error("в архиве нет пары .obj + .mtl");
  return { dir, obj: join(objDir, obj), mtl: join(objDir, mtl) };
}

/**
 * Материалы: нужен только диффузный цвет. Для текстурированных материалов
 * SketchUp пишет в `Kd` средний цвет самой картинки, и это ровно то, что нам
 * нужно от решётки радиатора и фар: пара сотен треугольников на всю машину.
 */
function parseMtl(text) {
  const out = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "newmtl") {
      current = words[1];
      out.set(current, [255, 255, 255]);
    } else if (words[0] === "Kd" && current) {
      out.set(current, [1, 2, 3].map((i) => Math.round(Math.min(1, Math.max(0, Number(words[i]))) * 255)));
    }
  }
  return out;
}

/**
 * Разбор OBJ. Грани приходят и треугольниками, и многоугольниками до десяти
 * углов — SketchUp не триангулирует плоские грани, — поэтому всё, что длиннее
 * трёх, разворачивается веером от первого угла: грани у него плоские и выпуклые.
 */
function parseObj(text) {
  const positions = [];
  const normals = [];
  const faces = [];
  let material = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("v ")) {
      const w = line.split(/\s+/);
      positions.push([Number(w[1]), Number(w[2]), Number(w[3])]);
    } else if (line.startsWith("vn ")) {
      const w = line.split(/\s+/);
      normals.push([Number(w[1]), Number(w[2]), Number(w[3])]);
    } else if (line.startsWith("usemtl ")) {
      material = line.slice(7).trim();
    } else if (line.startsWith("f ")) {
      const corners = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((token) => {
          const [v, , vn] = token.split("/");
          const at = (value, length) => {
            const index = Number(value);
            return index > 0 ? index - 1 : length + index;
          };
          return { v: at(v, positions.length), vn: vn ? at(vn, normals.length) : -1 };
        });
      for (let i = 1; i + 1 < corners.length; i++) {
        faces.push({ material, corners: [corners[0], corners[i], corners[i + 1]] });
      }
    }
  }
  return { positions, normals, faces };
}

// ---------------------------------------------------------------- сборка

/**
 * Сетка из граней в системе координат сцены.
 *
 * Оси модели: длина по X (нос в нуле), высота по Y, ширина по Z. Нужны другие:
 * длина по Z носом вперёд, ширина по X. Поперечная ось при этом **отражается**, а
 * не поворачивается: OBJ правосторонний, Babylon левосторонний, и без отражения
 * машина вывернулась бы наизнанку. Обход треугольников от отражения не меняется —
 * левосторонняя система считает нормаль грани с обратным знаком, и одно
 * компенсирует другое. Проверяет это `checkWinding`.
 */
function build(faces, source, colors, origin) {
  const out = { positions: [], normals: [], colors: [], indices: [] };
  const seen = new Map();
  for (const face of faces) {
    const rgb = colors.get(face.material) ?? [200, 200, 200];
    for (const corner of face.corners) {
      const key = `${corner.v}/${corner.vn}/${face.material}`;
      let index = seen.get(key);
      if (index === undefined) {
        index = out.positions.length / 3;
        seen.set(key, index);
        const [px, py, pz] = source.positions[corner.v];
        out.positions.push(-(pz * MM) - origin[0], py * MM - origin[1], -(px * MM) - origin[2]);
        const [nx, ny, nz] = corner.vn >= 0 ? source.normals[corner.vn] : [0, 1, 0];
        out.normals.push(-nz, ny, -nx);
        out.colors.push(rgb[0], rgb[1], rgb[2]);
      }
      out.indices.push(index);
    }
  }
  return out;
}

function boundsOf(part) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], part.positions[i + c]);
      max[c] = Math.max(max[c], part.positions[i + c]);
    }
  }
  return { min, max };
}

/**
 * Обход треугольников против авторских нормалей. Babylon считает нормаль грани как
 * (p1−p2)×(p3−p2) — в левосторонней системе это противоположно правилу правой руки.
 * Разойдись знак, машина показала бы изнанку кузова, и по одной картинке причину не
 * угадать: поэтому расхождение — ошибка печати, а не сюрприз.
 */
function checkWinding(part, name) {
  let agree = 0;
  let total = 0;
  for (let i = 0; i < part.indices.length; i += 3) {
    const [a, b, c] = [part.indices[i], part.indices[i + 1], part.indices[i + 2]];
    const at = (index, lane) => part.positions[index * 3 + lane];
    const u = [at(a, 0) - at(b, 0), at(a, 1) - at(b, 1), at(a, 2) - at(b, 2)];
    const v = [at(c, 0) - at(b, 0), at(c, 1) - at(b, 1), at(c, 2) - at(b, 2)];
    const face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let dot = 0;
    for (const index of [a, b, c]) {
      for (let lane = 0; lane < 3; lane++) dot += face[lane] * part.normals[index * 3 + lane];
    }
    if (Math.abs(dot) < 1e-12) continue;
    total++;
    if (dot > 0) agree++;
  }
  // Порог не единица: у выгрузки из SketchUp полсотни граней вывернуты в самой
  // модели, и это видно только изнутри порога. Требовать от неё идеальности —
  // значит не напечатать её вовсе.
  if (agree < total * 0.85) throw new Error(`${name}: обход треугольников вывернут (согласны ${agree} из ${total})`);
  return total - agree;
}

// ---------------------------------------------------------------- упаковка

function toBase64(typed) {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");
}

/**
 * Позиции в Int16 с общим множителем: машина живёт в кубе пяти метров, и шаг в
 * десятую долю миллиметра тут заведомо избыточен. Нормали в Int8 — их точности
 * хватает и на плоские грани, и на скруглённые крылья, а цвет и так байтовый.
 */
function pack(part) {
  const count = part.positions.length / 3;
  if (count > 65535) throw new Error(`сетка не влезает в 16-битные индексы: ${count} вершин`);
  let extent = 1e-6;
  for (const value of part.positions) extent = Math.max(extent, Math.abs(value));
  const scale = extent / 32767;
  const positions = new Int16Array(part.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = Math.round(part.positions[i] / scale);
  const normals = new Int8Array(part.normals.length);
  for (let i = 0; i < normals.length; i++) normals[i] = Math.max(-127, Math.min(127, Math.round(part.normals[i] * 127)));
  return {
    scale,
    vertexCount: count,
    triangles: part.indices.length / 3,
    positions: toBase64(positions),
    normals: toBase64(normals),
    colors: toBase64(Uint8Array.from(part.colors)),
    indices: toBase64(Uint16Array.from(part.indices)),
  };
}

// ---------------------------------------------------------------- печать

const source = unpack();
let model;
let materials;
try {
  model = parseObj(readFileSync(source.obj, "utf8"));
  materials = parseMtl(readFileSync(source.mtl, "utf8"));
} finally {
  rmSync(source.dir, { recursive: true, force: true });
}
for (const [name, rgb] of Object.entries(RECOLOR)) {
  if (!materials.has(name)) throw new Error(`в модели нет материала ${name}`);
  materials.set(name, rgb);
}

/**
 * Начало координат: середина габарита по длине и ширине, уровень дороги по высоте.
 * Считается по всей модели до отбрасывания салона — иначе центр поехал бы от того,
 * что мы выкинули сиденья.
 */
const whole = build(model.faces, model, materials, [0, 0, 0]);
const wholeBounds = boundsOf(whole);
const origin = [
  (wholeBounds.min[0] + wholeBounds.max[0]) / 2,
  wholeBounds.min[1],
  (wholeBounds.min[2] + wholeBounds.max[2]) / 2,
];

const kept = model.faces.filter((face) => !DROPPED_MATERIALS.has(face.material));
const wheelFaces = kept.filter((face) => WHEEL_MATERIALS.has(face.material));
const bodyFaces = kept.filter((face) => !WHEEL_MATERIALS.has(face.material) && !LAMP_MATERIALS.has(face.material));

const body = build(bodyFaces, model, materials, origin);
const flippedBody = checkWinding(body, "кузов");
const bodyBounds = boundsOf(body);

/**
 * Середина грани в осях сцены: поперечная смотрит вправо, продольная вперёд.
 * По ней фонари и разбираются на борта и концы машины.
 */
function middleOf(face) {
  let cx = 0;
  let cz = 0;
  for (const corner of face.corners) {
    cx += -(model.positions[corner.v][2] * MM) - origin[0];
    cz += -(model.positions[corner.v][0] * MM) - origin[2];
  }
  return { x: cx, z: cz };
}

const lamps = [];
for (const group of LAMP_GROUPS) {
  const faces = kept.filter((face) => face.material === group.material);
  if (faces.length === 0) throw new Error(`в модели нет фонарей ${group.id}`);
  const parts =
    group.split === "sides"
      ? [
          { id: `${group.id}-left`, faces: faces.filter((face) => middleOf(face).x < 0) },
          { id: `${group.id}-right`, faces: faces.filter((face) => middleOf(face).x > 0) },
        ]
      : group.split === "ends"
        ? [
            { id: `${group.id}-front`, faces: faces.filter((face) => middleOf(face).z > 0) },
            { id: `${group.id}-back`, faces: faces.filter((face) => middleOf(face).z < 0) },
          ]
        : [{ id: group.id, faces }];
  for (const part of parts) {
    if (part.faces.length === 0) throw new Error(`фонари ${part.id} не нашлись`);
    const mesh = build(part.faces, model, materials, origin);
    checkWinding(mesh, `фонари ${part.id}`);
    lamps.push({ id: part.id, mesh });
  }
}

/**
 * Полуширина кузова без зеркал.
 *
 * Габаритная коробка для коллайдера не годится: зеркала торчат на двенадцать
 * сантиметров с каждой стороны, и машина цеплялась бы ими за то, что зрительно
 * проходит мимо. Меряется это квантилью по модулю поперечной координаты — зеркала
 * это меньше процента вершин, — а не вычитанием на глаз. Остальным осям такой
 * правки не нужно: вдоль и вверх у модели ничего не торчит.
 */
const HULL_QUANTILE = 0.99;
const across = [];
for (let i = 0; i < body.positions.length; i += 3) across.push(Math.abs(body.positions[i]));
across.sort((a, b) => a - b);
const hullX = across[Math.round(HULL_QUANTILE * (across.length - 1))];

/**
 * Колёса разбираются по углам машины: у выгрузки из SketchUp нет ни имён узлов, ни
 * иерархии, зато есть четыре кучи «шина плюс диск плюс суппорт» на своих местах.
 * Знак поперечной координаты даёт борт, знак продольной — ось.
 */
const corners = new Map();
for (const face of wheelFaces) {
  let cx = 0;
  let cz = 0;
  for (const corner of face.corners) {
    const [px, , pz] = model.positions[corner.v];
    cx += -(pz * MM) - origin[0];
    cz += -(px * MM) - origin[2];
  }
  const key = `${cx > 0 ? "R" : "L"}${cz > 0 ? "F" : "B"}`;
  if (!corners.has(key)) corners.set(key, []);
  corners.get(key).push(face);
}
if (corners.size !== 4) throw new Error(`колёса разложились не по четырём углам, а по ${corners.size}`);

const axles = new Map();
const variants = new Map();
let hub = null;
for (const [key, faces] of corners) {
  const centred = build(faces, model, materials, origin);
  const bounds = boundsOf(centred);
  const middle = [0, 1, 2].map((c) => (bounds.min[c] + bounds.max[c]) / 2);
  const measured = {
    /** Ось колеса над дорогой: у стоящей машины это и есть радиус. */
    hubY: middle[1],
    radius: (bounds.max[1] - bounds.min[1]) / 2,
    /** Расстояние середины колеса от продольной осевой машины. */
    wheelX: Math.abs(middle[0]),
  };
  if (!hub) hub = measured;
  else {
    for (const name of Object.keys(hub)) {
      // Допуск в миллиметр: колёса выгружены каждое своими вершинами, и сойтись
      // до последнего знака они не обязаны.
      if (Math.abs(hub[name] - measured[name]) > 0.001) throw new Error(`колёса не одинаковы по ${name}`);
    }
  }
  const axle = key.endsWith("F") ? "front" : "back";
  const was = axles.get(axle);
  if (was === undefined) axles.set(axle, Math.abs(middle[2]));
  else if (Math.abs(was - Math.abs(middle[2])) > 0.001) throw new Error(`колёса оси ${axle} стоят по-разному`);
  // Сетка колеса пишется относительно его середины, а не ступицы: сцене тогда
  // достаточно поставить её туда, где физика держит пятно контакта.
  const side = key.startsWith("R") ? 1 : -1;
  if (!variants.has(side)) {
    const part = build(faces, model, materials, [
      origin[0] + middle[0],
      origin[1] + middle[1],
      origin[2] + middle[2],
    ]);
    checkWinding(part, `колесо ${key}`);
    variants.set(side, part);
  }
}
if (variants.size !== 2) throw new Error("ожидались колёса с двух сторон");
if (axles.size !== 2) throw new Error("ожидались передняя и задняя оси");

const asset = {
  generator: "Porsche Cayenne GTS (OBJ из SketchUp), tools/source/cayenne.zip",
  note: "Сгенерировано скриптом tools/bake-car.mjs. Вручную не править.",
  /**
   * Обмеры модели в метрах. Физика берёт их отсюда через `geometry.ts`, а тест
   * сверяет числа с этим файлом: разъехавшись, колёса поехали бы рядом с арками, и
   * никакой настройкой подвески это не лечится.
   */
  model: {
    wheelRadius: Number(hub.radius.toFixed(4)),
    hubY: Number(hub.hubY.toFixed(4)),
    /** Оси от начала координат модели: перед впереди, зад позади. */
    hubFrontZ: Number(axles.get("front").toFixed(4)),
    hubBackZ: Number(axles.get("back").toFixed(4)),
    /** Половина колеи: середина колеса, под ней стоит пятно контакта. */
    wheelX: Number(hub.wheelX.toFixed(4)),
    bodyMin: bodyBounds.min.map((v) => Number(v.toFixed(4))),
    bodyMax: bodyBounds.max.map((v) => Number(v.toFixed(4))),
    /** Полуширина кузова без зеркал: по ней строится коллайдер. */
    hullX: Number(hullX.toFixed(4)),
  },
  body: pack(body),
  lamps: lamps.map((lamp) => ({ id: lamp.id, ...pack(lamp.mesh) })),
  wheels: [...variants.entries()].sort((a, b) => b[0] - a[0]).map(([side, part]) => ({ side, ...pack(part) })),
};

writeFileSync(OUT, JSON.stringify(asset));
const size = `${(statSync(OUT).size / 1024).toFixed(0)} КБ`;
console.log(
  `кузов: ${asset.body.triangles} треугольников (${asset.body.vertexCount} вершин), ` +
    `колесо: ${asset.wheels[0].triangles}, радиус ${asset.model.wheelRadius}`,
);
console.log(
  `ступица (${asset.model.wheelX}, ${asset.model.hubY}), оси ${asset.model.hubFrontZ}/−${asset.model.hubBackZ}, ` +
    `база ${(asset.model.hubFrontZ + asset.model.hubBackZ).toFixed(3)}`,
);
console.log(`габарит кузова: ${asset.model.bodyMin.join("/")} → ${asset.model.bodyMax.join("/")}`);
console.log(
  `полуширина без зеркал: ${asset.model.hullX}, фонари: ` +
    asset.lamps.map((lamp) => `${lamp.id} ${lamp.triangles}`).join(", "),
);
console.log(`вывернутых граней в исходнике: ${flippedBody}`);
console.log(`готово: car.json ${size}`);
