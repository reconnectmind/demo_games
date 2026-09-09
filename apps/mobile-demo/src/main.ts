import "@fontsource-variable/geist";
import "@fontsource-variable/newsreader";
import "./styles.css";

type Screen =
  | "start"
  | "connect"
  | "baseline"
  | "today"
  | "ember-connect"
  | "ember-baseline"
  | "ember-today"
  | "ember-campfire";
type IconName =
  | "arrow"
  | "battery"
  | "brain"
  | "check"
  | "flame"
  | "home"
  | "leaf"
  | "moon"
  | "person"
  | "pulse"
  | "shield"
  | "signal"
  | "spark"
  | "wind";

const app = document.querySelector<HTMLDivElement>("#app")!;
if (!app) throw new Error("App root not found");

const icons: Record<IconName, string> = {
  arrow: '<path d="M5 12h12m-4-4 4 4-4 4"/>',
  battery: '<rect x="3" y="7" width="16" height="10" rx="3"/><path d="M21 10v4"/>',
  brain: '<path d="M9.5 4.5A3.5 3.5 0 0 0 6 8v1a3 3 0 0 0-1 5.2A3.5 3.5 0 0 0 9.5 19H12V7.5a3 3 0 0 0-2.5-3Z"/><path d="M14.5 4.5A3.5 3.5 0 0 1 18 8v1a3 3 0 0 1 1 5.2 3.5 3.5 0 0 1-4.5 4.8H12V7.5a3 3 0 0 1 2.5-3Z"/>',
  check: '<path d="m6 12 4 4 8-9"/>',
  flame: '<path d="M12 22c4 0 7-2.8 7-7.2 0-3.1-1.7-5.8-5.1-8.5.1 2.6-1 4.1-2.1 5.1.1-3.8-1.5-6.8-4.3-9.4.1 4.8-2.5 7.4-2.5 12.8C5 19.2 8 22 12 22Z"/><path d="M9.5 17.5c0 2 1.1 3.4 2.7 4.3 1.8-1 2.9-2.5 2.9-4.5 0-1.4-.7-2.7-2-4-.2 1.4-.9 2.4-1.7 3.1-.1-1.5-.6-2.7-1.4-3.8-.1 2.1-.5 3.2-.5 4.9Z"/>',
  home: '<path d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><path d="M9 20v-7h6v7"/>',
  leaf: '<path d="M20 4C12 4 6 7.5 5 14c-.4 2.7 1.4 5 4 5 6.5 0 10-6 11-15Z"/><path d="M4 21c3-5 7-8 12-11"/>',
  moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
  person: '<circle cx="12" cy="8" r="3"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/>',
  pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  shield: '<path d="M12 3 5.5 5.8v5.4c0 4.2 2.7 7.7 6.5 9.8 3.8-2.1 6.5-5.6 6.5-9.8V5.8Z"/>',
  signal: '<path d="M5 18v-3M9 18v-6m4 6V9m4 9V6"/>',
  spark: '<path d="m13 2-8 12h7l-1 8 8-12h-7Z"/>',
  wind: '<path d="M3 8h10.5a2.5 2.5 0 1 0-2.2-3.7"/><path d="M3 12h15a2.5 2.5 0 1 1-2.2 3.7"/><path d="M3 16h6"/>',
};

function icon(name: IconName, className = ""): string {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
}

function statusBar(): string {
  return `
    <div class="status-bar" aria-hidden="true">
      <b>9:41</b>
      <span class="status-icons">${icon("signal")}${icon("pulse")}${icon("battery")}</span>
    </div>`;
}

function logo(): string {
  return `<div class="brand" aria-label="ReConnect"><b>Re</b><strong>Connect</strong></div>`;
}

function startScreen(): string {
  return `
    <section class="screen screen-start" data-view="start" tabindex="-1">
      ${statusBar()}
      <header class="choice-header">
        ${logo()}
        <span>Experience study</span>
        <h1>Choose your atmosphere</h1>
        <p>The same journey, shaped through two distinct visual languages.</p>
      </header>

      <main class="choice-main">
        <button class="experience-card experience-precision" type="button" data-route="connect">
          <span class="experience-index">01 · Precision</span>
          <span class="experience-title">Quiet clarity</span>
          <span class="experience-copy">Neutral, clinical and exact. Designed around signal and focus.</span>
          <span class="experience-art precision-art" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
          <span class="experience-action">Start precision ${icon("arrow")}</span>
        </button>

        <button class="experience-card experience-ember" type="button" data-route="ember-connect">
          <span class="experience-index">02 · Ember</span>
          <span class="experience-title">Inner weather</span>
          <span class="experience-copy">Warm, atmospheric and restrained. Inspired by fire moving in wind.</span>
          <span class="experience-art ember-art" aria-hidden="true">
            <i class="ember-moon"></i>
            <i class="ember-wind-line one"></i>
            <i class="ember-wind-line two"></i>
            <i class="ember-flame"></i>
          </span>
          <span class="experience-action">Start ember ${icon("arrow")}</span>
        </button>
      </main>
    </section>`;
}

function connectScreen(): string {
  return `
    <section class="screen screen-connect" data-view="connect" tabindex="-1">
      ${statusBar()}
      <header class="app-header">
        ${logo()}
        <div class="device-indicator" aria-label="Headwear battery 82 percent">
          <span></span><i></i><i></i>
        </div>
      </header>

      <main class="connect-main">
        <div class="connection-visual" aria-label="Device connected">
          <span class="orbit orbit-one"></span>
          <span class="orbit orbit-two"></span>
          <span class="orbit orbit-three"></span>
          <div class="connection-core">
            ${icon("shield")}
            <b>Connected</b>
          </div>
        </div>

        <div class="signal-copy">
          ${icon("signal")}
          <span>Strong signal · 4ms latency</span>
        </div>

        <article class="device-card">
          <span class="device-dot"></span>
          <div>
            <b>ReConnect Headwear</b>
            <small>14 EEG channels active · v2.4.1</small>
          </div>
          <span class="check-badge">${icon("check")}</span>
        </article>
      </main>

      <footer class="screen-footer">
        <button class="primary-button" type="button" data-route="baseline">
          Confirm &amp; Continue ${icon("arrow")}
        </button>
        <button class="text-button" type="button" data-toast="Pairing support is ready to help.">
          Need help pairing?
        </button>
      </footer>
    </section>`;
}

function scoreRing(score: number, label = "Brain fuel"): string {
  const progress = Math.round((score / 100) * 264);
  return `
    <div class="score-ring" role="img" aria-label="Brain fuel score ${score}">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="score-track" cx="50" cy="50" r="42" />
        <circle class="score-progress" cx="50" cy="50" r="42"
          style="stroke-dasharray:${progress} 264" />
      </svg>
      <div><strong>${score}</strong><span>${label}</span></div>
    </div>`;
}

function baselineScreen(): string {
  return `
    <section class="screen screen-baseline" data-view="baseline" tabindex="-1">
      ${statusBar()}
      <header class="title-header">
        <span>Monday, 7 Sep · First reading</span>
        <h1>Your brain state</h1>
      </header>

      <main class="baseline-main">
        ${scoreRing(74)}
        <div class="score-caption">
          <h2>Good baseline</h2>
          <p>Above average · 10 min rest state</p>
        </div>

        <div class="metric-grid" aria-label="Brain state metrics">
          <article class="metric metric-focus"><strong>78</strong><span>Focus</span></article>
          <article class="metric metric-speed"><strong>83</strong><span>Speed</span></article>
          <article class="metric metric-memory"><strong>67</strong><span>Memory</span></article>
        </div>

        <article class="insight-card">
          <span class="insight-icon">${icon("brain")}</span>
          <div>
            <b>First insight</b>
            <p>Your resting state is above average. One pattern to watch: evening alertness spikes. We’ll track this over 7 days.</p>
          </div>
        </article>
      </main>

      <footer class="screen-footer baseline-footer">
        <button class="outline-button" type="button" data-route="today">
          Set your first goal ${icon("arrow")}
        </button>
      </footer>
    </section>`;
}

function stateCard(label: string, value: string, note: string, tone: string): string {
  return `
    <article class="state-card ${tone}">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${note}</small>
    </article>`;
}

function navBar(): string {
  return `
    <nav class="bottom-nav" aria-label="Main navigation">
      <button class="is-active" type="button" aria-current="page">
        ${icon("home")}<span>Today</span>
      </button>
      <button type="button" data-toast="Recovery trends unlock after your first week.">
        ${icon("moon")}<span>Recover</span>
      </button>
      <button type="button" data-toast="Patterns are being learned from your sessions.">
        ${icon("pulse")}<span>Patterns</span>
      </button>
      <button type="button" data-toast="Profile settings are coming next.">
        ${icon("person")}<span>Profile</span>
      </button>
    </nav>`;
}

function todayScreen(): string {
  return `
    <section class="screen screen-today" data-view="today" tabindex="-1">
      ${statusBar()}
      <header class="today-header">
        <div>
          <span>Monday, 7 Sep</span>
          <h1>Good morning, Alex</h1>
        </div>
        <button class="mini-score" type="button" data-route="baseline" aria-label="Review brain score 82">82</button>
      </header>

      <main class="today-main">
        <span class="section-label">Today’s snapshot</span>
        <div class="state-grid">
          ${stateCard("Recovery", "Strong", "● Window open", "is-mint")}
          ${stateCard("AM state", "Alert", "● Peak focus", "is-purple")}
          ${stateCard("Training", "Ready", "Neurofeedback · 15 min", "is-neutral")}
          ${stateCard("Sleep", "7h 20m", "● +12% avg", "is-amber")}
        </div>

        <article class="recommend-card">
          <span class="recommend-icon">${icon("spark")}</span>
          <div>
            <b>Recommended now</b>
            <p>Recovery window is open. Start a 15-min neurofeedback session.</p>
          </div>
          <button type="button" data-toast="Neurofeedback session queued." aria-label="Start recommended session">
            ${icon("arrow")}
          </button>
        </article>
      </main>

      ${navBar()}
    </section>`;
}

function emberLogo(): string {
  return `
    <div class="ember-brand" aria-label="ReConnect Ember">
      ${icon("flame")}
      <span><b>ReConnect</b><small>Ember</small></span>
    </div>`;
}

function emberConnectScreen(): string {
  return `
    <section class="screen is-ember ember-connect" data-view="ember-connect" tabindex="-1">
      ${statusBar()}
      <header class="ember-app-header">
        ${emberLogo()}
        <span class="ember-phase">I · Arrival</span>
      </header>

      <main class="ember-connect-main">
        <div class="ember-sky" role="img" aria-label="A quiet flame moving in the evening wind">
          <img class="ember-detailed-art" src="./art/campfire-detailed.png" alt="" />
        </div>

        <div class="ember-connect-copy">
          <span>${icon("wind")} Signal found</span>
          <h1>Your rhythm is here.</h1>
          <p>Fourteen channels, moving together. The signal is quiet and steady.</p>
        </div>

        <article class="ember-device-card">
          <span class="ember-device-mark">${icon("pulse")}</span>
          <div><b>Headwear connected</b><small>14 channels · stable current</small></div>
          <span class="ember-check">${icon("check")}</span>
        </article>
      </main>

      <footer class="screen-footer ember-footer">
        <button class="ember-primary" type="button" data-route="ember-baseline">
          Enter the quiet ${icon("arrow")}
        </button>
        <button class="text-button" type="button" data-route="start">Choose another atmosphere</button>
      </footer>
    </section>`;
}

function emberBaselineScreen(): string {
  return `
    <section class="screen is-ember ember-baseline" data-view="ember-baseline" tabindex="-1">
      ${statusBar()}
      <header class="ember-title-header">
        <span>First reading · dusk</span>
        <h1>Your inner weather</h1>
      </header>

      <main class="ember-baseline-main">
        <div class="ember-score-wrap">
          <span class="score-wind-line"></span>
          ${scoreRing(74, "Brain fuel")}
          <span class="score-leaf"></span>
        </div>

        <div class="ember-score-caption">
          <h2>A calm current</h2>
          <p>Warm core · steady movement</p>
        </div>

        <div class="ember-metrics" aria-label="Inner weather metrics">
          <article><span>Stillness</span><strong>78</strong></article>
          <article><span>Clarity</span><strong>83</strong></article>
          <article><span>Reserve</span><strong>67</strong></article>
        </div>

        <article class="ember-insight">
          <span>${icon("leaf")}</span>
          <div>
            <b>What the wind carries</b>
            <p>Your baseline holds steady. Energy rises toward evening; a short grounding session may keep the transition soft.</p>
          </div>
        </article>
      </main>

      <footer class="screen-footer ember-footer">
        <button class="ember-outline" type="button" data-route="ember-today">
          Continue to today ${icon("arrow")}
        </button>
      </footer>
    </section>`;
}

function emberNav(): string {
  return `
    <nav class="bottom-nav ember-nav" aria-label="Main navigation">
      <button class="is-active" type="button" aria-current="page">
        ${icon("home")}<span>Today</span>
      </button>
      <button type="button" data-toast="Evening recovery is settling in.">
        ${icon("moon")}<span>Rest</span>
      </button>
      <button type="button" data-toast="Your patterns are still taking shape.">
        ${icon("wind")}<span>Currents</span>
      </button>
      <button type="button" data-route="start">
        ${icon("person")}<span>Styles</span>
      </button>
    </nav>`;
}

function emberTodayScreen(): string {
  return `
    <section class="screen is-ember ember-today" data-view="ember-today" tabindex="-1">
      ${statusBar()}
      <header class="ember-today-header">
        ${emberLogo()}
        <div><span>Tuesday, 8 Sep</span><h1>Good evening, Alex</h1></div>
      </header>

      <main class="ember-today-main">
        <section class="weather-hero">
          <div class="weather-scene" aria-hidden="true">
            <img class="ember-detailed-art" src="./art/campfire-detailed.png" alt="" />
          </div>
          <div class="weather-summary">
            <span>Inner weather</span>
            <h2>Balanced</h2>
            <p>A steady flame in a light current.</p>
          </div>
        </section>

        <div class="weather-readouts">
          <article>${icon("wind")}<span>Stress<b>28%</b></span></article>
          <article>${icon("flame")}<span>Brain fuel<b>74</b></span></article>
        </div>

        <button class="campfire-launch" type="button" data-route="ember-campfire">
          <span class="campfire-launch-icon">${icon("flame")}</span>
          <span><small>Recommended tonight</small><b>Campfire in the wind</b><em>10 min · headphones optional</em></span>
          ${icon("arrow")}
        </button>
      </main>

      ${emberNav()}
    </section>`;
}

function emberCampfireScreen(): string {
  return `
    <section class="screen is-ember ember-game" data-view="ember-campfire" tabindex="-1">
      <header class="ember-game-header">
        <button class="ember-back" type="button" data-route="ember-today" aria-label="Back to Today">
          ${icon("arrow")}
        </button>
        <div>
          <b>Campfire</b>
          <span>in the wind</span>
        </div>
        <small>Live</small>
      </header>
      <iframe
        class="ember-game-frame"
        src="./campfire/index.html"
        title="Campfire in the wind"
        allow="fullscreen"
      ></iframe>
    </section>`;
}

const screens: Record<Screen, () => string> = {
  start: startScreen,
  connect: connectScreen,
  baseline: baselineScreen,
  today: todayScreen,
  "ember-connect": emberConnectScreen,
  "ember-baseline": emberBaselineScreen,
  "ember-today": emberTodayScreen,
  "ember-campfire": emberCampfireScreen,
};

function routeFromHash(): Screen {
  const value = location.hash.slice(1);
  return value in screens ? (value as Screen) : "start";
}

function demoSwitcher(screen: Screen): string {
  if (screen === "start" || screen === "ember-campfire") return "";
  const ember = screen.startsWith("ember-");
  const routes: readonly Screen[] = ember
    ? ["ember-connect", "ember-baseline", "ember-today"]
    : ["connect", "baseline", "today"];
  const labels = ember ? ["Arrival", "Weather", "Today"] : ["Connect", "Baseline", "Today"];

  return `
    <nav class="demo-switcher${ember ? " is-ember-switcher" : ""}" aria-label="Demo screens">
      <button class="style-return" type="button" data-route="start" aria-label="Choose design style">×</button>
      ${routes
        .map(
          (route, index) => `
            <button class="${route === screen ? "is-active" : ""}" type="button" data-route="${route}">
              <span>0${index + 1}</span>${labels[index]}
            </button>`,
        )
        .join("")}
    </nav>`;
}

function render(screen = routeFromHash()): void {
  const title = screen
    .split("-")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" · ");
  const ember = screen.startsWith("ember-");
  document.title = `ReConnect · ${title}`;
  app.innerHTML = `
    <main class="demo-stage">
      <div class="phone${ember ? " is-ember-phone" : ""}" aria-live="polite">${screens[screen]()}</div>
      ${demoSwitcher(screen)}
    </main>
    <div class="toast" role="status" aria-live="polite"></div>`;
}

function navigate(screen: Screen): void {
  if (routeFromHash() === screen) {
    render(screen);
    return;
  }
  location.hash = screen;
}

let toastTimer = 0;
function showToast(message: string): void {
  const toast = document.querySelector<HTMLDivElement>(".toast");
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

app.addEventListener("click", (event) => {
  const target = event.target as Element;
  const routeButton = target.closest<HTMLElement>("[data-route]");
  const route = routeButton?.dataset.route;
  if (route && route in screens) {
    navigate(route as Screen);
    return;
  }

  const toastButton = target.closest<HTMLElement>("[data-toast]");
  if (toastButton?.dataset.toast) showToast(toastButton.dataset.toast);
});

window.addEventListener("hashchange", () => render());

if (!location.hash || !(location.hash.slice(1) in screens)) {
  history.replaceState(null, "", "#start");
}
render();
