// Wiring: canvas sizing, the frame loop, the draw order and the HUD.
(() => {
  const { clamp } = CF.m;

  const canvas = document.getElementById("scene");
  const ctx = canvas.getContext("2d", { alpha: false });
  const windEl = document.getElementById("wind");
  const fireEl = document.getElementById("fire");

  const out = {
    wind: document.getElementById("wind-out"),
    fire: document.getElementById("fire-out"),
  };

  const hub = CF.createHub(CF.sliderSource(windEl, fireEl));
  const fire = CF.createFire();
  const debris = CF.createDebris();

  let geom = null;
  let stars = [];
  let clouds = [];
  document.body.dataset.style = "ritual";
  document.body.classList.toggle("is-preview", new URLSearchParams(location.search).has("preview"));

  const layout = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    geom = {
      W: w,
      H: h,
      cx: w * 0.5,
      waterY: h * 0.83,
      bowlY: h * 0.878,
      pileY: h * 0.845,
      // The flame root sits inside the pile so its flat bottom stays hidden
      // behind the logs and the dish rim.
      baseY: h * 0.845 + w * 0.02,
      flameH: 0,
      halfW: 0,
    };
    stars = CF.scene.makeStars(geom);
    clouds = CF.scene.makeClouds(geom);
  };

  const renderDetailed = (s) => {
    const g = geom;
    ctx.fillStyle = "#0a0715";
    ctx.fillRect(0, 0, g.W, g.H);

    CF.scene.drawSky(ctx, g);
    CF.scene.drawStars(ctx, g, stars, s.t);
    CF.scene.drawMoon(ctx, g, s.t);
    CF.scene.drawClouds(ctx, g, clouds, s.t);
    CF.scene.drawFireGlow(ctx, g, s);
    CF.scene.drawWater(ctx, g);

    // Mirror the flame into the water, squashed and clipped to below the dish,
    // then break it up with ripples.
    const mirrorY = g.bowlY + g.W * 0.06;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, mirrorY, g.W, g.H - mirrorY);
    ctx.clip();
    ctx.translate(0, mirrorY);
    ctx.scale(1, -0.5);
    ctx.translate(0, -mirrorY);
    fire.drawFlame(ctx, g, s, 0.22);
    ctx.restore();
    CF.scene.drawRipples(ctx, g, s);

    CF.scene.drawDish(ctx, g, s);
    fire.drawFlame(ctx, g, s, 1);
    CF.scene.drawLogs(ctx, g, s);
    fire.drawParticles(ctx, g, s);
    debris.draw(ctx, g, s);
    CF.scene.drawWindStreaks(ctx, g, s);
    CF.scene.drawVignette(ctx, g);
  };

  let fps = 60;
  let hudAt = 0;
  const hud = (s) => {
    if (s.t - hudAt < 0.12) return;
    hudAt = s.t;
    out.wind.textContent = `${(s.raw.wind * 18).toFixed(1)} m/s`;
    out.fire.textContent = `${Math.round(s.raw.fire * 100)}%`;
  };

  const paintSlider = (el) => {
    el.style.setProperty("--fill", `${el.value}%`);
  };

  let last = performance.now();
  const frame = (now) => {
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    if (dt > 0) fps += ((1 / dt - fps) * dt) / 0.35;

    if (geom) {
      const s = hub.tick(dt);
      // Fire sets how tall and wide the flame stands; wind only bends it.
      geom.flameH = geom.H * (0.2 + 0.5 * s.fire) * s.flicker;
      geom.halfW = geom.W * (0.15 + 0.19 * s.fire);
      CF.scene.stepClouds(geom, clouds, dt, s.gust);
      fire.update(dt, geom, s, { bands: false });
      debris.update(dt, geom, s);
      CF.prune.render(ctx, geom, s, fire, debris);
      hud(s);
    }
    requestAnimationFrame(frame);
  };

  for (const el of [windEl, fireEl]) {
    paintSlider(el);
    el.addEventListener("input", () => paintSlider(el));
  }

  new ResizeObserver(layout).observe(canvas);
  window.addEventListener("resize", layout);
  layout();
  requestAnimationFrame(frame);
})();
