// The fire itself.
//
// A real fire is not one teardrop: it is a handful of competing plumes over a
// bed of coals, each waving on its own clock, and it is *emissive* — where two
// plumes overlap they get brighter. So the silhouettes are built procedurally
// (a centre line that bends with the wind and wanders with noise, plus a width
// profile whose edges are eaten by noise and periodic notches) and then filled
// with vertical gradients in additive blend mode.
(() => {
  const { clamp, lerp, rand, fbm, approach, ellipsePath } = CF.m;

  // Plumes across the coals. The first, wide and low, fuses the bases together
  // so the fire reads as one body near the wood.
  const PLUMES = [
    { dx: 0.0, h: 0.3, w: 1.08, seed: 3.1, phase: 0.4, puffK: 1.6, puffF: 1.15 },
    { dx: -0.46, h: 0.64, w: 0.5, seed: 5.3, phase: 1.1, puffK: 2.4, puffF: 1.75 },
    { dx: 0.44, h: 0.71, w: 0.54, seed: 23.9, phase: 2.6, puffK: 2.1, puffF: 1.5 },
    { dx: -0.15, h: 1.0, w: 0.76, seed: 11.2, phase: 3.9, puffK: 2.6, puffF: 1.3 },
    { dx: 0.19, h: 0.86, w: 0.6, seed: 31.7, phase: 5.2, puffK: 2.3, puffF: 1.6 },
  ];

  // Nested bands inside every plume, hot core last. Colour follows temperature:
  // the root is nearly white, the tips cool to deep red and fade out — the
  // reverse of that ordering is what makes cartoon fire look like cartoon fire.
  // Alphas stay low: five plumes times four bands add up fast in additive blend.
  const BANDS = [
    {
      h: 1.0,
      w: 1.0,
      a: 0.17,
      off: 0,
      turb: 1.0,
      spikes: 3.4,
      stops: [
        [0, [255, 132, 40], 0.85],
        [0.45, [231, 62, 16], 1],
        [1, [148, 18, 8], 0],
      ],
    },
    {
      h: 0.89,
      w: 0.77,
      a: 0.18,
      off: 0.03,
      turb: 1.15,
      spikes: 4.1,
      stops: [
        [0, [255, 186, 76], 0.9],
        [0.5, [255, 98, 24], 1],
        [1, [186, 30, 10], 0],
      ],
    },
    {
      h: 0.73,
      w: 0.55,
      a: 0.2,
      off: 0.06,
      turb: 1.32,
      spikes: 4.9,
      stops: [
        [0, [255, 228, 148], 1],
        [0.5, [255, 152, 46], 0.9],
        [1, [226, 60, 18], 0],
      ],
    },
    {
      h: 0.52,
      w: 0.33,
      a: 0.18,
      off: 0.095,
      turb: 1.55,
      spikes: 5.7,
      stops: [
        [0, [255, 242, 202], 0.9],
        [0.45, [255, 204, 104], 0.8],
        [1, [255, 120, 40], 0],
      ],
    },
  ];

  const SAMPLES = 64;
  const MAX_SPARKS = 260;
  const MAX_LICKS = 36;
  const MAX_SMOKE = 46;

  // Widest a bit above the base, tapering to a long licking tip.
  const profile = (t) =>
    (Math.pow(1 - t, 0.7) * (0.45 + 0.75 * Math.sin(Math.PI * Math.pow(t, 0.42)))) / 1.1;

  // Time factors are low on purpose: the eye reads slow, large motion as the
  // fire breathing and fast, small motion as detail. Swapping that around is
  // what makes a procedural flame look like it is stuttering.
  const axis = (o, t) => {
    const bend = o.shear * o.h * Math.pow(t, 1.7);
    const sway =
      fbm(o.seed + t * 2.4 - o.time * 0.85) * o.h * 0.055 * (0.5 + o.turb) * Math.pow(t, 1.25);
    // Puffs: swellings that travel up the plume, the signature of the shear
    // instability in a real flame. Steady at the root, pronounced higher up.
    // Shapes that opt out (flare-ups, other styles) simply omit the params.
    const puffK = o.puffK || 0;
    const puffF = o.puffF || 0;
    const puffPhase = o.puffPhase || 0;
    const puff =
      1 +
      (0.05 + 0.32 * t) * Math.sin(2 * Math.PI * (t * puffK - o.time * puffF) + puffPhase);
    return {
      x: o.cx + bend + sway,
      w: o.halfW * profile(t) * puff * (1 + 0.1 * fbm(o.seed * 1.7 + t * 3.1 - o.time * 1.05)),
    };
  };

  // Per-side edge modulation: wobble that grows towards the tip plus notches
  // that bite in deeper the higher they are, so the plume breaks into tongues.
  const edge = (o, t, right) => {
    const off = right ? 0 : 37.1;
    // `rough` lets a caller ask for a calmer outline (the minimal style wants
    // a smooth, calligraphic silhouette rather than a torn one).
    const r = o.rough === undefined ? 1 : o.rough;
    const wob =
      1 +
      r *
        ((0.16 + 0.36 * t) * fbm(o.seed + off + t * 4.6 - o.time * 1.2 * o.turb, 2) +
          0.13 * fbm(o.seed * 1.3 + off + t * 12 - o.time * 3.1, 2));
    const phase =
      t * Math.PI * o.spikes - o.time * (right ? 1.7 : 2.0) + o.seed * (right ? 1 : 2.3);
    const notch = 1 - r * (0.14 + 0.42 * t) * Math.pow(Math.max(0, Math.sin(phase)), 5);
    return wob * notch;
  };

  const buildOutline = (o) => {
    const n = o.samples || SAMPLES;
    const pts = new Float32Array((n + 1) * 4);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = o.baseY - o.h * t;
      const a = axis(o, t);
      const eL = edge(o, t, false);
      const eR = edge(o, t, true);
      // Bulges are pulled upwards and notches downwards, so a tongue stretches
      // along the draft instead of scalloping the silhouette horizontally.
      const lift = o.h * 0.18 * t;
      pts[i * 4] = a.x - a.w * eL;
      pts[i * 4 + 1] = y - (eL - 1) * lift;
      pts[i * 4 + 2] = a.x + a.w * eR;
      pts[i * 4 + 3] = y - (eR - 1) * lift;
    }
    return { pts, n };
  };

  const outlinePath = (ctx, outline) => {
    const { pts, n } = outline;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 1; i <= n; i++) ctx.lineTo(pts[i * 4], pts[i * 4 + 1]);
    for (let i = n; i >= 0; i--) ctx.lineTo(pts[i * 4 + 2], pts[i * 4 + 3]);
    ctx.closePath();
  };

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

  const makeBlob = (r, g, b) => {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const cx = c.getContext("2d");
    const grad = cx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.4, `rgba(${r},${g},${b},0.38)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    cx.fillStyle = grad;
    cx.fillRect(0, 0, size, size);
    return c;
  };

  // Exponentially distributed wait: turns a rate into clumpy, natural timing
  // instead of a metronome.
  const wait = (rate) => -Math.log(1 - Math.random()) / Math.max(0.01, rate);

  // The silhouette generator is shared: other styles reuse the same shapes and
  // only change how they are inked.
  CF.flameShape = { profile, axis, buildOutline, outlinePath };

  CF.createFire = () => {
    const sparks = [];
    const licks = [];
    const smoke = [];
    const flashes = [];
    let bands = [];
    let nextSpark = 0;
    let nextBurst = wait(0.2);
    let nextLick = 0;
    let nextSmoke = 0;
    let blobWarm = null;
    let blobSmoke = null;

    const opts = (g, s, plume, band) => {
      const beat = 1 + 0.16 * fbm(s.t * 0.95 + plume.phase * 3.3, 2);
      // Plumes live and die: a slow envelope lets one collapse to a stub while
      // its neighbour surges, so the fire keeps reorganising itself.
      const env = clamp(0.42 + 0.9 * (0.5 + 0.5 * fbm(s.t * 0.33 + plume.seed * 1.9, 2)), 0.2, 1.3);
      // Roots wander a little too, instead of being nailed to fixed positions.
      const drift = fbm(s.t * 0.22 + plume.seed * 2.7) * 0.16;
      return {
        cx: g.cx + (plume.dx + drift) * g.halfW,
        // Hotter bands start further above the wood, which both matches how a
        // flame stands off its fuel and thins out the pile-up at the root.
        baseY: g.baseY - g.flameH * band.off,
        h: g.flameH * plume.h * band.h * beat * env,
        halfW: g.halfW * plume.w * band.w * (0.72 + 0.34 * env),
        shear: s.gust * 0.6,
        turb: (0.35 + 0.9 * s.gust) * band.turb,
        spikes: band.spikes,
        seed: plume.seed + band.spikes * 7.1,
        time: s.t + plume.phase,
        puffK: plume.puffK,
        puffF: plume.puffF * (0.85 + 0.3 * s.fire),
        puffPhase: plume.phase * 2.1,
      };
    };

    const spawnSpark = (g, s, o) => {
      if (sparks.length >= MAX_SPARKS) return;
      const t = rand(0.35, 1.0);
      const a = axis(o, t);
      const p = {
        x: a.x + rand(-0.9, 0.9) * a.w,
        y: o.baseY - o.h * t,
        px: 0,
        py: 0,
        vx: rand(-0.05, 0.05) * g.W,
        vy: -g.H * rand(0.04, 0.14),
        size: g.W * rand(0.0018, 0.0058),
        life: rand(0.7, 2.8),
        max: 0,
        blink: rand(6, 20),
        seed: rand(0, 100),
      };
      p.px = p.x;
      p.py = p.y;
      p.max = p.life;
      sparks.push(p);
    };

    // Resin pockets going off: a flash inside the body of the fire and a
    // shower of fast embers out of it.
    const burst = (g, s) => {
      const x = g.cx + rand(-0.5, 0.5) * g.halfW;
      const y = g.baseY - g.flameH * rand(0.05, 0.45);
      flashes.push({ x, y, r: g.W * rand(0.06, 0.15), life: 0.26, max: 0.26 });
      const n = Math.round(rand(9, 26) * (0.5 + s.fire));
      for (let i = 0; i < n; i++) {
        if (sparks.length >= MAX_SPARKS) break;
        const ang = -Math.PI / 2 + rand(-1.1, 1.1);
        const sp = g.H * rand(0.14, 0.42);
        const p = {
          x: x + rand(-0.03, 0.03) * g.W,
          y,
          px: 0,
          py: 0,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          size: g.W * rand(0.002, 0.006),
          life: rand(0.5, 1.8),
          max: 0,
          blink: rand(8, 26),
          seed: rand(0, 100),
        };
        p.px = p.x;
        p.py = p.y;
        p.max = p.life;
        sparks.push(p);
      }
    };

    // Flare-ups: short-lived bright tongues surging *within* the fire, not
    // floating above it, so they spawn low and barely rise before fading.
    const spawnLick = (g, s) => {
      if (licks.length >= MAX_LICKS) return;
      const plume = PLUMES[1 + ((Math.random() * 4) | 0)];
      const o = opts(g, s, plume, BANDS[1]);
      const t = rand(0.08, 0.55);
      const a = axis(o, t);
      const p = {
        x: a.x + rand(-0.55, 0.55) * a.w,
        y: o.baseY - o.h * t,
        vx: 0,
        vy: -g.H * rand(0.03, 0.08),
        size: g.W * rand(0.022, 0.06) * (0.6 + 0.7 * s.fire),
        life: rand(0.3, 0.85),
        max: 0,
        seed: rand(0, 100),
      };
      p.max = p.life;
      licks.push(p);
    };

    const spawnSmoke = (g, s) => {
      if (smoke.length >= MAX_SMOKE) return;
      const p = {
        x: g.cx + rand(-0.5, 0.5) * g.halfW,
        y: g.baseY - g.flameH * rand(0.75, 1.05),
        vx: 0,
        vy: -g.H * rand(0.03, 0.07),
        r: g.W * rand(0.03, 0.07),
        grow: g.W * rand(0.03, 0.08),
        life: rand(1.6, 3.4),
        max: 0,
        seed: rand(0, 100),
      };
      p.max = p.life;
      smoke.push(p);
    };

    const ensureBlobs = () => {
      if (blobWarm) return;
      blobWarm = makeBlob(255, 186, 104);
      blobSmoke = makeBlob(198, 178, 214);
    };

    const step = (arr, dt, g, s, drag) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        if (p.px !== undefined) {
          p.px = p.x;
          p.py = p.y;
        }
        const turb = fbm(s.t * 1.7 + p.seed) * g.W * 0.06;
        p.vx = approach(p.vx, s.gust * g.W * 0.62 + turb, dt, drag);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy *= 1 - 0.25 * dt;
        p.life -= dt;
        if (p.life <= 0 || p.y < -g.H * 0.1 || p.x < -g.W * 0.4 || p.x > g.W * 1.4)
          arr.splice(i, 1);
      }
    };

    return {
      get counts() {
        return { sparks: sparks.length, licks: licks.length, smoke: smoke.length };
      },

      // Styles that ink the particles themselves read them from here.
      get particles() {
        return { sparks, licks, smoke, flashes };
      },

      // `opts.bands: false` skips the twenty layered outlines for styles that
      // draw their own silhouette; the particle systems keep running.
      update(dt, g, s, o0) {
        bands = [];
        if (!o0 || o0.bands !== false) {
          for (const plume of PLUMES) {
            for (let bi = 0; bi < BANDS.length; bi++) {
              const o = opts(g, s, plume, BANDS[bi]);
              bands.push({ band: BANDS[bi], bi, o, outline: buildOutline(o) });
            }
          }
        }

        const sparkRate = (4 + 58 * s.fire) * (0.55 + 0.95 * s.gust);
        nextSpark -= dt;
        while (nextSpark <= 0) {
          spawnSpark(g, s, opts(g, s, PLUMES[3], BANDS[1]));
          nextSpark += wait(sparkRate);
        }

        nextBurst -= dt;
        if (nextBurst <= 0) {
          burst(g, s);
          nextBurst = wait(0.06 + 0.5 * s.fire);
        }

        nextLick -= dt;
        while (nextLick <= 0) {
          spawnLick(g, s);
          nextLick += wait((1.4 + 9 * s.fire) * (0.8 + 0.6 * s.gust));
        }

        nextSmoke -= dt;
        while (nextSmoke <= 0) {
          spawnSmoke(g, s);
          nextSmoke += wait(3 + 7 * (1 - s.fire) + 4 * s.fire);
        }

        step(sparks, dt, g, s, 0.45);
        step(licks, dt, g, s, 0.6);
        step(smoke, dt, g, s, 1.1);
        for (const p of smoke) p.r += p.grow * dt;
        for (let i = flashes.length - 1; i >= 0; i--) {
          flashes[i].life -= dt;
          if (flashes[i].life <= 0) flashes.splice(i, 1);
        }
      },

      // `mul` dims the whole fire, which is how the water reflection reuses it.
      drawFlame(ctx, g, s, mul) {
        const k = mul === undefined ? 1 : mul;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";

        // Bed of coals under the plumes.
        const bed = ctx.createRadialGradient(g.cx, g.baseY, 0, g.cx, g.baseY, g.halfW * 1.1);
        bed.addColorStop(0, `rgba(255,164,84,${(k * (0.1 + 0.2 * s.fire)).toFixed(3)})`);
        bed.addColorStop(0.5, `rgba(255,104,32,${(k * (0.06 + 0.13 * s.fire)).toFixed(3)})`);
        bed.addColorStop(1, "rgba(255,70,20,0)");
        ctx.fillStyle = bed;
        ellipsePath(ctx, g.cx, g.baseY, g.halfW * 1.1, g.halfW * 0.42);
        ctx.fill();

        // Combustion is hottest right at the wood, and wood gas burns blue.
        const rootY = g.baseY - g.flameH * 0.02;
        const root = ctx.createRadialGradient(g.cx, rootY, 0, g.cx, rootY, g.halfW * 0.62);
        root.addColorStop(0, `rgba(152,196,255,${(k * (0.02 + 0.06 * s.fire)).toFixed(3)})`);
        root.addColorStop(1, "rgba(90,140,255,0)");
        ctx.fillStyle = root;
        ellipsePath(ctx, g.cx, rootY, g.halfW * 0.62, g.halfW * 0.3);
        ctx.fill();

        for (const { band, bi, o, outline } of bands) {
          const grad = ctx.createLinearGradient(0, o.baseY, 0, o.baseY - o.h);
          // Every plume is at its widest near the root, so all twenty layers
          // pile up there; without fading their soles in, the wood sits in a
          // blown-out white patch.
          const [first, ...rest] = band.stops;
          grad.addColorStop(0, rgba(first[1], band.a * k * first[2] * 0.12));
          grad.addColorStop(0.2, rgba(first[1], band.a * k * first[2]));
          for (const [at, c, mul] of rest) grad.addColorStop(at, rgba(c, band.a * k * mul));
          ctx.fillStyle = grad;

          // Smeared copies offset along the draft: over a 1/60 s frame a real
          // flame is motion-blurred, and a crisp edge is what gives away a fake.
          // The hot inner bands are smeared less, or the core blows out white.
          for (const [dy, sx, alpha] of [
            [0.05, 1.11, 0.2 - bi * 0.035],
            [0.02, 1.04, 0.26 - bi * 0.045],
          ]) {
            ctx.save();
            ctx.translate(o.cx, o.baseY - o.h * dy);
            ctx.scale(sx, 1.03);
            ctx.translate(-o.cx, -o.baseY);
            ctx.globalAlpha = alpha;
            outlinePath(ctx, outline);
            ctx.fill();
            ctx.restore();
          }

          ctx.globalAlpha = 1;
          outlinePath(ctx, outline);
          ctx.fill();
        }

        // Filaments: the burning sheet folds, leaving faint bright threads
        // inside the body. Traced along the plume axes to follow the same flow,
        // and faded out towards the tip so they never read as solid tubes.
        ctx.lineCap = "butt";
        for (let i = 1; i < PLUMES.length; i++) {
          const o = opts(g, s, PLUMES[i], BANDS[2]);
          ctx.lineWidth = o.halfW * 0.075;
          const thread = ctx.createLinearGradient(0, o.baseY, 0, o.baseY - o.h);
          thread.addColorStop(0, `rgba(255,226,170,${(k * 0.02).toFixed(3)})`);
          thread.addColorStop(0.3, `rgba(255,216,152,${(k * 0.07).toFixed(3)})`);
          thread.addColorStop(1, "rgba(255,150,70,0)");
          for (let j = 0; j < 3; j++) {
            ctx.strokeStyle = thread;
            ctx.beginPath();
            for (let m = 0; m <= 12; m++) {
              const t = 0.05 + (m / 12) * 0.82;
              const a = axis(o, t);
              const wob = fbm(o.seed + j * 9.1 + t * 6 - o.time * 1.6);
              ctx[m ? "lineTo" : "moveTo"](
                a.x + ((j - 1) * 0.36 + 0.3 * wob) * a.w,
                o.baseY - o.h * t
              );
            }
            ctx.stroke();
          }
        }

        ensureBlobs();

        // Flare-ups and resin flashes live inside the fire, so they are part of
        // this pass and get mirrored into the water along with the flame.
        for (const p of licks) {
          const f = clamp(p.life / p.max, 0, 1);
          ctx.globalAlpha = Math.sin(Math.PI * f) * 0.55 * k;
          const base = {
            cx: p.x,
            baseY: p.y,
            h: p.size * 2.8 * f,
            halfW: p.size * 0.9 * f,
            shear: s.gust * 0.8,
            turb: 1.4,
            spikes: 3.5,
            seed: p.seed,
            time: s.t,
            samples: 18,
          };
          ctx.fillStyle = "#ff8c1e";
          outlinePath(ctx, buildOutline(base));
          ctx.fill();
          ctx.fillStyle = "#ffdf8e";
          outlinePath(
            ctx,
            buildOutline({ ...base, h: base.h * 0.6, halfW: base.halfW * 0.5, seed: p.seed + 3 })
          );
          ctx.fill();
        }

        for (const fl of flashes) {
          const f = fl.life / fl.max;
          ctx.globalAlpha = f * f * 0.7 * k;
          ctx.drawImage(blobWarm, fl.x - fl.r, fl.y - fl.r, fl.r * 2, fl.r * 2);
        }

        ctx.restore();
      },

      drawParticles(ctx, g, s) {
        ensureBlobs();

        // Smoke first: it belongs behind the sparks and reads as haze.
        for (const p of smoke) {
          const f = p.life / p.max;
          const a = 0.1 * Math.sin(Math.PI * clamp(1 - f, 0, 1)) * (1 - 0.4 * s.fire);
          ctx.globalAlpha = a;
          ctx.drawImage(blobSmoke, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
        }
        ctx.globalAlpha = 1;

        ctx.globalCompositeOperation = "lighter";

        for (const p of sparks) {
          const f = clamp(p.life / p.max, 0, 1);
          const blink = 0.65 + 0.35 * Math.sin(s.t * p.blink + p.seed);
          const fade = Math.min(1, f * 2.2) * Math.min(1, (1 - f) * 8 + 0.15) * blink;
          const heat = Math.pow(f, 0.6);
          const col = `rgb(${Math.round(lerp(226, 255, heat))},${Math.round(
            lerp(74, 236, heat)
          )},${Math.round(lerp(28, 168, heat))})`;

          // Fast embers streak; slow ones are points.
          const dx = p.x - p.px;
          const dy = p.y - p.py;
          if (dx * dx + dy * dy > p.size * p.size * 4) {
            ctx.globalAlpha = fade * 0.55;
            ctx.strokeStyle = col;
            ctx.lineWidth = p.size * 1.2;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(p.px - dx * 2, p.py - dy * 2);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }

          const halo = p.size * lerp(1.8, 3.2, heat);
          ctx.globalAlpha = fade * 0.28;
          ctx.drawImage(blobWarm, p.x - halo, p.y - halo, halo * 2, halo * 2);
          ctx.globalAlpha = fade;
          ctx.fillStyle = col;
          ellipsePath(ctx, p.x, p.y, p.size, p.size);
          ctx.fill();
        }

        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      },
    };
  };
})();
