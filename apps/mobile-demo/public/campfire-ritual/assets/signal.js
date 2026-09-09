// Signal layer.
//
// The scene never reads the sliders directly. It asks a *source* for two
// normalized channels (`wind`, `fire`, both 0..1) and a hub turns those into
// the smoothed, gust-modulated values the renderer wants. Swapping the
// emulated slider source for real Muse readings later means implementing one
// object with a `read()` method — nothing in the renderer changes.
(() => {
  const { clamp, fbm, approach } = CF.m;

  // Emulation: whatever the two range inputs currently say.
  CF.sliderSource = (windEl, fireEl) => ({
    id: "sliders",
    label: "sliders (emulated)",
    read: () => ({
      wind: clamp(Number(windEl.value) / 100, 0, 1),
      fire: clamp(Number(fireEl.value) / 100, 0, 1),
    }),
  });

  // Placeholder for the real thing: a source fed by `emit`-ed Tauri events.
  // Kept here so the wiring is obvious when the headband arrives.
  CF.eventSource = (eventName, map) => {
    let latest = { wind: 0, fire: 0 };
    const listen = window.__TAURI__ && window.__TAURI__.event.listen;
    if (listen) listen(eventName, (e) => (latest = map(e.payload)));
    return { id: eventName, label: `muse (${eventName})`, read: () => latest };
  };

  CF.createHub = (source) => {
    let wind = 0;
    let fire = 0;
    let t = 0;

    return {
      get label() {
        return source.label;
      },
      setSource(next) {
        source = next;
      },
      tick(dt) {
        const raw = source.read();
        t += dt;

        // Sliders jump; air and fire do not. The fire lags more than the wind
        // because embers keep their heat for a moment.
        wind = approach(wind, raw.wind, dt, 0.45);
        fire = approach(fire, raw.fire, dt, 0.8);

        // Even a fixed wind setting breathes: slow gusts plus a faster ripple,
        // both scaled by the setting so that 0 really is dead calm.
        const breath = 0.78 + 0.34 * fbm(t * 0.37 + 5.5) + 0.16 * fbm(t * 1.6);
        const gust = clamp(wind * breath, 0, 1.25);

        // Flicker is the fire's own unrest, amplified by the wind stirring it.
        // Deliberately slow: this scales the whole flame, and anything fast
        // here makes the fire twitch as a single body instead of shimmering.
        const flicker =
          1 + (0.05 + 0.11 * gust) * fbm(t * 1.1 + 19.3, 2) + 0.015 * fbm(t * 3.2);

        return { wind, fire, gust, flicker, t, raw };
      },
    };
  };
})();
