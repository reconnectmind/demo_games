import * as THREE from "three";
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };
const { Tree, TreePreset } = await import("@dgreenheck/ez-tree");
const t = new Tree();
for (const name of ["Aspen Medium", "Oak Medium", "Ash Medium", "Pine Medium"]) {
  t.loadPreset(name);
  const b = t.options.branch;
  console.log(name, JSON.stringify({ levels: b.levels, sections: b.sections, segments: b.segments, radius: b.radius, children: b.children, gnarliness: b.gnarliness, twist: b.twist, force: b.force, length: b.length, taper: b.taper }));
}
