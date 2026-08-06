/**
 * `@gamespace/flora` — растения: породы, испечённые деревья, качание на ветру.
 *
 * Пакет знает, как дерево устроено и как оно отзывается на ветер, и не знает,
 * где деревья растут: место — дело того мира, в который их сажают. Ветер приходит
 * из среды (`@gamespace/env`) готовым: сила, сторона, фаза волны. Флоре остаётся
 * своё — во сколько эта сила обходится ветке, прутику и листу, и с какого
 * расстояния мелкие звенья вообще стоит шевелить.
 */
export { loadTreeField } from "./trees.js";
export type { TreeField, TreeSpot } from "./trees.js";
export { SPECIES, speciesAt } from "./species.js";
export type { Species } from "./species.js";
export { JOINT_FAR_M, JOINT_NEAR_M, LEAF_VERTS, jointDetail, leafPivots } from "./sway.js";
export { PIVOT_KIND, SWAY_KIND, WindPlugin } from "./wind.js";
export { LeafGlowPlugin } from "./foliage.js";
