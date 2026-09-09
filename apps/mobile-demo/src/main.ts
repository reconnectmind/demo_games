import "@fontsource-variable/geist";
import "./styles.css";

type Screen = "connect" | "baseline" | "today";
type IconName =
  | "arrow"
  | "battery"
  | "brain"
  | "check"
  | "home"
  | "moon"
  | "person"
  | "pulse"
  | "shield"
  | "signal"
  | "spark";

const app = document.querySelector<HTMLDivElement>("#app")!;
if (!app) throw new Error("App root not found");

const icons: Record<IconName, string> = {
  arrow: '<path d="M5 12h12m-4-4 4 4-4 4"/>',
  battery: '<rect x="3" y="7" width="16" height="10" rx="3"/><path d="M21 10v4"/>',
  brain: '<path d="M9.5 4.5A3.5 3.5 0 0 0 6 8v1a3 3 0 0 0-1 5.2A3.5 3.5 0 0 0 9.5 19H12V7.5a3 3 0 0 0-2.5-3Z"/><path d="M14.5 4.5A3.5 3.5 0 0 1 18 8v1a3 3 0 0 1 1 5.2 3.5 3.5 0 0 1-4.5 4.8H12V7.5a3 3 0 0 1 2.5-3Z"/>',
  check: '<path d="m6 12 4 4 8-9"/>',
  home: '<path d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><path d="M9 20v-7h6v7"/>',
  moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
  person: '<circle cx="12" cy="8" r="3"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/>',
  pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  shield: '<path d="M12 3 5.5 5.8v5.4c0 4.2 2.7 7.7 6.5 9.8 3.8-2.1 6.5-5.6 6.5-9.8V5.8Z"/>',
  signal: '<path d="M5 18v-3M9 18v-6m4 6V9m4 9V6"/>',
  spark: '<path d="m13 2-8 12h7l-1 8 8-12h-7Z"/>',
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

function scoreRing(score: number): string {
  const progress = Math.round((score / 100) * 264);
  return `
    <div class="score-ring" role="img" aria-label="Brain fuel score ${score}">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="score-track" cx="50" cy="50" r="42" />
        <circle class="score-progress" cx="50" cy="50" r="42"
          style="stroke-dasharray:${progress} 264" />
      </svg>
      <div><strong>${score}</strong><span>Brain fuel</span></div>
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

const screens: Record<Screen, () => string> = {
  connect: connectScreen,
  baseline: baselineScreen,
  today: todayScreen,
};

function routeFromHash(): Screen {
  const value = location.hash.slice(1);
  return value in screens ? (value as Screen) : "connect";
}

function render(screen = routeFromHash()): void {
  document.title = `ReConnect · ${screen[0]!.toUpperCase()}${screen.slice(1)}`;
  app.innerHTML = `
    <main class="demo-stage">
      <div class="phone" aria-live="polite">${screens[screen]()}</div>
      <nav class="demo-switcher" aria-label="Demo screens">
        ${(["connect", "baseline", "today"] as const)
          .map(
            (name, index) => `
              <button class="${name === screen ? "is-active" : ""}" type="button" data-route="${name}">
                <span>0${index + 1}</span>${name}
              </button>`,
          )
          .join("")}
      </nav>
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
  history.replaceState(null, "", "#connect");
}
render();
