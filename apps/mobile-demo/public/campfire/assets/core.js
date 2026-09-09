// Small math toolbox shared by the scene and the fire. No dependencies, no
// build step — the files are loaded in order by index.html and cooperate
// through the single `CF` namespace.
window.CF = window.CF || {};

(() => {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  // Deterministic hash → [0,1). Cheap enough to call a few thousand times per
  // frame, which is what the flame outline does.
  const hash = (n) => {
    const s = Math.sin(n * 127.1) * 43758.5453123;
    return s - Math.floor(s);
  };

  // Value noise in [-1,1]; `fbm` stacks octaves for the wispier motion.
  const noise = (x) => {
    const i = Math.floor(x);
    const f = smoothstep(x - i);
    return lerp(hash(i), hash(i + 1), f) * 2 - 1;
  };

  const fbm = (x, octaves = 3) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq);
      norm += amp;
      freq *= 2.03;
      amp *= 0.5;
    }
    return sum / norm;
  };

  // Frame-rate independent exponential approach; `tau` is the time constant.
  const approach = (cur, target, dt, tau) =>
    cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

  // Rounded rectangle path in the *current* transform (ctx.roundRect is not
  // available on every WebView we may end up on).
  const roundRectPath = (ctx, x, y, w, h, r) => {
    const rr = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  };

  const ellipsePath = (ctx, cx, cy, rx, ry) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  };

  CF.m = {
    clamp,
    lerp,
    smoothstep,
    rand,
    pick,
    hash,
    noise,
    fbm,
    approach,
    roundRectPath,
    ellipsePath,
  };
})();
