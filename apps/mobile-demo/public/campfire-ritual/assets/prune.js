// The minimal style, after the game Prune: flat colour fields, silhouettes with
// no texture or shading at all, one accent, and light implied by a soft glow
// instead of by highlights. Everything here draws the *same* geometry and the
// same particle systems as the detailed style — only the ink changes.
(() => {
  const { clamp, ellipsePath } = CF.m;
  const { buildOutline, outlinePath } = CF.flameShape;

  // One palette for the whole frame, the way a Prune level has exactly one.
  const P = {
    skyTop: "#0d101a",
    skyLow: "#29364b",
    water: "#090b12",
    ink: "#070810",
    flame: "178,58,77",
    ember: "222,172,119",
    moon: "211,192,190",
    glow: "169,48,73",
    haze: "70,52,81",
  };

  const sky = (ctx, g) => {
    // Two stops, close together: flat enough to read as a single field, graded
    // just enough that the horizon feels lit.
    const grad = ctx.createLinearGradient(0, 0, 0, g.waterY);
    grad.addColorStop(0, P.skyTop);
    grad.addColorStop(1, P.skyLow);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, g.W, g.waterY + 1);
  };

  const moon = (ctx, g) => {
    const r = g.W * 0.05;
    ctx.fillStyle = `rgba(${P.moon},0.42)`;
    ellipsePath(ctx, g.cx + g.W * 0.23, g.H * 0.135, r, r);
    ctx.fill();
  };

  // The fire's light, and the only soft thing in the frame.
  const glow = (ctx, g, s) => {
    const gx = g.cx + s.gust * g.W * 0.08;
    const gy = g.baseY - g.flameH * 0.42;
    const rad = g.W * (0.4 + 0.8 * s.fire) * s.flicker;
    ctx.globalCompositeOperation = "lighter";
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, rad);
    grad.addColorStop(0, `rgba(${P.glow},${(0.1 + 0.28 * s.fire).toFixed(3)})`);
    grad.addColorStop(0.45, `rgba(${P.haze},${(0.04 + 0.12 * s.fire).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${P.haze},0)`);
    ctx.fillStyle = grad;
    ellipsePath(ctx, gx, gy, rad, rad);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  };

  const water = (ctx, g, s) => {
    ctx.fillStyle = P.water;
    ctx.fillRect(0, g.waterY, g.W, g.H - g.waterY);

    // No ripples, no rows: one pool of spilt light where the fire meets it.
    ctx.globalCompositeOperation = "lighter";
    const pool = ctx.createRadialGradient(g.cx, g.waterY, 0, g.cx, g.waterY, g.W * 0.55);
    pool.addColorStop(0, `rgba(${P.glow},${(0.05 + 0.13 * s.fire).toFixed(3)})`);
    pool.addColorStop(1, `rgba(${P.haze},0)`);
    ctx.fillStyle = pool;
    ctx.fillRect(0, g.waterY, g.W, g.H - g.waterY);
    ctx.globalCompositeOperation = "source-over";
  };

  // A single calm plume. `rough` tames the outline generator: torn, licking
  // edges belong to the detailed style, this one wants a drawn curve.
  const flameOpts = (g, s) => ({
    cx: g.cx,
    baseY: g.baseY,
    h: g.flameH * 1.12,
    // Much narrower than the detailed fire: without shading to give it volume,
    // a wide silhouette reads as a balloon rather than as a flame.
    halfW: g.halfW * 0.5,
    shear: s.gust * 0.62,
    turb: 0.4 + 0.8 * s.gust,
    spikes: 2.2,
    seed: 7.3,
    time: s.t,
    rough: 0.5,
    puffK: 1.5,
    puffF: 1.05 * (0.85 + 0.3 * s.fire),
    puffPhase: 0.7,
    samples: 80,
  });

  const botanicals = (ctx, g, s) => {
    const sway = Math.sin(s.t * 0.42) * g.W * 0.006 + s.gust * g.W * 0.018;
    const line = Math.max(0.75, g.W * 0.0022);

    const leaf = (x, y, rx, ry, turn) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(turn);
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    const flower = (x, y, r, turn) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(turn);
      for (let i = 0; i < 5; i += 1) {
        ctx.rotate((Math.PI * 2) / 5);
        ctx.beginPath();
        ctx.ellipse(0, -r * 0.8, r * 0.38, r, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(${P.ember},0.75)`;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    ctx.save();
    ctx.lineWidth = line;
    ctx.strokeStyle = "rgba(190,104,124,0.42)";
    ctx.fillStyle = "rgba(26,37,53,0.82)";

    ctx.beginPath();
    ctx.moveTo(-g.W * 0.03, g.H * 0.94);
    ctx.bezierCurveTo(
      g.W * 0.08,
      g.H * 0.78,
      g.W * 0.06 + sway,
      g.H * 0.45,
      g.W * 0.24 + sway,
      g.H * 0.19,
    );
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(g.W * 1.03, g.H * 0.9);
    ctx.bezierCurveTo(
      g.W * 0.88,
      g.H * 0.72,
      g.W * 0.98 - sway,
      g.H * 0.44,
      g.W * 0.78 - sway,
      g.H * 0.14,
    );
    ctx.stroke();

    leaf(g.W * 0.075 + sway * 0.25, g.H * 0.72, g.W * 0.017, g.W * 0.045, 0.72);
    leaf(g.W * 0.105 + sway * 0.5, g.H * 0.55, g.W * 0.015, g.W * 0.04, 0.48);
    leaf(g.W * 0.158 + sway * 0.7, g.H * 0.37, g.W * 0.013, g.W * 0.037, 0.88);
    leaf(g.W * 0.92 - sway * 0.25, g.H * 0.69, g.W * 0.017, g.W * 0.045, -0.68);
    leaf(g.W * 0.89 - sway * 0.5, g.H * 0.5, g.W * 0.015, g.W * 0.04, -0.48);
    leaf(g.W * 0.84 - sway * 0.7, g.H * 0.31, g.W * 0.013, g.W * 0.037, -0.82);

    ctx.fillStyle = "rgba(153,43,67,0.64)";
    ctx.strokeStyle = "rgba(213,139,151,0.55)";
    flower(g.W * 0.1 + sway * 0.4, g.H * 0.62, g.W * 0.029, -0.35);
    flower(g.W * 0.895 - sway * 0.45, g.H * 0.57, g.W * 0.024, 0.25);

    ctx.strokeStyle = "rgba(207,148,160,0.48)";
    ctx.fillStyle = "rgba(8,10,17,0.82)";
    ctx.save();
    ctx.translate(g.W * 0.2 + sway, g.H * 0.18);
    ctx.rotate(-0.24 + s.gust * 0.08);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-g.W * 0.08, -g.W * 0.055, -g.W * 0.1, g.W * 0.055, 0, g.W * 0.045);
    ctx.bezierCurveTo(g.W * 0.08, -g.W * 0.055, g.W * 0.1, g.W * 0.055, 0, g.W * 0.045);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  };

  const sparks = (ctx, list) => {
    ctx.fillStyle = `rgb(${P.ember})`;
    for (const p of list) {
      const f = clamp(p.life / p.max, 0, 1);
      // Flat dots, no halo and no streak: embers as drifting specks of light.
      ctx.globalAlpha = Math.min(1, f * 2.4) * Math.min(1, (1 - f) * 8 + 0.1) * 0.85;
      ellipsePath(ctx, p.x, p.y, p.size * 0.8, p.size * 0.8);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const render = (ctx, g, s, fire, debris) => {
    sky(ctx, g);
    moon(ctx, g);
    glow(ctx, g, s);
    water(ctx, g, s);
    botanicals(ctx, g, s);

    const outline = buildOutline(flameOpts(g, s));
    const paintFlame = (alpha) => {
      ctx.fillStyle = `rgba(${P.flame},${alpha})`;
      outlinePath(ctx, outline);
      ctx.fill();
    };

    // Graphic mirror: the same silhouette, squashed, dimmed, clipped to the
    // water below the dish. No ripples breaking it up — that would be texture.
    const mirrorY = g.bowlY + g.W * 0.06;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, mirrorY, g.W, g.H - mirrorY);
    ctx.clip();
    ctx.translate(0, mirrorY);
    ctx.scale(1, -0.5);
    ctx.translate(0, -mirrorY);
    paintFlame(0.14);
    ctx.restore();

    CF.scene.drawDishFlat(ctx, g, P.ink);
    paintFlame(0.95);
    CF.scene.drawPileFlat(ctx, g, P.ink);
    sparks(ctx, fire.particles.sparks);
    debris.draw(ctx, g, s, { ink: P.ink });
  };

  CF.prune = { render };
})();
