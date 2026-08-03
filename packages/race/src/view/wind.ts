import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import { JOINT_FAR_M, JOINT_NEAR_M } from "./sway.js";

/**
 * Ветер: качание дерева в вершинном шейдере.
 *
 * Неподвижный лес — главная причина, по которой придорожная обстановка читается
 * декорацией: всё в кадре едет, туман плывёт, облака идут, и только деревья стоят как
 * приколоченные. Лечится это не анимацией и не физикой, а одной строкой в вершинном
 * шейдере: вершину сдвигает бегущая волна, тем сильнее, чем выше вершина над
 * основанием и чем дальше она от ствола.
 *
 * Считать качание на процессоре нельзя: деревьев в кадре под сотню, а вершин в
 * каждом — тысячи, и все они лежат в одном буфере на породу. Двигать матрицы
 * экземпляров дешевле, но тогда дерево качается целиком, как флагшток, а качается
 * оно кроной.
 *
 * Плагин материала — тот способ, которым такое делают в Babylon: обычный
 * `StandardMaterial` со всем его светом остаётся на месте, а мы дописываем ему
 * несколько строк в готовые точки вставки шейдера.
 *
 * ## Звенья и расстояние
 *
 * Дерево гнётся не в одном месте, а в цепочке: ветка, прут, черешок, лист. Считать
 * всю цепочку всегда — не только дорого, но и хуже на вид: у дальнего дерева лист
 * меньше пикселя, и его собственный ход виден не движением, а шипением — вершина
 * скачет между соседними пикселями. Поэтому мелкие звенья включаются по
 * расстоянию (`sway.ts`): вдали дерево качается ветками, вблизи оживают прутья, а
 * у самой дороги лист поворачивается на своей оси сам по себе.
 */

/** Вес качания на вершину: 0 у основания ствола, 1 на конце ветки. */
export const SWAY_KIND = "sway";
/** Ось листа: его середина, одна на все пять вершин. Только у листвы. */
export const PIVOT_KIND = "leafPivot";

/**
 * Запаздывание внутрь дерева, радианы волны.
 *
 * Ветер приходит снаружи: сначала подаётся лист, за ним прут, потом ветка, и
 * только в конце — ствол. Одинаковая фаза на всё дерево читается прямо
 * противоположно — как будто гнётся ствол, а крону он за собой возит; за это
 * дереву и прилетело. Лечится это одной строкой: чем меньше вес качания, тем
 * дальше назад по фазе сдвинута волна.
 *
 * Треть радиана — примерно двадцатая доля периода, полсотни миллисекунд. Меньше
 * не читается, больше выглядит резиновым: крона начинает жить отдельно от ветки.
 */
const LAG = 0.35;

/**
 * Размах поворота листа вокруг собственной оси, радианы.
 *
 * Полтора радиана — это почти прямой угол в каждую сторону, то есть лист успевает
 * повернуться от плоскости к ребру и обратно. Меньше — и он не столько крутится,
 * сколько подрагивает; поворот на пятнадцать градусов от картонки не отличается,
 * потому что глаз ловит не сам угол, а пропадание и возвращение освещённой
 * плоскости.
 */
const LEAF_SPIN = 1.5;
/** Размах хода прутьев в долях хода ветки: прут догибает то, что не догнула ветка. */
const TWIG_BEND = 0.5;

export class WindPlugin extends MaterialPluginBase {
  /** Амплитуда в долях высоты дерева: 0 — штиль. */
  strength = 0;
  /** Фаза волны: секунды, умноженные на частоту. */
  phase = 0;
  /** Направление ветра в мире, единичный вектор в плоскости земли. */
  dirX = 1;
  dirZ = 0;
  /** Трепет листа: для коры ноль, для листвы единица. */
  flutter = 0;
  /**
   * Сила ветра как она есть, от штиля до бури.
   *
   * Отдельно от `strength`, потому что `strength` — это уже не сила, а размах
   * изгиба: доля высоты дерева, куда уходит вершина. Поворот листа мерится не
   * долями высоты, а углом, и своей меры силы ему не хватало — от этого лист
   * вертелся бы одинаково и на ветру, и в полный штиль.
   */
  live = 0;
  /** Где камера: от неё считается, насколько мелко шевелиться. */
  eyeX = 0;
  eyeY = 0;
  eyeZ = 0;

  constructor(material: Material, flutter: number) {
    super(material, "TreeWind", 200, undefined, true, true);
    this.flutter = flutter;
  }

  override getClassName(): string {
    return "TreeWindPlugin";
  }

  override getAttributes(attributes: string[]): void {
    attributes.push(SWAY_KIND);
    if (this.flutter > 0) attributes.push(PIVOT_KIND);
  }

  /**
   * Униформы объявляются дважды, и это не оплошность: Babylon собирает шейдер либо с
   * блоком униформ, либо с ними по одной, смотря по движку и материалу. Первый список
   * попадает в блок, вторая строка — в шейдер без блока, и в готовый код всегда идёт
   * ровно одно из двух. Объявить только блок мало: обычный материал у нас едет как раз
   * без него, и шейдер не собирается — «windDir: undeclared identifier».
   */
  override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }>; vertex: string } {
    return {
      ubo: [
        { name: "windWave", size: 4, type: "vec4" },
        { name: "windDir", size: 2, type: "vec2" },
        { name: "windEye", size: 3, type: "vec3" },
      ],
      vertex: "uniform vec4 windWave;\nuniform vec2 windDir;\nuniform vec3 windEye;",
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    // Третье число раньше несло признак «это листва», но признак этот известен ещё
    // при сборке шейдера — весь лиственный код просто не попадает в кору. Слот
    // отдан силе ветра, которая нужна повороту листа.
    uniformBuffer.updateFloat4("windWave", this.phase, this.strength, this.live, LAG);
    uniformBuffer.updateFloat2("windDir", this.dirX, this.dirZ);
    uniformBuffer.updateFloat3("windEye", this.eyeX, this.eyeY, this.eyeZ);
  }

  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== "vertex") return null;
    const leaf = this.flutter > 0;
    return {
      CUSTOM_VERTEX_DEFINITIONS: `attribute float ${SWAY_KIND};${leaf ? `\nattribute vec3 ${PIVOT_KIND};` : ""}`,
      /**
       * Точка вставки — до того, как позиция уйдёт в мировую матрицу, поэтому вершина
       * здесь в системе самого дерева: основание в нуле, высота единица. Отсюда две
       * мелочи, из которых состоит вся правдоподобность.
       *
       * Первая: направление ветра надо внести в систему дерева, иначе каждое дерево
       * качается по-своему — экземпляры повёрнуты вокруг вертикали случайно, и общий
       * для всех вектор ветра развернётся вместе с ними. Поворот снимается скалярным
       * произведением с осями экземпляра.
       *
       * Вторая: фаза волны берётся от места дерева в мире. Одинаковая фаза на весь лес
       * читается сразу — сотня деревьев кланяется в такт, как строй.
       */
      CUSTOM_VERTEX_UPDATE_POSITION: `
        vec2 windLocal = windDir;
        vec2 windAnchor = vec2(0.0);
        vec3 windWorld = positionUpdated;
        #ifdef INSTANCES
          mat4 windPlace = mat4(world0, world1, world2, world3);
          windWorld = (windPlace * vec4(positionUpdated, 1.0)).xyz;
          windAnchor = vec2(world3.x, world3.z);
          vec2 axisX = vec2(world0.x, world0.z);
          vec2 axisZ = vec2(world2.x, world2.z);
          float axisXLen = length(axisX);
          float axisZLen = length(axisZ);
          if (axisXLen > 0.0001 && axisZLen > 0.0001) {
            windLocal = vec2(dot(windDir, axisX / axisXLen), dot(windDir, axisZ / axisZLen));
          }
        #endif
        float windT = windWave.x + dot(windAnchor, vec2(0.093, 0.071));
        // Волна идёт снаружи внутрь: у податливого края фаза своя, у ствола она
        // отстаёт на целое запаздывание. Ветку ведут прутья, а не наоборот.
        float windLead = clamp(${SWAY_KIND}, 0.0, 1.0);
        float windPhase = windT - windWave.w * (1.0 - windLead);
        // Мелкие звенья — по расстоянию: вдали их не видно как движение, зато
        // отлично слышно как мерцание, поэтому вдали их просто нет.
        float windSpan = ${(JOINT_FAR_M - JOINT_NEAR_M).toFixed(1)};
        float windClose = clamp((distance(windWorld, windEye) - ${JOINT_NEAR_M.toFixed(1)}) / windSpan, 0.0, 1.0);
        float windJoint = 1.0 - windClose * windClose * (3.0 - 2.0 * windClose);
        float windAmp = windWave.y * ${SWAY_KIND};
        // Где у этой вершины сочленение с прутом. У коры это она сама, у листа —
        // его ось: иначе прут растягивал бы лист вместо того, чтобы его нести.
        vec3 windJointAt = positionUpdated;
${leaf ? this.leafCode() : ""}
        float windGust = 0.62 * sin(windPhase) + 0.38 * sin(windPhase * 2.31 + 1.7);
        positionUpdated.xz += windLocal * (windAmp * windGust);
        // Прут: та же волна вдвое чаще и со своим сдвигом по месту в кроне. Он
        // догибает то, что не догнула ветка, поэтому соседние прутья одной ветки
        // расходятся — до сих пор вся крона шла одним куском.
        float windTwig = sin(windPhase * 2.7 + dot(windJointAt, vec3(7.3, 5.1, 6.7)));
        positionUpdated.xz += windLocal * (windAmp * ${TWIG_BEND} * windJoint * windTwig);
      `,
    };
  }

  /**
   * Лист: своя жизнь поверх изгиба ветки.
   *
   * Порядок здесь важнее самих формул. Лист сначала поворачивается вокруг своей
   * оси — то есть меняется его форма относительно точки подвеса, — и только
   * потом всё вместе едет с веткой и прутом. Обратный порядок оторвал бы лист от
   * прута: поворот считался бы вокруг оси, которую ветка уже успела увезти.
   *
   * Ход прута лист берёт по своей оси, а не по каждой вершине. Иначе прут
   * растягивал бы сам лист: пять вершин получили бы пять чуть разных сдвигов, и
   * лист бы медленно дышал.
   */
  private leafCode(): string {
    return `
        windJointAt = ${PIVOT_KIND};
        float windGrain = fract(sin(dot(${PIVOT_KIND}, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        float windFlick = sin(windPhase * 3.7 + windGrain * 6.2831);
        float windSpin = sin(windPhase * 5.3 + windGrain * 12.9);
        // Поворот вокруг собственной оси — то, чего у листа не было вовсе: он
        // ходил вместе с веткой и оставался к ней приклеенным намертво. Ось
        // наклонена от вертикали, чтобы лист не вертелся волчком, а
        // переваливался с плоскости на ребро.
        vec3 windAxis = normalize(vec3(windLocal.x, 0.55, windLocal.y));
        float windTurn = ${LEAF_SPIN} * windWave.z * windJoint * windSpin;
        // В штиль лист стоит: угол берётся от силы ветра, а не от того, что перед
        // нами лист.
        vec3 windRel = positionUpdated - ${PIVOT_KIND};
        float windCos = cos(windTurn);
        float windSin = sin(windTurn);
        positionUpdated = ${PIVOT_KIND} + windRel * windCos + cross(windAxis, windRel) * windSin
          + windAxis * dot(windAxis, windRel) * (1.0 - windCos);
        // Трепет: лист целиком ходит поверх ветки. Он остаётся и вдали — это
        // сдвиг всего листа разом, он не мерцает, а сливается в шевеление кроны.
        positionUpdated += vec3(windLocal.x, 0.7, windLocal.y) * (windAmp * 0.5 * windFlick);
`;
  }
}
