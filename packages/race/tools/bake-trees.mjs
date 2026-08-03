/**
 * Печём деревья ez-tree в готовую геометрию: `npm run bake:trees -w @gamespace/race`.
 *
 * Почему заранее, а не в рантайме: ez-tree — библиотека Three.js, а сцена у нас на
 * Babylon, и её сборка весит четыре мегабайта, потому что все текстуры коры и
 * листвы вшиты в неё как base64. Тащить в бандл Three и четыре мегабайта ради
 * придорожных деревьев нельзя, а геометрия дерева — это просто массивы вершин:
 * генератор нужен один раз, на машине разработчика.
 *
 * Скрипт и его зависимости живут в devDependencies: в рантайме ни ez-tree, ни
 * Three нет ни строкой.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { decodePng, encodePng } from "./png.mjs";

// Three в Node не умеет грузить картинки, а нам от дерева нужна только геометрия.
THREE.TextureLoader.prototype.load = function stubLoad() {
  return new THREE.Texture();
};

const { Tree } = await import("@dgreenheck/ez-tree");

const OUT_DIR = fileURLToPath(new URL("../src/assets/", import.meta.url));
const LEAVES_DIR = fileURLToPath(
  new URL("../../../node_modules/@dgreenheck/ez-tree/src/lib/assets/leaves/", import.meta.url),
);
const BARK_DIR = fileURLToPath(
  new URL("../../../node_modules/@dgreenheck/ez-tree/src/lib/assets/bark/", import.meta.url),
);

/**
 * Шесть пород, и у больших из них по два строения.
 *
 * Порода задаёт вид дерева, посев — конкретное дерево этой породы. Одного строения на
 * породу мало: поворот вокруг вертикали и разный рост прячут повтор ровно до того
 * момента, когда два одинаковых дерева попадают в кадр рядом, — а в купе они попадают
 * всегда. Второй посев стоит ещё столько же байт, поэтому подрост и кусты обходятся
 * одним: они мелкие, стоят у обочины и пролетают мимо за полсекунды.
 *
 * Кусты — не украшение ради украшения: ими заполняется полоса между обочиной и лесом,
 * без них деревья стоят на пустом газоне, как в парке.
 */
const VARIANTS = [
  {
    id: "aspen",
    leaf: "aspen",
    bark: "birch",
    forms: [
      { preset: "Aspen Medium", seed: 101 },
      { preset: "Aspen Medium", seed: 8317 },
    ],
  },
  {
    /**
     * Берёза. Своего пресета у ez-tree нет, и берётся она от осины — они и в природе
     * похожи строением: тонкий ствол, высокая крона, мелкий дрожащий лист. Отличают
     * их два признака, и оба заданы здесь: кора (белая с чёрными чёрточками, своя
     * текстура) и повадка ствола — берёза тоньше и кривее, её ведёт от ветра сильнее
     * любого другого дерева придорожной полосы.
     */
    id: "birch",
    leaf: "aspen",
    bark: "birch",
    trunk: 0.78,
    bend: 2.1,
    twist: 0.13,
    // Берёза вытянута вверх сильнее осины, и при осиновой густоте листвы её крона
    // расползается в редкие клочья на макушке. Листьев ей нужно больше, а размером
    // они меньше: у берёзы лист и в природе мелкий.
    leafCount: 14,
    leafScale: 1.45,
    forms: [
      { preset: "Aspen Medium", seed: 1201 },
      { preset: "Aspen Large", seed: 3307 },
    ],
  },
  {
    id: "ash",
    leaf: "ash",
    bark: "oak",
    forms: [
      { preset: "Ash Medium", seed: 202 },
      { preset: "Ash Medium", seed: 4523 },
    ],
  },
  {
    // У сосны листва — не лист, а хвоя: пучок иголок мелкий, и укрупнять его нельзя.
    // С общим множителем сосна выходила тополем: крона из круглых зелёных клякс.
    id: "pine",
    leaf: "pine",
    bark: "pine",
    needle: true,
    leafScale: 1.15,
    leafThin: 0.62,
    forms: [
      { preset: "Pine Medium", seed: 303 },
      { preset: "Pine Medium", seed: 9127 },
    ],
  },
  {
    /**
     * Ель: та же хвоя, но силуэт другой — узкий конус вместо разлапистой сосны.
     * Делается это укорочением боковых ветвей, а не новым пресетом: у сосны ez-tree
     * ветви растут от ствола почти горизонтально, и достаточно сделать их короче,
     * чтобы крона собралась в свечу. Второй хвойный силуэт нужен затем, что хвойные —
     * треть придорожного леса, и одна сосна на всю трассу видна как повтор.
     */
    id: "spruce",
    leaf: "pine",
    bark: "pine",
    needle: true,
    // Хвоя у ели крупнее и реже сосновой: так ель влезает в тот же бюджет
    // треугольников, а лапы читаются плотнее — они короче и висят ниже.
    leafScale: 1.55,
    leafThin: 0.58,
    // Лапы длиннее сосновых и идут почти от земли, а свечу из них делает конус.
    limb: 1.05,
    limbStart: 0.06,
    cone: 0.78,
    bend: 0.9,
    twist: 0.04,
    forms: [{ preset: "Pine Medium", seed: 5501 }],
  },
  {
    id: "oak",
    leaf: "oak",
    bark: "oak",
    forms: [
      { preset: "Oak Medium", seed: 404 },
      { preset: "Oak Medium", seed: 6689 },
    ],
  },
  { id: "sapling", leaf: "aspen", bark: "birch", forms: [{ preset: "Aspen Small", seed: 505 }] },
  {
    // Куст — четверть придорожной зелени, и одного строения ему мало вдвойне: он
    // стоит у самой обочины, где его разглядывают в упор. Два разных пресета берутся
    // не для разнообразия ради: «Bush 2» даёт редкий зонт на прутьях, и один он
    // читается не кустом, а сломанным зонтиком.
    id: "bush",
    leaf: "ash",
    bark: "oak",
    dense: true,
    leafScale: 1.35,
    leafThin: 0.5,
    forms: [
      { preset: "Bush 1", seed: 606 },
      { preset: "Bush 3", seed: 7742 },
    ],
  },
];

/**
 * Прореживание сетки: вдоль ветки реже сечения, вокруг ветки меньше сегментов.
 *
 * Уровни ветвления мы больше не срезаем, и это главная правка. Раньше их было не
 * больше двух — ради треугольников, — и получалось не упрощённое дерево, а другое:
 * листья у ez-tree сидят на ветках последнего уровня, поэтому со срезанным третьим
 * уровнем вся крона собиралась в несколько пучков на голых прутьях. Именно этот
 * силуэт — шест с ботвой на макушке — и читался «крипотой». Третий уровень стоит
 * дёшево: ветки там короткие и тонкие, а сечений и сегментов у них по два-три.
 */
/**
 * Кривизна ствола.
 *
 * У пресетов ez-tree стволы прямые как мачта: `gnarliness` нулевого уровня стоит
 * пять сотых, и на пятнадцати метрах это отклонение в ладонь. В лесу таких деревьев
 * нет — прямой ствол растёт только в питомнике и на лесопилке, — и именно от этого
 * лес читался декорацией: одинаково прямые шесты с зеленью наверху.
 *
 * Гнём двумя ручками сразу. `gnarliness` — случайный увод оси на каждом сечении, от
 * него ствол идёт волной. `twist` — постоянное закручивание, от него дерево уходит
 * винтом, и два соседних дерева перестают быть отражением друг друга. Одного
 * `gnarliness` мало: волна выходит симметричной, и издали ствол снова читается прямым.
 */
function bendTrunk(options, bend, twist) {
  if (!bend) return;
  for (const level of ["0", "1", "2", "3"]) {
    const was = options.branch.gnarliness[level] ?? 0;
    // Знак сохраняется: у части пресетов кривизна отрицательная, и это осмысленно —
    // ветки загибаются вниз. Слагаемое нужно затем, что нулевую кривизну множитель
    // не сдвинет, а прямых стволов нам как раз и не надо.
    const sign = was < 0 ? -1 : 1;
    /**
     * Кривизна у ez-tree — это угол поворота оси **на одно сечение**, и накопленный
     * увод растёт как корень из их числа: это случайное блуждание. Значит, добавив
     * сечений, тот же множитель дал бы более кривое дерево, а нам нужно ровно
     * обратное — тот же силуэт, но набранный мелкими поворотами вместо изломов.
     * Поэтому угол делится на корень из густоты сечений относительно привычной
     * дюжины: дуга остаётся прежней, а колена пропадают.
     */
    const dense = Math.sqrt((options.branch.sections[level] ?? 12) / 12);
    options.branch.gnarliness[level] = (sign * (Math.abs(was) * bend + 0.04 * bend)) / dense;
  }
  options.branch.twist["0"] = (options.branch.twist["0"] ?? 0) + twist;
  options.branch.twist["1"] = (options.branch.twist["1"] ?? 0) - twist * 0.6;
}

/**
 * Ветвление в кроне.
 *
 * У пресетов ez-tree крона держится на считаных ветвях: у дуба шесть скелетных, на
 * каждой по четыре, на тех по три — семьдесят два прута на всё дерево. Со снятой
 * листвой это видно сразу: не крона, а ёршик из прямых спиц, торчащих из ствола
 * под одним углом. Листва такой скелет не прячет, а выдаёт — пучки висят на
 * редких прутьях поодиночке, и каждый читается отдельной нашлёпкой.
 *
 * Правится тремя ручками:
 *
 * - **Гуще.** Ветвей второго и третьего уровня становится в полтора-два раза
 *   больше. Это самая дешёвая часть дерева: прут третьего уровня — три сечения по
 *   три грани, восемнадцать треугольников, тогда как один ствол стоит четырёхсот.
 * - **Провисание.** У ez-tree есть постоянная сила, тянущая ветку по заданному
 *   направлению; в пресетах она почти нулевая, и ветви растут по прямой, как
 *   спицы зонта. Настоящая ветка гнётся под собственным весом и весом листвы тем
 *   сильнее, чем она дальше от ствола, и именно эта дуга читается деревом.
 * - **Кривизна прутьев.** Раньше изгибались только ствол и скелетные ветви, а
 *   прутья оставались отрезками. Теперь гнутся и они.
 *
 * Хвойных это не касается: у сосны лапы растут прямо от ствола и их и так восемь
 * десятков, а провисшая лапа — это не сосна, а плакучая ива.
 */
const CROWN_SPREAD = { 1: 1.8, 2: 1.6 };
const CROWN_DROOP = 0.018;
const TWIG_SECTIONS = 3;
/** Сечений у ствола: шаг вдоль ствола должен быть меньше метра. */
const TRUNK_SECTIONS = 20;
/** Во сколько раз толще прутья последних уровней, чем в пресете. */
const TWIG_THICKEN = 1.35;

function branchOut(options, variant) {
  if (variant.needle || variant.dense) return 1;
  let grown = 1;
  for (const level of ["1", "2"]) {
    // Уровня глубже, чем задано пресетом, попросту нет: у осины ветвление в два
    // уровня, и третий множитель умножал бы несуществующее.
    if (Number(level) >= options.branch.levels) continue;
    const was = options.branch.children[level] ?? 0;
    options.branch.children[level] = Math.round(was * CROWN_SPREAD[level]);
    grown *= CROWN_SPREAD[level];
  }
  // Прут в одно сечение — это отрезок, гнуть в нём нечего.
  options.branch.sections["3"] = TWIG_SECTIONS;
  options.branch.force.strength -= CROWN_DROOP;
  return grown;
}

function simplify(options, variant) {
  const thin = (table, factor, floor) => {
    for (const key of Object.keys(table)) {
      table[key] = Math.max(floor, Math.round(table[key] * factor));
    }
  };
  /**
   * Сечения вдоль ветки — это не детализация, а сама её форма: между двумя
   * сечениями ветка идёт строго прямо. Первая версия резала их вдвое на всех
   * уровнях, и у дуба на шестнадцать метров ствола оставалось восемь сечений, то
   * есть прямых кусков по два метра. Изгиб при этом мы усилили втрое (см.
   * `bendTrunk`), и весь он собрался в семь изломов — ствол вышел коленчатой
   * трубой. Дерево так не растёт: оно гнётся непрерывно, и глазу нужен именно
   * плавный обвод, а не число граней.
   *
   * Поэтому у ствола сечения остаются как в пресете, у скелетных ветвей режутся
   * слабо, и вся экономия уходит на прутья последних уровней: они тоньше листа,
   * висят в глубине кроны и прямыми их никто не увидит.
   */
  /**
   * Сечений у ствола не «как в пресете», а вдвое-втрое больше: у пресета дуба их
   * восемь на шестнадцать метров, и никакого запаса точности там нет. Изгиб мы
   * при этом усиливаем — значит, каждое сечение поворачивает ось на заметный
   * угол, и стык двух прямых кусков читается сломом даже под корой. Двадцать
   * сечений дают шаг меньше метра, на нём тот же изгиб ложится дугой.
   */
  options.branch.sections["0"] = Math.max(TRUNK_SECTIONS, options.branch.sections["0"]);
  options.branch.sections["1"] = Math.max(7, Math.round(options.branch.sections["1"] * 0.85));
  options.branch.sections["2"] = Math.max(3, Math.round(options.branch.sections["2"] * 0.5));
  options.branch.sections["3"] = 2;
  // Число граней вокруг ветки — другое дело: восьмигранный ствол от круглого с
  // дороги не отличить, а вот трёхгранный прут читается лезвием, и его видно.
  // Ствол всё же десятигранный: у придорожного дерева его видят в упор и в
  // профиль, и на светлой коре гранёный силуэт заметен на просвет неба.
  options.branch.segments["0"] = Math.max(10, options.branch.segments["0"]);
  options.branch.segments["1"] = 5;
  options.branch.segments["2"] = 4;
  options.branch.segments["3"] = 3;
  /**
   * Прутья последних уровней тоньше зубочистки: у пресета радиус третьего уровня
   * даёт на конце доли миллиметра, и на макушке получалось то, за что дереву и
   * прилетело, — листва висит в воздухе, веток под ней нет. Прут, на котором
   * держится пучок листьев, обязан быть виден.
   */
  options.branch.radius["2"] *= TWIG_THICKEN;
  options.branch.radius["3"] *= TWIG_THICKEN * 1.15;
  /**
   * У хвойных лапа — не скелетная ветка, а расходник: их на стволе восемь десятков
   * против девяти у дуба, каждая прямая и почти вся скрыта хвоей. Общая мерка для
   * скелетных ветвей удваивает сосне цену за то, чего не видно.
   */
  if (variant.needle) {
    options.branch.sections["1"] = Math.max(4, Math.round(options.branch.sections["1"] * 0.5));
    options.branch.segments["1"] = 4;
  }
  const grown = branchOut(options, variant);
  /**
   * Куст — то же дерево ростом по колено, и деталь ствола ему не нужна: у пресетов
   * куста ветвей больше, чем у дуба (тринадцать от земли против семи), а видно их с
   * трёх метров и мельком. Без этой скидки куст выходил дороже дерева вчетверо.
   */
  if (variant.dense) {
    thin(options.branch.sections, 0.7, 3);
    thin(options.branch.children, 0.65, 2);
    options.branch.segments["0"] = 5;
    options.branch.segments["1"] = 4;
  }
  /**
   * Листва — главная статья и в байтах, и в перерисовке прозрачных пикселей на
   * телефоне. Считать её поштучно расточительно, поэтому на квад идёт не лист, а
   * пучок листьев (см. `cluster` ниже): та же цена в треугольниках, вчетверо больше
   * листвы в кадре. Раз квад теперь пучок, его и надо укрупнить, а число — снизить.
   */
  const thinning = variant.leafThin ?? (variant.dense ? 0.55 : 0.42);
  // Восьмёрка снизу — не формальность: у осины в пресете одиннадцать листьев на
  // ветку, и любое прореживание упирается в этот порог. Породе, которой нужна крона
  // гуще исходной, доля не поможет — для неё число задаётся прямо.
  const perBranch = variant.leafCount ?? Math.max(8, Math.round(options.leaves.count * thinning));
  /**
   * Число листьев задаётся на ветку, а веток стало втрое больше — значит, на ветку
   * их нужно во столько же раз меньше. Иначе загущение скелета обернулось бы
   * утроением листвы, а нам нужно ровно обратное: та же листва, разложенная по
   * втрое большему числу прутьев. Именно от этого пучки перестают висеть
   * нашлёпками — каждый сидит на своём пруте, а не по десятку на одном.
   */
  options.leaves.count = Math.max(3, Math.round(perBranch / grown));
  // Корень из двух — сторона пучка, выросшего вдвое по площади: половину пучков
  // забирает купол (`domeLeaves`, `thinLeaves`), и оставшиеся кроют ту же крону.
  options.leaves.size *= (variant.leafScale ?? (variant.dense ? 1.5 : 1.9)) * Math.SQRT2;
  bendTrunk(options, variant.bend ?? (variant.dense ? 1.6 : 1.5), variant.twist ?? 0.09);
  if (variant.trunk) options.branch.radius["0"] *= variant.trunk;
  if (variant.limb) {
    for (const level of ["1", "2", "3"]) options.branch.length[level] *= variant.limb;
  }
  if (variant.limbStart) options.branch.start["1"] = variant.limbStart;
}

function toBase64(typed) {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");
}

/**
 * Позиции пакуются в Int16 с общим множителем: дерево живёт в кубе десятков
 * метров, шаг в миллиметр тут заведомо избыточен, а размер выходит вдвое меньше
 * Float32. Нормали не пакуются вовсе — их считает Babylon из самой сетки.
 */
function packPositions(verts) {
  let extent = 1;
  for (const value of verts) extent = Math.max(extent, Math.abs(value));
  const scale = extent / 32767;
  const quantized = new Int16Array(verts.length);
  for (let i = 0; i < verts.length; i++) quantized[i] = Math.round(verts[i] / scale);
  return { scale, packed: toBase64(quantized) };
}

/**
 * Ветви: позиции, развёртка и индексы. Нормалей нет — их восстанавливает
 * `ComputeNormals`.
 *
 * Развёртка коры влезает в один байт на вершину, и это не экономия ради экономии:
 * вершин у леса под сотню тысяч, и честные две плавающие точки стоили бы ещё
 * семьсот килобайт. Раскладка у ez-tree такая, что байта хватает с запасом: вдоль
 * ветки координата принимает ровно два значения (сечения чередуются), а вокруг
 * ветки идёт равными долями от нуля до единицы — сегментов не больше восьми.
 */
const UV_ROUND_BIT = 128;

function packBranches(part) {
  const verts = Float32Array.from(part.verts);
  const { scale, packed } = packPositions(verts);
  const vertexCount = verts.length / 3;
  if (vertexCount > 65535) throw new Error("ветви не влезают в 16-битные индексы");
  const uv = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const u = part.uvs[i * 2];
    const v = part.uvs[i * 2 + 1];
    if (u < -0.001 || u > 1.001) throw new Error(`развёртка коры вне отрезка: ${u}`);
    if (Math.abs(v) > 0.001 && Math.abs(v - 1) > 0.001) throw new Error(`развёртка коры вдоль ветки не 0 и не 1: ${v}`);
    uv[i] = (v > 0.5 ? UV_ROUND_BIT : 0) | Math.round(Math.min(1, Math.max(0, u)) * 127);
  }
  return {
    scale,
    vertexCount,
    triangles: part.indices.length / 3,
    positions: packed,
    uv: toBase64(uv),
    indices: toBase64(Uint16Array.from(part.indices)),
  };
}

/**
 * Листва: только позиции. Каждый лист — веер из пяти вершин, поэтому и UV, и
 * индексы идут строго повторяющимся узором, и хранить их значило бы платить за
 * арифметическую прогрессию сто с лишним килобайт. Узор задаёт `domeLeaves`, она
 * же сверяет то, что пришло от ez-tree, — раскладка генератора проверяется там,
 * где она ещё видна.
 */
const LEAF_UV = [0, 1, 0, 0, 1, 0, 1, 1, 0.5, 0.5];

function packLeaves(part) {
  const verts = Float32Array.from(part.verts);
  const vertexCount = verts.length / 3;
  if (vertexCount % 5 !== 0) throw new Error("листва не разбита на веера");
  const { scale, packed } = packPositions(verts);
  return { scale, vertexCount, triangles: part.indices.length / 3, positions: packed };
}

/**
 * Разворот каждого листа вокруг своей середины.
 *
 * У ez-tree лист сидит на ветке под одним и тем же углом к ней, поэтому вся листва
 * одной ветки лежит в одной плоскости — веером, как страницы книги. Вблизи это
 * видно сразу: крона местами выглядит вырезанной из картона, и никакая текстура
 * этого не лечит, потому что дело в геометрии.
 *
 * Лечится случайным поворотом каждого листа. Разворот берётся от середины листа,
 * а не от счётчика: у ez-tree лист при двойном билборде — это два квада крест-накрест
 * с общей серединой, и им нужен один и тот же разворот, иначе крест разъедется на
 * две отдельные тряпки.
 */
const LEAF_TILT = 0.55;

function tiltLeaves(part) {
  const verts = part.verts;
  const quads = verts.length / 12;
  for (let quad = 0; quad < quads; quad++) {
    const base = quad * 12;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < 4; i++) {
      cx += verts[base + i * 3];
      cy += verts[base + i * 3 + 1];
      cz += verts[base + i * 3 + 2];
    }
    cx /= 4;
    cy /= 4;
    cz /= 4;
    // Угол и ось — из самой середины листа: одно и то же место даёт один и тот же
    // разворот и от печати к печати, и у обоих квадов креста.
    const roll = (k) => Math.abs(Math.sin(cx * k + cy * (k * 1.7) + cz * (k * 2.3))) % 1;
    const angle = (roll(37.1) - 0.5) * 2 * LEAF_TILT;
    const theta = roll(11.7) * Math.PI * 2;
    const phi = Math.acos(2 * roll(23.3) - 1);
    const ax = Math.sin(phi) * Math.cos(theta);
    const ay = Math.sin(phi) * Math.sin(theta);
    const az = Math.cos(phi);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let i = 0; i < 4; i++) {
      const at = base + i * 3;
      const px = verts[at] - cx;
      const py = verts[at + 1] - cy;
      const pz = verts[at + 2] - cz;
      // Поворот Родрига вокруг оси (ax, ay, az).
      const dot = ax * px + ay * py + az * pz;
      const crx = ay * pz - az * py;
      const cry = az * px - ax * pz;
      const crz = ax * py - ay * px;
      verts[at] = cx + px * cos + crx * sin + ax * dot * (1 - cos);
      verts[at + 1] = cy + py * cos + cry * sin + ay * dot * (1 - cos);
      verts[at + 2] = cz + pz * cos + crz * sin + az * dot * (1 - cos);
    }
  }
}

/**
 * Выгиб листа из собственной плоскости.
 *
 * Развернуть каждый лист по-своему мало: сам лист остаётся идеально плоским
 * прямоугольником, а на нём нарисован не лист, а пучок. Пучок листьев плоским не
 * бывает никогда, и вблизи это читается ровно так, как и есть, — картонкой с
 * напечатанной зеленью. Настоящий лист к тому же и сам редко плоский: он
 * выгибается лодочкой, кроме, пожалуй, осиновых и тополиных.
 *
 * Углы поднимаются попарно накрест — наружу, внутрь, наружу, внутрь: середина
 * пучка остаётся на месте, а его края уходят из общей плоскости в разные стороны.
 * Дальше по этим углам `domeLeaves` натягивает купол, и складка получается не по
 * одной диагонали, а по всем четырём граням.
 */
const LEAF_CUP = 0.35;

function cupLeaves(part) {
  const verts = part.verts;
  const quads = verts.length / 12;
  // По углам: наружу, внутрь, наружу, внутрь. Знак чередуется по обходу квада —
  // иначе это не седло, а сдвиг листа целиком.
  const side = [1, -1, 1, -1];
  for (let quad = 0; quad < quads; quad++) {
    const base = quad * 12;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < 4; i++) {
      cx += verts[base + i * 3];
      cy += verts[base + i * 3 + 1];
      cz += verts[base + i * 3 + 2];
    }
    cx /= 4;
    cy /= 4;
    cz /= 4;
    const ax = verts[base];
    const ay = verts[base + 1];
    const az = verts[base + 2];
    const ux = verts[base + 3] - ax;
    const uy = verts[base + 4] - ay;
    const uz = verts[base + 5] - az;
    const wx = verts[base + 9] - ax;
    const wy = verts[base + 10] - ay;
    const wz = verts[base + 11] - az;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;
    // Глубина складки — от размера самого листа: у подроста лист мельче дубового
    // в разы, и общая на всех глубина согнула бы его вчетверо.
    const reach = Math.hypot(verts[base] - cx, verts[base + 1] - cy, verts[base + 2] - cz);
    const roll = Math.abs(Math.sin(cx * 53.7 + cy * 91.3 + cz * 27.1)) % 1;
    const depth = LEAF_CUP * (0.5 + roll) * reach;
    for (let i = 0; i < 4; i++) {
      const at = base + i * 3;
      verts[at] += nx * depth * side[i];
      verts[at + 1] += ny * depth * side[i];
      verts[at + 2] += nz * depth * side[i];
    }
  }
}

/**
 * Купол пучка: лист перестаёт быть плоскостью.
 *
 * Это ответ на самую стойкую претензию к лесу. Всё, что делалось раньше —
 * разворот листа, седло по углам, рельеф в карте нормалей, свои нормали у
 * каждого угла, — било мимо, потому что лечило симптом. Причина проста и
 * геометрична: на одном кваде нарисовано полтора десятка листьев, а плоскость у
 * них одна на всех. Свет по плоскости меняется линейно, что бы ни было записано
 * в нормалях вершин, поэтому вся горсть загорается и гаснет разом. Глаз ловит
 * такие синхронные пятна безошибочно — это и есть «листья в одной плоскости».
 *
 * Вершин у квада четыре, и из плоскости его не вывести никак: любые четыре точки
 * с одной диагональной складкой — это две плоскости, и обе большие. Поэтому в
 * середину добавляется пятая вершина, поднятая над картой, и квад становится
 * веером из четырёх граней. Граней уже четыре, нормали у них расходятся на
 * двадцать-тридцать градусов, и одна горсть больше не ловит свет одним пятном:
 * ближняя к солнцу четверть светится, дальняя уходит в тень.
 *
 * Платится за это удвоением треугольников на пучок, и платится честно — из того
 * же бюджета: пучков ровно вдвое меньше, а каждый вдвое крупнее по площади
 * (`LEAF_FAN_*`). Нарисованных листьев при этом не убавляется: в горсти их
 * настолько же больше, и каждый настолько же мельче (`CLUSTERS`). То есть в
 * кадре та же листва того же размера, но плоских карточек под ней вдвое меньше,
 * и ни одна из них не плоская.
 *
 * Подъём середины — со знаком: часть пучков выгнута к зрителю, часть от него.
 * Одинаковый знак дал бы крону из одинаковых чешуек — ту же беду, только выпуклую.
 */
const LEAF_DOME = 0.5;
/** Раскладка квада у ez-tree: по ней сверяется вход, дальше раскладка уже наша. */
const QUAD_UV = [0, 1, 0, 0, 1, 0, 1, 1];

/**
 * Половина пучков — плата за купол, и берётся она здесь, а не в настройках
 * генератора.
 *
 * Причина арифметическая. Листья у ez-tree задаются числом на ветку, и число это
 * однозначное: у ясеня их три. Просить полтора бессмысленно, округление даёт то
 * два, то три, и вместо половины выходит две трети — как раз столько, чтобы
 * вылететь из бюджета. На готовой сетке считать нечего: выкидывается ровно
 * каждый второй лист.
 *
 * Выкидывается именно лист, а не карточка. При двойном билборде лист — это две
 * карточки крест-накрест с общей серединой, и они идут подряд; убрать одну из
 * пары значило бы разобрать кресты на плоскости, то есть сделать ровно то, с чем
 * мы боремся.
 */
function thinLeaves(part) {
  const quads = part.verts.length / 12;
  const paired = quads % 2 === 0;
  const verts = [];
  const uvs = [];
  const indices = [];
  let kept = 0;
  for (let quad = 0; quad < quads; quad++) {
    const cross = paired ? quad >> 1 : quad;
    if (cross % 2 !== 0) continue;
    const src = quad * 12;
    for (let i = 0; i < 12; i++) verts.push(part.verts[src + i]);
    for (let i = 0; i < 8; i++) uvs.push(part.uvs[quad * 8 + i]);
    const base = kept * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    kept += 1;
  }
  part.verts = verts;
  part.uvs = uvs;
  part.indices = indices;
}

function domeLeaves(part) {
  const from = part.verts;
  const quads = from.length / 12;
  if (from.length % 12 !== 0) throw new Error("листва не разбита на квады");
  for (let quad = 0; quad < quads; quad++) {
    for (let i = 0; i < 8; i++) {
      if (Math.abs(part.uvs[quad * 8 + i] - QUAD_UV[i]) > 0.001) throw new Error("UV листа не по узору");
    }
    const base = quad * 4;
    const expected = [base, base + 1, base + 2, base, base + 2, base + 3];
    for (let i = 0; i < 6; i++) {
      if (part.indices[quad * 6 + i] !== expected[i]) throw new Error("индексы листа не по узору");
    }
  }

  const verts = new Array(quads * 15);
  const uvs = new Array(quads * 10);
  const indices = new Array(quads * 12);
  for (let quad = 0; quad < quads; quad++) {
    const src = quad * 12;
    const dst = quad * 15;
    for (let i = 0; i < 12; i++) verts[dst + i] = from[src + i];

    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < 4; i++) {
      cx += from[src + i * 3];
      cy += from[src + i * 3 + 1];
      cz += from[src + i * 3 + 2];
    }
    cx /= 4;
    cy /= 4;
    cz /= 4;

    // Нормаль берётся по диагоналям, а не по сторонам: стороны у седла уже
    // разошлись из общей плоскости, а диагонали задают ту, вокруг которой оно
    // изогнуто, — купол надо поднимать именно от неё.
    const d1x = from[src + 6] - from[src];
    const d1y = from[src + 7] - from[src + 1];
    const d1z = from[src + 8] - from[src + 2];
    const d2x = from[src + 9] - from[src + 3];
    const d2y = from[src + 10] - from[src + 4];
    const d2z = from[src + 11] - from[src + 5];
    let nx = d1y * d2z - d1z * d2y;
    let ny = d1z * d2x - d1x * d2z;
    let nz = d1x * d2y - d1y * d2x;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;

    const reach = Math.hypot(from[src] - cx, from[src + 1] - cy, from[src + 2] - cz);
    const grain = (k) => Math.abs(Math.sin(cx * k + cy * (k * 1.7) + cz * (k * 2.3))) % 1;
    const lift = LEAF_DOME * (0.45 + grain(53.7)) * reach * (grain(19.1) < 0.5 ? -1 : 1);
    verts[dst + 12] = cx + nx * lift;
    verts[dst + 13] = cy + ny * lift;
    verts[dst + 14] = cz + nz * lift;

    const uvAt = quad * 10;
    for (let i = 0; i < 8; i++) uvs[uvAt + i] = QUAD_UV[i];
    uvs[uvAt + 8] = 0.5;
    uvs[uvAt + 9] = 0.5;

    // Обход тот же, что был у квада, поэтому лицевая сторона не переворачивается.
    const base = quad * 5;
    const at = quad * 12;
    for (let i = 0; i < 4; i++) {
      indices[at + i * 3] = base + i;
      indices[at + i * 3 + 1] = base + ((i + 1) % 4);
      indices[at + i * 3 + 2] = base + 4;
    }
  }
  part.verts = verts;
  part.uvs = uvs;
  part.indices = indices;
}

/**
 * Конус кроны: чем выше ветка, тем ближе она к стволу.
 *
 * У хвойного пресета ez-tree всего один уровень ветвления, и все восемьдесят веток
 * растут от ствола одной длины. Получается не ель, а ёршик для бутылок: цилиндр
 * хвои на голой палке. Своей ручки «сужать кверху» у генератора нет — длина ветки
 * задаётся уровнем, а не высотой посадки, — поэтому конус вырезается уже из сетки.
 *
 * Ветви жмутся к оси повершинно, листва — целыми квадами: если двигать каждую
 * вершину листа отдельно, лист перекосит тем сильнее, чем он крупнее, а хвоя у нас
 * как раз крупная.
 */
function coneCrown(branches, leaves, cone) {
  if (!cone) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < branches.verts.length; i += 3) {
    minY = Math.min(minY, branches.verts[i]);
    maxY = Math.max(maxY, branches.verts[i]);
  }
  const span = Math.max(1e-6, maxY - minY);
  const squeeze = (y) => 1 - cone * Math.min(1, Math.max(0, (y - minY) / span));

  const bv = branches.verts;
  for (let i = 0; i < bv.length; i += 3) {
    const f = squeeze(bv[i + 1]);
    bv[i] *= f;
    bv[i + 2] *= f;
  }

  const lv = leaves.verts;
  for (let quad = 0; quad * 12 < lv.length; quad++) {
    const base = quad * 12;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < 4; i++) {
      cx += lv[base + i * 3];
      cy += lv[base + i * 3 + 1];
      cz += lv[base + i * 3 + 2];
    }
    cx /= 4;
    cy /= 4;
    cz /= 4;
    const shift = squeeze(cy) - 1;
    for (let i = 0; i < 4; i++) {
      lv[base + i * 3] += cx * shift;
      lv[base + i * 3 + 2] += cz * shift;
    }
  }
}

function bake(variant, shape, form) {
  const tree = new Tree();
  tree.loadPreset(shape.preset);
  tree.options.seed = shape.seed;
  simplify(tree.options, variant);
  tree.generate();
  thinLeaves(tree.leaves);
  coneCrown(tree.branches, tree.leaves, variant.cone ?? 0);
  tiltLeaves(tree.leaves);
  cupLeaves(tree.leaves);
  // Купол — последним: до него листва идёт квадами по двенадцать чисел, и всё
  // выше по конвейеру на эту раскладку опирается.
  domeLeaves(tree.leaves);
  const branches = packBranches(tree.branches);
  const leaves = packLeaves(tree.leaves);
  // Основание ствола и высота: пресеты ez-tree ростом в десятки метров, поэтому
  // в сцене дерево нормируется по высоте, а на землю ставится по основанию.
  const verts = tree.branches.verts;
  let baseY = Infinity;
  let topY = -Infinity;
  for (let i = 1; i < verts.length; i += 3) {
    baseY = Math.min(baseY, verts[i]);
    topY = Math.max(topY, verts[i]);
  }
  const height = topY - baseY;
  const id = form === 0 ? variant.id : `${variant.id}-${form + 1}`;
  console.log(
    `${id}: ${branches.triangles} треугольников ветвей, ${leaves.triangles} листвы, высота ${height.toFixed(1)}`,
  );
  return {
    id,
    species: variant.id,
    preset: shape.preset,
    seed: shape.seed,
    leaf: variant.leaf,
    bark: variant.bark ?? "oak",
    baseY,
    height,
    branches,
    leaves,
  };
}

mkdirSync(OUT_DIR, { recursive: true });
const asset = {
  generator: "@dgreenheck/ez-tree",
  note: "Сгенерировано скриптом tools/bake-trees.mjs. Вручную не править.",
  leafUv: LEAF_UV,
  variants: VARIANTS.flatMap((variant) => variant.forms.map((shape, form) => bake(variant, shape, form))),
};
writeFileSync(`${OUT_DIR}trees.json`, JSON.stringify(asset));

/**
 * Текстуры листвы у ez-tree — 1024×1024, и это на порядок больше нужного: лист
 * занимает на экране десятки пикселей. Своя картинка на породу нужна: хвоя сосны и
 * лист осины отличаются не оттенком, а формой, и одной текстурой на всех лес выходит
 * однообразным независимо от числа вариантов.
 *
 * `sips` есть в macOS из коробки; на другой системе печать просто скопирует исходник,
 * и тогда картинки будут тяжелее.
 */
const size = (path) => `${(statSync(path).size / 1024).toFixed(0)} КБ`;

/**
 * Две правки картинки листа, без которых крона выглядит мёртвой, — и обе делаются
 * здесь, а не в рантайме, потому что это свойства самого файла.
 *
 * Первая: **цвет за краем листа**. У ez-tree прозрачные пиксели чёрные, и это
 * обычная ловушка. Фильтрация и мипы смешивают цвет с соседями, не спрашивая про
 * прозрачность, поэтому на краю каждого листа появляется тёмная кайма, а вдали,
 * где лист занимает пару пикселей, от листа только кайма и остаётся. Крона от
 * этого грязная и жухлая. Лечится растеканием цвета за край: прозрачным пикселям
 * раздаётся цвет ближайших непрозрачных, и смешивать становится не с чем.
 *
 * Вторая: **толщина альфы**. Непрозрачного в картинке шестая часть, и на дальних
 * мипах средняя альфа падает ниже порога отсечения — листва осыпается, оставляя
 * голые ветки. Настоящее лекарство — считать мипы самим, сохраняя долю покрытия;
 * дешёвое и почти такое же — заранее расширить альфу степенью меньше единицы:
 * полупрозрачная бахрома по краю листа становится плотнее, и запаса до порога
 * хватает на несколько мипов.
 */
function healLeaf(image) {
  const { width, height, channels, pixels } = image;
  if (channels !== 4) throw new Error("у листа нет альфы");
  const at = (x, y) => (y * width + x) * 4;
  // Растекание: несколько проходов, каждый занимает пустой пиксель средним цветом
  // уже занятых соседей. Четырёх проходов хватает на любую бахрому.
  const filled = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) filled[i] = pixels[i * 4 + 3] > 8 ? 1 : 0;
  for (let pass = 0; pass < 4; pass++) {
    const next = filled.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (filled[y * width + x]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!filled[ny * width + nx]) continue;
          const from = at(nx, ny);
          r += pixels[from];
          g += pixels[from + 1];
          b += pixels[from + 2];
          n++;
        }
        if (!n) continue;
        const to = at(x, y);
        pixels[to] = Math.round(r / n);
        pixels[to + 1] = Math.round(g / n);
        pixels[to + 2] = Math.round(b / n);
        next[y * width + x] = 1;
      }
    }
    filled.set(next);
  }
  let opaque = 0;
  for (let i = 0; i < width * height; i++) {
    const a = pixels[i * 4 + 3] / 255;
    const wide = Math.min(1, a ** 0.6);
    pixels[i * 4 + 3] = Math.round(wide * 255);
    if (wide > 0.3) opaque++;
  }
  return opaque / (width * height);
}

/**
 * Обесцвечивание пучка: фактура отдельно, цвет породы отдельно.
 *
 * Картинки листвы приходят от ez-tree уже крашеными, и каждая по-своему: у ясеня и
 * дуба лист зелёный, у осины — жёлто-бурый, осенний. Дальше в сцене на них ложится
 * оттенок породы, тоже зелёный, и цвета перемножаются: зелёное на зелёном даёт
 * почти чёрный, зелёное на жёлтом — кислую оливку. Ни то, ни другое в лесу не
 * встречается, а третьей краски у нас нет — картинок четыре на восемь пород.
 *
 * Поэтому цвет из картинки убирается, а фактура остаётся: пиксель сводится к своей
 * яркости, от исходной краски удерживается треть — жилки и края листа заметно
 * темнее и теплее середины, и терять это незачем. Средняя яркость пучка при этом
 * приводится к общему уровню, так что оттенок породы из `view/trees.ts` — это
 * прямо тот цвет, которым крона и получится.
 */
const LEAF_CHROMA = 0.3;
const LEAF_LEVEL = 0.8;

function neutralLeaf(image) {
  const { width, height, pixels } = image;
  const lumAt = (at) => 0.299 * pixels[at] + 0.587 * pixels[at + 1] + 0.114 * pixels[at + 2];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < width * height; i++) {
    // Считаем по тому, что видно: за порогом отсечения лежит растёкшийся цвет каймы.
    if (pixels[i * 4 + 3] <= 77) continue;
    sum += lumAt(i * 4);
    count++;
  }
  if (!count) throw new Error("пучок пуст: нечего обесцвечивать");
  const gain = (LEAF_LEVEL * 255) / (sum / count);
  for (let i = 0; i < width * height; i++) {
    const at = i * 4;
    const lum = lumAt(at);
    for (let c = 0; c < 3; c++) {
      const kept = lum + (pixels[at + c] - lum) * LEAF_CHROMA;
      pixels[at + c] = Math.max(0, Math.min(255, Math.round(kept * gain)));
    }
  }
}

/**
 * Пучок вместо листа.
 *
 * У ez-tree на квад приходится один лист, и это самая дорогая раскладка из
 * возможных: чтобы крона стала кроной, листьев нужны тысячи, а каждый — это четыре
 * вершины и прозрачный треугольник поверх соседа. Пока мы платили за неё честно,
 * дерево выходило редким: квадов хватало на пучок у макушки, а на объём — нет.
 *
 * В играх это решают одинаково: на квад кладут не лист, а горсть листьев одной
 * картинкой. Цена в вершинах та же, листвы в кадре в разы больше, и крона наконец
 * читается массой. Горсть собирается здесь же из того же листа: несколько копий,
 * каждая своего размера и поворота, сложены по альфе.
 *
 * У хвои раскладка другая: иглы длинные и лежат веером от ветки, поэтому копий
 * больше, они уже и все смотрят примерно в одну сторону — получается лапа, а не куст.
 *
 * Вместе с картинкой печатается **рельеф пучка** — карта нормалей, по листу на
 * копию. Без неё вся горсть освещается как одна плоскость, потому что плоскость
 * она и есть: карточка у дуба выходит диагональю в полтора-два метра, и такой
 * кусок кроны, залитый ровным светом, глаз читает как лоскут картона. Дробить
 * карточку геометрией — самый дорогой из способов: чтобы дойти до настоящего
 * размера ветки с листьями, квадов нужно в разы больше, а они и так весь бюджет.
 * Рельеф стоит одной текстуры и одного чтения из неё, а даёт то же самое: каждый
 * нарисованный лист смотрит в свою сторону и ловит свет по-своему.
 */
/** Разброс наклона листа внутри пучка: тангенс угла от плоскости карточки. */
const LEAF_FACE = 0.85;
/** Вздутие самого листа: насколько его края отворачиваются от середины. */
const LEAF_BULGE = 0.45;

function cluster(leaf, { copies, spread, scale, aim }, seed) {
  const side = leaf.width;
  const out = { width: side, height: side, channels: 4, pixels: Buffer.alloc(side * side * 4) };
  // Рельеф пучка: у каждого нарисованного листа своя нормаль. Пустое поле — ровная
  // нормаль «прямо на зрителя», она же нейтральна при смешивании мипов.
  const bump = { width: side, height: side, channels: 4, pixels: Buffer.alloc(side * side * 4) };
  for (let i = 0; i < side * side; i++) {
    bump.pixels[i * 4] = 128;
    bump.pixels[i * 4 + 1] = 128;
    bump.pixels[i * 4 + 2] = 255;
    bump.pixels[i * 4 + 3] = 255;
  }
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };

  const sample = (x, y, into) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= side - 1 || y0 >= side - 1) return false;
    const fx = x - x0;
    const fy = y - y0;
    for (let c = 0; c < 4; c++) {
      const p00 = leaf.pixels[(y0 * side + x0) * 4 + c];
      const p10 = leaf.pixels[(y0 * side + x0 + 1) * 4 + c];
      const p01 = leaf.pixels[((y0 + 1) * side + x0) * 4 + c];
      const p11 = leaf.pixels[((y0 + 1) * side + x0 + 1) * 4 + c];
      into[c] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
    }
    return true;
  };

  const pixel = new Float64Array(4);
  for (let copy = 0; copy < copies; copy++) {
    const size = scale * (0.72 + random() * 0.56);
    const angle = aim * (random() - 0.5) * Math.PI * 2 + (aim < 1 ? (random() - 0.5) * 0.7 : 0);
    const cx = side / 2 + (random() - 0.5) * side * spread;
    const cy = side / 2 + (random() - 0.5) * side * spread;
    const cos = Math.cos(angle) / size;
    const sin = Math.sin(angle) / size;
    const reach = Math.ceil((side * size) / 1.4);
    // Куда смотрит именно этот лист. Плоскость у пучка одна на всех, а листья на
    // ней висят кто куда, и разница видна не в силуэте, а в свете.
    const tiltX = (random() - 0.5) * 2 * LEAF_FACE;
    const tiltY = (random() - 0.5) * 2 * LEAF_FACE;
    for (let y = Math.max(0, cy - reach) | 0; y < Math.min(side, cy + reach); y++) {
      for (let x = Math.max(0, cx - reach) | 0; x < Math.min(side, cx + reach); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (!sample(side / 2 + dx * cos - dy * sin, side / 2 + dx * sin + dy * cos, pixel)) continue;
        const alpha = pixel[3] / 255;
        if (alpha < 0.02) continue;
        const at = (y * side + x) * 4;
        const was = out.pixels[at + 3] / 255;
        const now = alpha + was * (1 - alpha);
        for (let c = 0; c < 3; c++) {
          out.pixels[at + c] = Math.round((pixel[c] * alpha + out.pixels[at + c] * was * (1 - alpha)) / (now || 1));
        }
        out.pixels[at + 3] = Math.round(now * 255);
        // Лист не плоский и сам по себе: к общему наклону добавляется вздутие от
        // середины листа к краям, так что даже один лист светится неровно.
        const spanX = (dx / reach) * LEAF_BULGE;
        const spanY = (dy / reach) * LEAF_BULGE;
        let nx = tiltX + spanX;
        let ny = tiltY + spanY;
        const nlen = Math.hypot(nx, ny, 1);
        nx /= nlen;
        ny /= nlen;
        const nz = 1 / nlen;
        // Смешивается рельеф по той же альфе, что и цвет: верхний лист закрывает
        // нижний целиком, и его нормаль тоже.
        const bumpAt = at;
        const keep = 1 - alpha;
        bump.pixels[bumpAt] = Math.round((nx * 0.5 + 0.5) * 255 * alpha + bump.pixels[bumpAt] * keep);
        bump.pixels[bumpAt + 1] = Math.round((ny * 0.5 + 0.5) * 255 * alpha + bump.pixels[bumpAt + 1] * keep);
        bump.pixels[bumpAt + 2] = Math.round(nz * 255 * alpha + bump.pixels[bumpAt + 2] * keep);
      }
    }
  }
  return { color: out, bump };
}

/**
 * Раскладка пучка по породе листа: у хвои лапа, у широкого листа горсть.
 *
 * Листьев в горсти много, а каждый мелкий — и это не про детализацию, а про то,
 * чем карточка читается с дороги. Первая раскладка складывала восемь крупных копий
 * в плотную звезду во всю картинку, и с тридцати метров такая карточка — сплошное
 * зелёное пятно в полсотни пикселей без единого просвета, то есть ровно плоский
 * лоскут. Крона из них выглядит стопкой плоскостей, сколько их ни поворачивай:
 * дело не в том, как карточка висит, а в том, что сквозь неё ничего не видно.
 *
 * Мелкие копии с зазорами дают дырявый пучок: сквозь него видно небо и соседние
 * ветки, и глаз считывает не лоскут, а листья. Размах при этом ограничен сверху не
 * вкусом: копия, вылезшая за край картинки, обрезается прямой линией, и вместо
 * рваного края пучка получается ножницы. Сумма половины размаха и радиуса копии
 * должна оставаться меньше половины.
 *
 * Числа здесь пересчитаны под купол пучка (`domeLeaves`): карточка выросла в
 * площади вдвое, поэтому копий вдвое больше, а каждая в корень из двух мельче. В
 * мире это ровно те же листья того же размера — меняется только то, на сколько
 * плоскостей они разложены.
 */
const CLUSTERS = {
  aspen: { copies: 26, spread: 0.56, scale: 0.226, aim: 1 },
  ash: { copies: 24, spread: 0.56, scale: 0.233, aim: 1 },
  oak: { copies: 24, spread: 0.55, scale: 0.24, aim: 1 },
  pine: { copies: 26, spread: 0.46, scale: 0.311, aim: 0.22 },
};

const leaves = [...new Set(VARIANTS.map((variant) => variant.leaf))];
for (const leaf of leaves) {
  const source = `${LEAVES_DIR}${leaf}_color.png`;
  const out = `${OUT_DIR}leaf-${leaf}.png`;
  try {
    execFileSync("sips", ["-Z", "256", source, "--out", out], { stdio: "pipe" });
  } catch {
    console.warn(`sips недоступен: ${leaf} скопирован в исходном размере`);
    copyFileSync(source, out);
  }
  const single = decodePng(readFileSync(out));
  healLeaf(single);
  const { color, bump } = cluster(single, CLUSTERS[leaf] ?? CLUSTERS.aspen, 7919);
  const cover = healLeaf(color);
  neutralLeaf(color);
  writeFileSync(out, encodePng(color));
  const bumpOut = `${OUT_DIR}leaf-${leaf}-bump.png`;
  writeFileSync(bumpOut, encodePng(bump));
  console.log(`пучок ${leaf}: ${size(out)} + рельеф ${size(bumpOut)}, покрытие ${(cover * 100).toFixed(0)}%`);
}
/**
 * Кора: те же фотографические текстуры, что идут с ez-tree, но уменьшенные и в JPEG.
 *
 * Плоский цвет коры был второй по заметности претензией к лесу после силуэта, и
 * причина та же, что у травы: у ровной заливки нет масштаба. Ствол в десять метров и
 * куст по колено выглядели одинаково крашеными, а берёзу от осины нельзя было
 * отличить вовсе — а берёза узнаётся именно корой, раньше, чем силуэтом.
 *
 * Килобайты тут стоят внимания: исходники по двести килобайт на породу, а ствол в
 * кадре — это полоска в пару десятков пикселей. Двести пятьдесят шесть точек по
 * стороне и JPEG вместо PNG (прозрачность коре не нужна) дают по три десятка
 * килобайт на породу.
 */
const BARKS = [...new Set(VARIANTS.map((variant) => variant.bark ?? "oak"))];
for (const bark of BARKS) {
  const source = `${BARK_DIR}${bark}_color_1k.jpg`;
  const out = `${OUT_DIR}bark-${bark}.jpg`;
  try {
    execFileSync("sips", ["-Z", "256", "-s", "formatOptions", "70", source, "--out", out], { stdio: "pipe" });
  } catch {
    console.warn(`sips недоступен: кора ${bark} скопирована в исходном размере`);
    copyFileSync(source, out);
  }
  console.log(`кора ${bark}: ${size(out)}`);
}

console.log(`готово: trees.json ${size(`${OUT_DIR}trees.json`)}`);
