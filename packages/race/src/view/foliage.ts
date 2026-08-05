import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { Material } from "@babylonjs/core/Materials/material";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";

/**
 * Просвет листа: свет, прошедший лист насквозь.
 *
 * Лист тонкий и полупрозрачный, и теневая сторона кроны светится изнутри — это то,
 * по чему дерево узнаётся деревом, а не зелёной скалой. Обычная модель освещения
 * такого не умеет: у неё сторона, отвёрнутая от солнца, получает только небо и
 * уходит в чёрное. Отсюда и берётся выбор, между которым мы метались: либо чёрная
 * половина кроны, либо `twoSidedLighting` — переворот нормали к зрителю, от
 * которого крона идёт пятнами. Пятна не случайны: лист собран крестом из двух
 * квадов, и при проезде мимо каждый из них по очереди меняет сторону, вспыхивая и
 * гаснув. Это и читается как неестественный блик.
 *
 * Здесь третий вариант, физически осмысленный: нормаль не трогаем, а к освещению
 * добавляем прошедший насквозь свет. Он тем сильнее, чем больше лист отвёрнут от
 * солнца, и заметно усиливается, когда смотришь против солнца — тогда крона
 * вспыхивает жёлто-зелёным, как и в жизни.
 */
export class LeafGlowPlugin extends MaterialPluginBase {
  /** Цвет прошедшего света: у листа он желтее и светлее отражённого. */
  r = 0.6;
  g = 0.8;
  b = 0.35;
  /** Сколько света лист пропускает: 0 — непрозрачная чешуйка. */
  strength = 0;

  constructor(material: Material) {
    super(material, "LeafGlow", 210, undefined, true, true);
  }

  override getClassName(): string {
    return "LeafGlowPlugin";
  }

  /** Как и у ветра, объявление идёт дважды: в блок униформ и отдельными строками. */
  override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: [{ name: "leafGlow", size: 4, type: "vec4" }],
      fragment: "uniform vec4 leafGlow;",
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat4("leafGlow", this.r, this.g, this.b, this.strength);
  }

  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    return {
      /**
       * Точка вставки — после того, как сложены все источники, но **до тумана**.
       * Здесь уже есть и нормаль, и взгляд, и цвет листа с текстурой, а дальний лес
       * ещё не утоплен в дымку: добавь просвет после неё — и крона у горизонта
       * начнёт светиться сквозь туман. Соседняя точка, «перед записью цвета»,
       * выглядит подходящей по названию, но стоит уже за туманом, и правка
       * слагаемых освещения в ней не делает ничего: цвет к тому моменту собран.
       *
       * Свет берётся только от нулевого источника и только если это солнце: в сцене
       * их два, и второй — полусферный, он и так светит со всех сторон, добавлять
       * ему изнанку не к чему. Направление у направленного света лежит в `xyz`
       * как ход луча, поэтому к солнцу — минус он.
       */
      CUSTOM_FRAGMENT_BEFORE_FOG: `
        #if defined(LIGHT0) && defined(DIRLIGHT0)
          if (leafGlow.a > 0.0) {
            vec3 leafToSun = normalize(-vLightData0.xyz);
            // Отвёрнутость от солнца: у обращённого к солнцу листа просвета нет,
            // ему хватает отражённого.
            float leafBack = max(0.0, dot(-normalW, leafToSun));
            // Взгляд против солнца: рассеяние вперёд, из-за него крона на просвет
            // ярче, чем сбоку. Квадрат — чтобы это была вспышка, а не общий подъём.
            float leafToward = max(0.0, dot(viewDirectionW, -leafToSun));
            float leafScatter = leafBack * (0.40 + 0.60 * leafToward * leafToward);
            color.rgb += leafGlow.rgb * (leafGlow.a * leafScatter) * vLightDiffuse0.rgb * baseColor.rgb;
          }
        #endif
      `,
    };
  }
}
