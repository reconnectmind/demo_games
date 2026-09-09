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
  | "ember-campfire"
  | "ritual-connect"
  | "ritual-baseline"
  | "ritual-today"
  | "ritual-campfire";
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
        <p>The same journey, shaped through three distinct visual languages.</p>
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

        <button class="experience-card experience-ritual" type="button" data-route="ritual-connect">
          <span class="experience-index">03 · Ritual</span>
          <span class="experience-title">Botanical nocturne</span>
          <span class="experience-copy">A dreamlike night garden drawn around one living flame.</span>
          <span class="experience-art ritual-art" aria-hidden="true">
            <i class="ritual-art-moon"></i>
            <i class="ritual-art-line"></i>
            <i class="ritual-art-fire"></i>
          </span>
          <span class="experience-action">Enter ritual ${icon("arrow")}</span>
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

function ritualBrand(): string {
  return `
    <div class="ritual-brand" aria-label="ReConnect Ritual">
      <span>R</span>
      <div><b>ReConnect</b><small>Evening ritual</small></div>
    </div>`;
}

function ritualHeader(chapter: string): string {
  return `
    <header class="ritual-header">
      ${ritualBrand()}
      <span>${chapter}</span>
    </header>`;
}

function ritualPortraitArt(): string {
  return `
    <svg class="ritual-portrait-art" viewBox="0 0 320 380" aria-hidden="true">
      <defs>
        <linearGradient id="ritual-hair" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#26374d" />
          <stop offset="1" stop-color="#11131f" />
        </linearGradient>
        <linearGradient id="ritual-skin" x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stop-color="#eadbd4" />
          <stop offset="1" stop-color="#b99091" />
        </linearGradient>
      </defs>

      <circle class="portrait-moon" cx="223" cy="105" r="76" />
      <path class="portrait-hair-mass" d="M110 79C138 23 235 25 270 88c26 47 6 101 16 153 8 45-3 91-59 110-48 17-119-9-139-66-14-40 12-73 4-111-8-39-4-68 18-95Z" />
      <path class="portrait-neck" d="M151 214c4 39-8 60-36 77 43 34 107 31 144-4-31-14-45-38-43-77Z" />
      <path class="portrait-face" d="M131 78c-11 30-6 54-17 78l-17 19 18 7c4 27 18 54 43 59 23 4 46-18 61-46 13-25 20-74 2-104-16-27-68-39-90-13Z" />
      <path class="portrait-fringe" d="M122 93c22-37 79-43 111-9 12 12 17 27 18 43-23-4-44-20-55-42-3 29-26 49-68 58 8-18 9-33-6-50Z" />
      <path class="portrait-eye" d="M118 155c9 5 18 5 27-1" />
      <path class="portrait-brow" d="M116 144c11-5 21-5 31-1" />
      <path class="portrait-lips" d="M112 193c10 3 17 1 23-4" />

      <g class="portrait-strands">
        <path d="M221 74c69 50 30 145 56 213" />
        <path d="M239 91c35 67-18 123 14 230" />
        <path d="M198 58c66 76 5 147 30 272" />
        <path d="M170 59c-53 70-56 150-27 248" />
        <path d="M148 65c-73 94-33 182-56 248" />
      </g>

      <g class="portrait-vine">
        <path d="M55 343c13-73 52-99 87-143 26-33 38-72 30-119" />
        <path d="M276 343c-21-70-53-92-70-137-13-35-7-75 11-111" />
        <path d="M18 262c50-5 82-28 109-68" />
        <path d="M304 240c-50-12-72-37-85-78" />
        <ellipse cx="80" cy="292" rx="7" ry="18" transform="rotate(38 80 292)" />
        <ellipse cx="106" cy="246" rx="6" ry="16" transform="rotate(52 106 246)" />
        <ellipse cx="53" cy="320" rx="6" ry="15" transform="rotate(-42 53 320)" />
        <ellipse cx="246" cy="280" rx="7" ry="18" transform="rotate(-42 246 280)" />
        <ellipse cx="223" cy="229" rx="6" ry="16" transform="rotate(-58 223 229)" />
        <ellipse cx="270" cy="315" rx="6" ry="15" transform="rotate(38 270 315)" />
      </g>

      <g class="portrait-flowers">
        <g transform="translate(67 223)">
          <ellipse rx="7" ry="18" transform="rotate(0)" />
          <ellipse rx="7" ry="18" transform="rotate(72)" />
          <ellipse rx="7" ry="18" transform="rotate(144)" />
          <ellipse rx="7" ry="18" transform="rotate(216)" />
          <ellipse rx="7" ry="18" transform="rotate(288)" />
          <circle r="5" />
        </g>
        <g transform="translate(248 188) scale(.72)">
          <ellipse rx="7" ry="18" transform="rotate(0)" />
          <ellipse rx="7" ry="18" transform="rotate(72)" />
          <ellipse rx="7" ry="18" transform="rotate(144)" />
          <ellipse rx="7" ry="18" transform="rotate(216)" />
          <ellipse rx="7" ry="18" transform="rotate(288)" />
          <circle r="5" />
        </g>
      </g>

      <g class="portrait-moth" transform="translate(72 92) rotate(-18)">
        <path d="M0 0C-27-22-38 12-7 19L0 8Z" />
        <path d="M2 0C29-22 40 12 9 19L2 8Z" />
        <path d="M1 2v26" />
      </g>
      <path class="portrait-thread" d="M70 119c-18 46 23 62-2 103" />
    </svg>`;
}

function ritualBotanicalFrame(): string {
  return `
    <svg class="ritual-botanical-frame" viewBox="0 0 360 320" aria-hidden="true">
      <path d="M-8 304C41 257 38 172 86 108 109 77 140 61 151 15" />
      <path d="M367 282c-54-25-71-81-72-132-1-45-21-75-54-103" />
      <ellipse cx="45" cy="246" rx="6" ry="18" transform="rotate(48 45 246)" />
      <ellipse cx="68" cy="187" rx="6" ry="17" transform="rotate(37 68 187)" />
      <ellipse cx="92" cy="127" rx="5" ry="15" transform="rotate(55 92 127)" />
      <ellipse cx="310" cy="218" rx="6" ry="18" transform="rotate(-46 310 218)" />
      <ellipse cx="294" cy="161" rx="5" ry="15" transform="rotate(-30 294 161)" />
      <g transform="translate(53 214)">
        <circle r="17" /><circle r="4" />
      </g>
      <g transform="translate(301 190)">
        <circle r="12" /><circle r="3" />
      </g>
    </svg>`;
}

function ritualConnectScreen(): string {
  return `
    <section class="screen is-ritual ritual-connect" data-view="ritual-connect" tabindex="-1">
      ${statusBar()}
      ${ritualHeader("I · Night garden")}

      <main class="ritual-arrival-main">
        <div class="ritual-eyebrow">The threshold</div>
        <h1>Listen for what<br /><em>remains.</em></h1>
        <p class="ritual-lede">The headwear catches the faint current beneath the day’s noise.</p>

        <div class="ritual-portrait-stage">
          ${ritualPortraitArt()}
          <span class="ritual-signal-note">${icon("signal")} Signal found · 4 ms</span>
        </div>

        <article class="ritual-device">
          <span>${icon("check")}</span>
          <div><b>Headwear is ready</b><small>Signal clear · room quiet</small></div>
          <em>82%</em>
        </article>
      </main>

      <footer class="ritual-footer">
        <button class="ritual-button" type="button" data-route="ritual-baseline">
          Cross the threshold ${icon("arrow")}
        </button>
        <button type="button" class="ritual-text-button" data-route="start">Choose another atmosphere</button>
      </footer>
    </section>`;
}

function ritualBaselineScreen(): string {
  return `
    <section class="screen is-ritual ritual-baseline" data-view="ritual-baseline" tabindex="-1">
      ${statusBar()}
      ${ritualHeader("II · Reflection")}

      <main class="ritual-baseline-main">
        <div class="ritual-eyebrow">Tonight’s reading</div>
        <h1>Your weather<br />has roots.</h1>
        <p class="ritual-lede">Alert at the edges. Warm at the centre. The signal gathers like rain before it falls.</p>
        <div class="ritual-baseline-portrait">${ritualPortraitArt()}</div>

        <section class="ritual-reading" aria-label="Tonight's reading">
          <article class="ritual-reading-primary">
            <span>Brain fuel</span>
            <strong>74</strong>
            <small>enough for a gentle close</small>
          </article>
          <div class="ritual-reading-secondary">
            <article>
              <span>Stress</span>
              <b>28</b>
              <i><em style="--measure: 28%"></em></i>
            </article>
            <article>
              <span>Clarity</span>
              <b>83</b>
              <i><em style="--measure: 83%"></em></i>
            </article>
          </div>
        </section>

        <blockquote>
          <span>“</span>
          Keep one flame. Let the rest become night.
        </blockquote>
      </main>

      <footer class="ritual-footer">
        <button class="ritual-button" type="button" data-route="ritual-today">
          See tonight ${icon("arrow")}
        </button>
      </footer>
    </section>`;
}

function ritualNav(): string {
  return `
    <nav class="ritual-nav" aria-label="Ritual navigation">
      <button class="is-active" type="button"><i></i>Today</button>
      <button type="button" data-toast="A quiet record of your evenings will live here.">Notes</button>
      <button type="button" data-route="start">Styles</button>
    </nav>`;
}

function ritualTodayScreen(): string {
  return `
    <section class="screen is-ritual ritual-today" data-view="ritual-today" tabindex="-1">
      ${statusBar()}
      ${ritualHeader("III · Tuesday · 20:42")}

      <main class="ritual-today-main">
        <div class="ritual-eyebrow">For Alex, tonight</div>
        <h1>Feed only the<br /><em>quiet fire.</em></h1>
        <p class="ritual-lede">Wind carries what attention no longer needs. Ten minutes, without a goal.</p>

        <div class="ritual-fire-card">
          <iframe
            src="./campfire-ritual/index.html?preview=1"
            title="Animated preview of a small fire"
            tabindex="-1"
            aria-hidden="true"
          ></iframe>
          <span class="ritual-fire-card-shade"></span>
          ${ritualBotanicalFrame()}
          <button class="ritual-fire-card-action" type="button" data-route="ritual-campfire">
            <span class="ritual-fire-card-copy">
              <small>Recommended · 10 minutes</small>
              <b>Begin the evening ritual</b>
              <em>${icon("arrow")}</em>
            </span>
          </button>
        </div>

        <div class="ritual-today-reading" aria-label="Current state">
          <span>Brain fuel <b>74</b></span>
          <i></i>
          <span>Stress <b>28</b></span>
          <i></i>
          <span>Best before <b>21:30</b></span>
        </div>
      </main>

      ${ritualNav()}
    </section>`;
}

function ritualCampfireScreen(): string {
  return `
    <section class="screen is-ritual ritual-game" data-view="ritual-campfire" tabindex="-1">
      <header class="ritual-game-header">
        <button class="ritual-back" type="button" data-route="ritual-today" aria-label="Back to Today">
          ${icon("arrow")}
        </button>
        <div><b>A small fire</b><span>Evening ritual</span></div>
        <small>10 min</small>
      </header>
      <iframe
        class="ritual-game-frame"
        src="./campfire-ritual/index.html"
        title="A small fire evening ritual"
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
  "ritual-connect": ritualConnectScreen,
  "ritual-baseline": ritualBaselineScreen,
  "ritual-today": ritualTodayScreen,
  "ritual-campfire": ritualCampfireScreen,
};

function routeFromHash(): Screen {
  const value = location.hash.slice(1);
  return value in screens ? (value as Screen) : "start";
}

function demoSwitcher(screen: Screen): string {
  if (screen === "start" || screen.endsWith("-campfire")) return "";
  const ember = screen.startsWith("ember-");
  const ritual = screen.startsWith("ritual-");
  const routes: readonly Screen[] = ritual
    ? ["ritual-connect", "ritual-baseline", "ritual-today"]
    : ember
      ? ["ember-connect", "ember-baseline", "ember-today"]
      : ["connect", "baseline", "today"];
  const labels = ritual
    ? ["Arrival", "Check-in", "Tonight"]
    : ember
      ? ["Arrival", "Weather", "Today"]
      : ["Connect", "Baseline", "Today"];

  return `
    <nav class="demo-switcher${ember ? " is-ember-switcher" : ""}${ritual ? " is-ritual-switcher" : ""}" aria-label="Demo screens">
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
  const ritual = screen.startsWith("ritual-");
  document.title = `ReConnect · ${title}`;
  app.innerHTML = `
    <main class="demo-stage">
      <div class="phone${ember ? " is-ember-phone" : ""}${ritual ? " is-ritual-phone" : ""}" aria-live="polite">${screens[screen]()}</div>
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
