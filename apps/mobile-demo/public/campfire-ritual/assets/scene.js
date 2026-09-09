// Everything around the flame: sky, moon, clouds, water, the dish and the logs.
// All coordinates are derived from the scene size so the composition survives
// any window aspect; `u` (= scene width) is the unit for prop sizes.
(() => {
  const { lerp, rand, hash, noise, fbm, ellipsePath, roundRectPath } = CF.m;

  const SKY = [
    [0.0, "#150c26"],
    [0.32, "#2b1237"],
    [0.58, "#48183a"],
    [0.8, "#5f1f3c"],
    [1.0, "#71243c"],
  ];

  const makeStars = (g) => {
    const n = Math.round((g.W * g.H) / 9000);
    const stars = [];
    for (let i = 0; i < n; i++) {
      stars.push({
        x: rand(0, g.W),
        y: rand(0, g.waterY * 0.82),
        r: rand(0.4, 1.5),
        phase: rand(0, Math.PI * 2),
        speed: rand(0.4, 1.6),
      });
    }
    return stars;
  };

  const makeClouds = (g) => {
    const specs = [
      [0.16, -0.35, 0.9],
      [0.28, 0.55, 0.7],
      [0.42, -0.2, 1.05],
      [0.5, 0.62, 0.6],
      [0.62, 0.1, 0.85],
      [0.72, 0.72, 0.5],
    ];
    return specs.map(([fy, fx, fw], i) => ({
      y: g.waterY * fy,
      x: g.W * fx,
      w: g.W * fw,
      h: g.W * rand(0.05, 0.1),
      alpha: lerp(0.2, 0.08, fy),
      speed: rand(0.45, 1.0),
      seed: i * 13.7,
    }));
  };

  // Position is integrated, never derived from absolute time: deriving it made
  // the clouds jitter backwards whenever the gust speed changed.
  const stepClouds = (g, clouds, dt, gust) => {
    for (const c of clouds) {
      c.x += g.W * (0.006 + 0.15 * gust) * c.speed * dt;
      const span = g.W + c.w * 2;
      if (c.x > g.W + c.w) c.x -= span;
    }
  };

  const drawSky = (ctx, g) => {
    const grad = ctx.createLinearGradient(0, 0, 0, g.waterY);
    for (const [stop, color] of SKY) grad.addColorStop(stop, color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, g.W, g.waterY + 1);
  };

  const drawStars = (ctx, g, stars, t) => {
    ctx.globalCompositeOperation = "lighter";
    for (const s of stars) {
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase));
      ctx.fillStyle = `rgba(255,236,220,${(0.5 * tw).toFixed(3)})`;
      ellipsePath(ctx, s.x, s.y, s.r, s.r);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  const drawMoon = (ctx, g, t) => {
    const r = g.W * 0.033;
    const mx = g.cx;
    const my = g.H * 0.055;

    // A cone of moonlight reaching down to the fire. Stacking a few nested
    // cones fakes a soft edge without a blur filter.
    ctx.globalCompositeOperation = "lighter";
    const beam = ctx.createLinearGradient(0, my, 0, g.waterY);
    beam.addColorStop(0, "rgba(255,226,180,0.05)");
    beam.addColorStop(0.55, "rgba(255,190,150,0.028)");
    beam.addColorStop(1, "rgba(255,170,140,0)");
    ctx.fillStyle = beam;
    for (let i = 0; i < 4; i++) {
      const k = 1 - i * 0.22;
      ctx.beginPath();
      ctx.moveTo(mx - r * 1.5 * k, my);
      ctx.lineTo(mx + r * 1.5 * k, my);
      ctx.lineTo(mx + g.W * 0.3 * k, g.waterY);
      ctx.lineTo(mx - g.W * 0.3 * k, g.waterY);
      ctx.closePath();
      ctx.fill();
    }

    const halo = ctx.createRadialGradient(mx, my, r * 0.6, mx, my, r * 7);
    halo.addColorStop(0, "rgba(255,240,210,0.55)");
    halo.addColorStop(0.28, "rgba(255,214,170,0.16)");
    halo.addColorStop(1, "rgba(255,190,150,0)");
    ctx.fillStyle = halo;
    ellipsePath(ctx, mx, my, r * 7, r * 7);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    const pulse = 1 + 0.02 * Math.sin(t * 0.9);
    ctx.fillStyle = "#fff6dc";
    ellipsePath(ctx, mx, my, r * pulse, r * pulse);
    ctx.fill();
  };

  const drawClouds = (ctx, g, clouds, t) => {
    for (const c of clouds) {
      const x = c.x;
      const sway = fbm(t * 0.2 + c.seed) * g.W * 0.008;
      ctx.fillStyle = `rgba(214,150,196,${c.alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x, c.y + sway);
      ctx.quadraticCurveTo(x + c.w * 0.45, c.y - c.h + sway, x + c.w, c.y - c.h * 0.3 + sway);
      ctx.quadraticCurveTo(x + c.w * 0.5, c.y - c.h * 0.5 + sway, x, c.y + sway);
      ctx.closePath();
      ctx.fill();
    }
  };

  // Warm bloom around the fire; this is what ties the palette together, so it
  // scales with the fire channel rather than being a fixed backdrop.
  const drawFireGlow = (ctx, g, s) => {
    const gx = g.cx + s.gust * g.W * 0.1;
    const gy = g.baseY - g.flameH * 0.35;
    const rad = g.W * (0.5 + 0.8 * s.fire) * s.flicker;
    ctx.globalCompositeOperation = "lighter";

    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, rad);
    glow.addColorStop(0, `rgba(255,190,110,${(0.07 + 0.17 * s.fire).toFixed(3)})`);
    glow.addColorStop(0.35, `rgba(255,120,50,${(0.04 + 0.1 * s.fire).toFixed(3)})`);
    glow.addColorStop(1, "rgba(180,40,30,0)");
    ctx.fillStyle = glow;
    ellipsePath(ctx, gx, gy, rad, rad);
    ctx.fill();

    // Low, wide wash that lifts the horizon and the water line.
    const wash = ctx.createRadialGradient(g.cx, g.waterY, 0, g.cx, g.waterY, g.W * 1.15);
    wash.addColorStop(0, `rgba(255,140,70,${(0.04 + 0.1 * s.fire).toFixed(3)})`);
    wash.addColorStop(1, "rgba(255,90,40,0)");
    ctx.fillStyle = wash;
    ctx.fillRect(0, g.waterY - g.W * 0.6, g.W, g.W * 0.9);
    ctx.globalCompositeOperation = "source-over";
  };

  const drawWater = (ctx, g) => {
    const grad = ctx.createLinearGradient(0, g.waterY, 0, g.H);
    grad.addColorStop(0, "#7b2740");
    grad.addColorStop(0.35, "#3d1531");
    grad.addColorStop(1, "#180b20");
    ctx.fillStyle = grad;
    ctx.fillRect(0, g.waterY, g.W, g.H - g.waterY);
  };

  // Drawn *after* the mirrored flame so the reflection reads as broken water.
  const drawRipples = (ctx, g, s) => {
    const rows = 26;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < rows; i++) {
      const f = i / (rows - 1);
      const y = g.waterY + Math.pow(f, 1.5) * (g.H - g.waterY);
      const wobble = fbm(s.t * (0.6 + f) + i * 3.1) * g.W * (0.02 + 0.06 * s.gust);
      const halfW = g.W * (0.05 + 0.28 * f) * (0.6 + 0.7 * s.fire);
      const a = (1 - f) * (0.05 + 0.1 * s.fire);
      ctx.fillStyle = `rgba(255,170,95,${a.toFixed(3)})`;
      roundRectPath(
        ctx,
        g.cx + wobble - halfW,
        y,
        halfW * 2,
        Math.max(1, g.H * 0.0035),
        g.H * 0.002
      );
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    // A couple of cold ripples further out, for depth.
    for (let i = 0; i < 7; i++) {
      const f = (i + 1) / 8;
      const y = g.waterY + Math.pow(f, 1.4) * (g.H - g.waterY);
      const x = g.cx + Math.sin(i * 2.3 + s.t * 0.5) * g.W * (0.2 + 0.3 * f);
      const w = g.W * (0.06 + 0.12 * f);
      ctx.fillStyle = `rgba(226,186,216,${(0.05 * (1 - f)).toFixed(3)})`;
      roundRectPath(ctx, x - w * 0.5, y, w, Math.max(1, g.H * 0.0025), g.H * 0.002);
      ctx.fill();
    }
  };

  const drawDish = (ctx, g, s) => {
    const rw = g.W * 0.31;
    const rh = rw * 0.155;

    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ellipsePath(ctx, g.cx, g.bowlY + rh * 1.5, rw * 0.9, rh * 0.7);
    ctx.fill();

    // Shallow bowl: a lens hanging below the rim ellipse.
    const body = ctx.createLinearGradient(0, g.bowlY, 0, g.bowlY + rw * 0.5);
    body.addColorStop(0, "#20141c");
    body.addColorStop(1, "#0c070f");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(g.cx - rw, g.bowlY);
    ctx.quadraticCurveTo(g.cx, g.bowlY + rw * 0.5, g.cx + rw, g.bowlY);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#170e15";
    ellipsePath(ctx, g.cx, g.bowlY, rw, rh);
    ctx.fill();

    ctx.globalCompositeOperation = "lighter";
    const pool = ctx.createRadialGradient(g.cx, g.bowlY, 0, g.cx, g.bowlY, rw * 0.9);
    pool.addColorStop(0, `rgba(255,150,70,${(0.12 + 0.4 * s.fire).toFixed(3)})`);
    pool.addColorStop(1, "rgba(255,80,40,0)");
    ctx.fillStyle = pool;
    ellipsePath(ctx, g.cx, g.bowlY, rw * 0.9, rh * 0.95);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    ctx.strokeStyle = `rgba(255,150,90,${(0.14 + 0.34 * s.fire).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, g.W * 0.005);
    ellipsePath(ctx, g.cx, g.bowlY, rw, rh);
    ctx.stroke();
  };

  // A log is a slightly tapered, knobbly cylinder. Every irregularity is
  // derived from the log's seed rather than from time, so the wood stays put
  // while only the heat in its cracks breathes.
  const logBody = (ctx, len, thick, seed, squeeze) => {
    const n = 20;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const r = thick * 0.5 * (1 - 0.12 * t) * (0.88 + 0.14 * noise(seed + t * 7)) * squeeze;
      ctx[i ? "lineTo" : "moveTo"](len * t, -r);
    }
    for (let i = n; i >= 0; i--) {
      const t = i / n;
      const r = thick * 0.5 * (1 - 0.12 * t) * (0.88 + 0.14 * noise(seed + 40 + t * 7)) * squeeze;
      ctx.lineTo(len * t, r);
    }
    ctx.closePath();
  };

  // Where the wood lies. Deliberately uneven: equal angles read as a prop, not
  // as firewood. Shared by both styles so the detailed pile and the flat
  // silhouette are the same pile.
  const PILE = (g) => {
    const u = g.W;
    const y = g.pileY;
    return [
      { x1: g.cx - u * 0.21, y1: y + u * 0.02, x2: g.cx + u * 0.06, y2: y - u * 0.15, thick: u * 0.072, seed: 3.2 },
      { x1: g.cx + u * 0.16, y1: y + u * 0.024, x2: g.cx - u * 0.01, y2: y - u * 0.158, thick: u * 0.06, seed: 17.6 },
      { x1: g.cx - u * 0.17, y1: y + u * 0.046, x2: g.cx + u * 0.19, y2: y + u * 0.028, thick: u * 0.066, seed: 29.4 },
      { x1: g.cx - u * 0.21, y1: y + u * 0.052, x2: g.cx - u * 0.06, y2: y + u * 0.044, thick: u * 0.04, seed: 41.1 },
    ];
  };

  // Broken coals filling the gaps between the logs.
  const coalPath = (ctx, g, i) => {
    const u = g.W;
    const x = g.cx + (hash(i * 2.7) * 2 - 1) * u * 0.16;
    const cy = g.pileY + u * (0.012 + 0.024 * hash(i * 4.9));
    const r = u * (0.012 + 0.016 * hash(i * 6.3));
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const rr = r * (0.7 + 0.5 * hash(i * 8.1 + k));
      ctx[k ? "lineTo" : "moveTo"](x + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.6);
    }
    ctx.closePath();
  };

  const log = (ctx, s, { x1, y1, x2, y2, thick, seed }) => {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const heat = 0.15 + 0.85 * s.fire;
    ctx.save();
    ctx.translate(x1, y1);
    ctx.rotate(ang);

    const body = ctx.createLinearGradient(0, -thick * 0.5, 0, thick * 0.5);
    body.addColorStop(0, "#33211b");
    body.addColorStop(0.4, "#1d1214");
    body.addColorStop(0.78, "#100a0d");
    body.addColorStop(1, "#070406");
    ctx.fillStyle = body;
    logBody(ctx, len, thick, seed, 1);
    ctx.fill();

    ctx.save();
    logBody(ctx, len, thick, seed, 1);
    ctx.clip();

    // Bark: short strokes along the grain, half of them catching the firelight.
    ctx.lineCap = "round";
    for (let i = 0; i < 22; i++) {
      const t = hash(seed + i * 3.7);
      const off = (hash(seed + i * 5.1) - 0.5) * thick * 0.86;
      const l = len * (0.06 + 0.22 * hash(seed + i * 9.3));
      const light = hash(seed + i * 11.7) > 0.55;
      ctx.strokeStyle = light ? "rgba(104,70,52,0.18)" : "rgba(6,4,6,0.5)";
      ctx.lineWidth = thick * (0.02 + 0.035 * hash(seed + i * 13.1));
      ctx.beginPath();
      ctx.moveTo(len * t, off);
      ctx.quadraticCurveTo(
        len * t + l * 0.5,
        off + (hash(seed + i * 17.3) - 0.5) * thick * 0.12,
        len * t + l,
        off + (hash(seed + i * 19.7) - 0.5) * thick * 0.1
      );
      ctx.stroke();
    }

    // Charred patches where the flame licks it.
    for (let i = 0; i < 4; i++) {
      const t = 0.2 + 0.6 * hash(seed + i * 23.1);
      ctx.fillStyle = `rgba(6,4,6,${(0.22 + 0.3 * heat).toFixed(3)})`;
      ellipsePath(
        ctx,
        len * t,
        (hash(seed + i * 29.7) - 0.5) * thick * 0.5,
        len * (0.08 + 0.1 * hash(seed + i * 31.3)),
        thick * 0.42
      );
      ctx.fill();
    }

    // Cracks: wandering polylines glowing from the inside.
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 3; i++) {
      const y0 = (i - 1) * thick * 0.26 + (hash(seed + i * 37.1) - 0.5) * thick * 0.16;
      const pulse = 0.55 + 0.45 * fbm(s.t * 2.4 + seed + i * 7.7);
      const a = heat * (0.34 - i * 0.07) * pulse;
      ctx.strokeStyle = `rgba(255,${(146 + i * 26) | 0},${(58 + i * 30) | 0},${a.toFixed(3)})`;
      ctx.lineWidth = thick * (0.05 + 0.03 * hash(seed + i * 41.3));
      ctx.beginPath();
      const from = len * (0.06 + 0.1 * hash(seed + i * 43.7));
      const to = len * (0.78 - 0.12 * i);
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const x = lerp(from, to, t);
        const y = y0 + noise(seed + i * 51.3 + t * 9) * thick * 0.16;
        ctx[k ? "lineTo" : "moveTo"](x, y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();

    // Rim light: the fire is behind the pile, so the top edge catches it.
    ctx.strokeStyle = `rgba(255,150,86,${(0.08 + 0.22 * s.fire).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, thick * 0.055);
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const r = thick * 0.5 * (1 - 0.12 * t) * (0.88 + 0.14 * noise(seed + t * 7));
      ctx[i ? "lineTo" : "moveTo"](len * t, -r);
    }
    ctx.stroke();

    // Sawn end: growth rings around a hot, charred core.
    const capR = thick * 0.46;
    ctx.fillStyle = "#3a251d";
    ellipsePath(ctx, len, 0, thick * 0.17, capR);
    ctx.fill();
    for (let i = 1; i <= 3; i++) {
      ctx.strokeStyle = `rgba(20,12,12,0.4)`;
      ctx.lineWidth = Math.max(1, thick * 0.02);
      ellipsePath(ctx, len, 0, thick * 0.17 * (i / 3.4), capR * (i / 3.4));
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawLogs = (ctx, g, s) => {
    const u = g.W;
    const y = g.pileY;

    // Ash bed the pile sits in.
    ctx.fillStyle = "rgba(52,40,44,0.55)";
    ellipsePath(ctx, g.cx, y + u * 0.05, u * 0.24, u * 0.035);
    ctx.fill();

    for (const l of PILE(g)) log(ctx, s, l);

    ctx.fillStyle = "#130c0f";
    for (let i = 0; i < 7; i++) {
      coalPath(ctx, g, i);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 11; i++) {
      const a = 0.1 + 0.45 * s.fire * (0.35 + 0.65 * fbm(s.t * 2.2 + i * 11.3));
      const x = g.cx + (hash(i * 3.1) * 2 - 1) * u * 0.17;
      const ey = y - u * 0.015 + (hash(i * 7.7) - 0.5) * u * 0.07;
      const r = u * (0.007 + 0.013 * hash(i * 5.5));
      const em = ctx.createRadialGradient(x, ey, 0, x, ey, r * 3);
      em.addColorStop(0, `rgba(255,208,138,${a.toFixed(3)})`);
      em.addColorStop(1, "rgba(255,90,40,0)");
      ctx.fillStyle = em;
      ellipsePath(ctx, x, ey, r * 3, r * 3);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  // The same props as flat silhouettes: no texture, no gradients, no rim light.
  // The minimal style asks for shape only, so it borrows the outlines above.
  const drawPileFlat = (ctx, g, ink) => {
    ctx.fillStyle = ink;
    for (const l of PILE(g)) {
      ctx.save();
      ctx.translate(l.x1, l.y1);
      ctx.rotate(Math.atan2(l.y2 - l.y1, l.x2 - l.x1));
      // Squeezed thinner than the detailed pile: at full thickness a flat log
      // has no grain to give away its scale and reads as a plank.
      logBody(ctx, Math.hypot(l.x2 - l.x1, l.y2 - l.y1), l.thick, l.seed, 0.58);
      ctx.fill();
      ctx.restore();
    }
    for (let i = 0; i < 7; i++) {
      coalPath(ctx, g, i);
      ctx.fill();
    }
  };

  // Shallower and narrower than the detailed bowl: as a solid shape the full
  // lens turns into a heavy black blot under the fire.
  const drawDishFlat = (ctx, g, ink) => {
    const rw = g.W * 0.26;
    const rh = rw * 0.13;
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.moveTo(g.cx - rw, g.bowlY);
    ctx.quadraticCurveTo(g.cx, g.bowlY + rw * 0.26, g.cx + rw, g.bowlY);
    ctx.closePath();
    ctx.fill();
    ellipsePath(ctx, g.cx, g.bowlY, rw, rh);
    ctx.fill();
  };

  const drawWindStreaks = (ctx, g, s) => {
    if (s.gust < 0.22) return;
    const n = 9;
    const a = (s.gust - 0.22) * 0.12;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < n; i++) {
      const seed = i * 17.3;
      const y = g.waterY * (0.12 + 0.8 * hash(seed));
      const speed = g.W * (0.35 + 0.6 * hash(seed + 1)) * (0.6 + 2.4 * s.gust);
      const x = (((s.t * speed + hash(seed + 2) * g.W * 3) % (g.W * 1.9)) - g.W * 0.45);
      const len = g.W * (0.12 + 0.22 * hash(seed + 3)) * (0.5 + s.gust);
      const grad = ctx.createLinearGradient(x, y, x + len, y);
      grad.addColorStop(0, "rgba(255,220,220,0)");
      grad.addColorStop(0.5, `rgba(255,225,215,${a.toFixed(3)})`);
      grad.addColorStop(1, "rgba(255,220,220,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, len, Math.max(1, g.H * 0.0016));
    }
    ctx.globalCompositeOperation = "source-over";
  };

  const drawVignette = (ctx, g) => {
    const v = ctx.createRadialGradient(
      g.cx,
      g.H * 0.56,
      g.W * 0.25,
      g.cx,
      g.H * 0.56,
      g.H * 0.78
    );
    v.addColorStop(0, "rgba(8,5,14,0)");
    v.addColorStop(1, "rgba(8,5,14,0.6)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, g.W, g.H);
  };

  CF.scene = {
    makeStars,
    makeClouds,
    stepClouds,
    drawSky,
    drawStars,
    drawMoon,
    drawClouds,
    drawFireGlow,
    drawWater,
    drawRipples,
    drawDish,
    drawLogs,
    drawPileFlat,
    drawDishFlat,
    drawWindStreaks,
    drawVignette,
  };
})();
