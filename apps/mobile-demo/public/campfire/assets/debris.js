// Leaves blown past the fire. They enter upwind, tumble on two axes and get
// lit by the fire when they pass close to it. Spawn rate and speed follow the
// wind, so dead calm means the odd leaf drifting down instead of a stream.
(() => {
  const { clamp, lerp, rand, pick, fbm, approach } = CF.m;

  const TINTS = [
    [92, 44, 52],
    [122, 58, 42],
    [66, 36, 60],
    [138, 74, 44],
    [74, 40, 38],
  ];

  const MAX = 70;

  const wait = (rate) => -Math.log(1 - Math.random()) / Math.max(0.01, rate);

  CF.createDebris = () => {
    const leaves = [];
    let next = wait(0.4);

    const spawn = (g, s) => {
      if (leaves.length >= MAX) return;
      const depth = rand(0.45, 1.15);
      leaves.push({
        x: -g.W * 0.08,
        y: rand(0.04, 0.86) * g.waterY,
        vx: g.W * (0.05 + 0.5 * s.gust) * depth,
        vy: 0,
        size: g.W * rand(0.016, 0.034) * depth,
        depth,
        spin: rand(0, Math.PI * 2),
        rate: rand(-3.4, 3.4),
        flutter: rand(1.4, 3.6),
        phase: rand(0, Math.PI * 2),
        sink: g.H * rand(0.004, 0.02),
        tint: pick(TINTS),
      });
    };

    return {
      get count() {
        return leaves.length;
      },

      update(dt, g, s) {
        next -= dt;
        while (next <= 0) {
          spawn(g, s);
          next += wait(0.6 + 9 * s.gust);
        }

        for (let i = leaves.length - 1; i >= 0; i--) {
          const p = leaves[i];
          const drive = g.W * (0.04 + 0.72 * s.gust) * p.depth;
          p.vx = approach(p.vx, drive + fbm(s.t * 1.3 + p.phase) * g.W * 0.05, dt, 0.7);
          // Fluttering: leaves fall in a slow zig-zag rather than straight down.
          p.vy = p.sink + Math.sin(s.t * p.flutter + p.phase) * g.H * (0.03 + 0.05 * s.gust);
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.spin += p.rate * dt * (0.4 + 2.2 * s.gust);
          if (p.x > g.W * 1.1 || p.y > g.waterY * 0.99) leaves.splice(i, 1);
        }
      },

      // `opts.ink` asks for flat silhouettes instead of lit leaves, for the
      // minimal style: same shapes and tumbling, no shading and no vein.
      draw(ctx, g, s, opts) {
        const ink = opts && opts.ink;
        const fx = g.cx;
        const fy = g.baseY - g.flameH * 0.4;
        const reach = g.W * (0.35 + 0.5 * s.fire);

        for (const p of leaves) {
          const lit = clamp(1 - Math.hypot(p.x - fx, p.y - fy) / reach, 0, 1) * s.fire;
          // Even away from the fire they keep a little sky light, or they read
          // as holes in the background.
          const r = Math.round(lerp(p.tint[0] + 34, 255, lit * 0.8));
          const gg = Math.round(lerp(p.tint[1] + 22, 176, lit * 0.75));
          const b = Math.round(lerp(p.tint[2] + 26, 104, lit * 0.6));

          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.spin * 0.35 + 0.4);
          // Tumbling: the leaf turns edge-on periodically.
          ctx.scale(1, Math.max(0.12, Math.abs(Math.cos(p.spin))));
          ctx.fillStyle = ink || `rgba(${r},${gg},${b},${(0.55 + 0.4 * p.depth).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(-p.size, 0);
          ctx.quadraticCurveTo(0, -p.size * 0.62, p.size, 0);
          ctx.quadraticCurveTo(0, p.size * 0.62, -p.size, 0);
          ctx.closePath();
          ctx.fill();
          if (!ink) {
            ctx.strokeStyle = `rgba(${r},${gg},${b},0.5)`;
            ctx.lineWidth = Math.max(0.5, p.size * 0.09);
            ctx.beginPath();
            ctx.moveTo(-p.size, 0);
            ctx.lineTo(p.size, 0);
            ctx.stroke();
          }
          ctx.restore();
        }
      },
    };
  };
})();
