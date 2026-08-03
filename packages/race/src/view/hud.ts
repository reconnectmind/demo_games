import { el } from "@gamespace/ui-web";
import { GEAR_NEUTRAL, GEAR_REVERSE, RPM_IDLE, type RaceView } from "../core.js";
import { SHOULDER_M } from "../track.js";

/**
 * Приборы на DOM, а не в 3D: панель должна читаться на телефоне и не стоить
 * кадров. Главный прибор здесь — тахометр: он показывает не скорость, а
 * потраченную впустую тягу, и именно это надо увидеть глазами.
 */

const CSS = `
.race-wrap{position:relative;width:100%;border-radius:12px;overflow:hidden;background:#0e1a2b;aspect-ratio:16/9;min-height:280px}
.race-canvas{display:block;width:100%;height:100%;touch-action:none}
.race-notice{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:#8b949e;font:14px system-ui,sans-serif}
.race-hud{position:absolute;left:0;right:0;bottom:0;display:flex;gap:16px;align-items:flex-end;padding:12px 14px;background:linear-gradient(transparent,rgba(4,10,18,.82));pointer-events:none;color:#e6edf3;font:12px ui-monospace,monospace}
.race-hud-col{display:flex;flex-direction:column;gap:4px;flex:0 0 auto;white-space:nowrap}
.race-hud-col.grow{flex:1 1 auto;min-width:120px}
.race-label{color:#8b949e;font-size:10px;letter-spacing:.06em;text-transform:uppercase}
.race-lane{position:relative;height:9px;border-radius:5px;background:rgba(240,136,62,.2)}
.race-lane-road{position:absolute;top:0;bottom:0;background:rgba(230,237,243,.22);border-radius:2px}
.race-lane-car{position:absolute;top:-2px;margin-left:-2px;width:4px;height:13px;border-radius:2px;background:#58a6ff}
.race-lane-car.is-off{background:#f0883e}
.race-bar{position:relative;height:9px;border-radius:5px;background:rgba(230,237,243,.14);overflow:hidden}
.race-bar-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:5px;transition:width .08s linear}
.race-bar-fill.rpm{background:linear-gradient(90deg,#3fb950,#d29922 62%,#f85149 86%)}
.race-bar-fill.temp{background:linear-gradient(90deg,#58a6ff,#f0883e 70%,#f85149)}
.race-speed{font:600 30px/1 ui-monospace,monospace;font-variant-numeric:tabular-nums}
.race-speed small{font-size:11px;color:#8b949e;font-weight:400}
.race-eff{font:600 20px/1.2 ui-monospace,monospace;font-variant-numeric:tabular-nums}
.race-eff small{margin-left:5px;font-size:10px;color:#8b949e;font-weight:400}
.race-gears{display:flex;gap:3px}
.race-gear{width:12px;height:16px;border-radius:3px;background:rgba(230,237,243,.16)}
.race-gear.is-on{background:#58a6ff;color:#04101f}
.race-gear.slot{width:16px;font:600 10px/16px ui-monospace,monospace;text-align:center;color:#8b949e}
.race-flags{display:flex;gap:6px;min-height:16px}
.race-flag{padding:2px 6px;border-radius:4px;font-size:10px;letter-spacing:.04em;text-transform:uppercase}
.race-flag.heat{background:rgba(248,81,73,.22);color:#ff9c94}
.race-flag.brake{background:rgba(248,81,73,.35);color:#ffd0cc}
.race-flag.off{background:rgba(240,136,62,.22);color:#f0b482}
.race-flag.done{background:rgba(63,185,80,.2);color:#7ee787}
.race-controls{margin-top:10px;flex-wrap:wrap}
.race-controls .btn{min-width:96px}
.race-sound{position:absolute;top:10px;right:10px;width:30px;height:30px;border:0;border-radius:8px;cursor:pointer;background:rgba(4,10,18,.55);color:#e6edf3;font:15px/1 system-ui,sans-serif;pointer-events:auto}
.race-sound:hover{background:rgba(4,10,18,.8)}
.race-sound.is-off{color:#8b949e}
@media (max-width:520px){.race-speed{font-size:22px}.race-hud{gap:9px;font-size:11px}}
`;

let injected = false;

function ensureStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.dataset.race = "hud";
  style.textContent = CSS;
  document.head.append(style);
}

export class RaceHud {
  readonly root = el("div", { class: "race-hud" });
  private readonly rpm = el("div", { class: "race-bar-fill rpm" });
  private readonly temp = el("div", { class: "race-bar-fill temp" });
  private readonly speed = el("div", { class: "race-speed" });
  private readonly gears = el("div", { class: "race-gears" });
  private readonly ratio = el("div", { class: "race-label" });
  private readonly efficiency = el("div", { class: "race-eff" });
  private readonly time = el("div", { class: "race-label" });
  private readonly flags = el("div", { class: "race-flags" });
  private readonly laneLabel = el("div", { class: "race-label", text: "положение в полосе" });
  private readonly laneRoad = el("div", { class: "race-lane-road" });
  private readonly laneCar = el("div", { class: "race-lane-car" });
  private gearCells: HTMLElement[] = [];

  constructor() {
    ensureStyles();
    this.root.append(
      el("div", { class: "race-hud-col" }, [
        el("div", { class: "race-label", text: "скорость" }),
        this.speed,
        this.flags,
      ]),
      el("div", { class: "race-hud-col grow" }, [
        el("div", { class: "race-label", text: "обороты: за отсечкой момента нет вовсе" }),
        el("div", { class: "race-bar" }, [this.rpm]),
        el("div", { class: "race-label", text: "нагрев" }),
        el("div", { class: "race-bar" }, [this.temp]),
        this.laneLabel,
        el("div", { class: "race-lane" }, [this.laneRoad, this.laneCar]),
      ]),
      el("div", { class: "race-hud-col" }, [
        el("div", { class: "race-label", text: "передача" }),
        this.gears,
        this.ratio,
        this.time,
      ]),
      el("div", { class: "race-hud-col" }, [
        el("div", { class: "race-label", text: "КПД" }),
        this.efficiency,
        el("div", { class: "race-label", text: "метров на единицу расхода" }),
      ]),
    );
  }

  render(view: RaceView): void {
    this.speed.innerHTML = `${Math.round(view.speedKmh)}<small> км/ч</small>`;
    this.efficiency.textContent = view.efficiency === 0 ? "—" : view.efficiency.toFixed(1);
    const rpmFrac = (view.rpm - RPM_IDLE) / (view.rpmMax - RPM_IDLE);
    this.rpm.style.width = `${Math.round(Math.max(0, Math.min(1, rpmFrac)) * 100)}%`;
    this.temp.style.width = `${Math.round(Math.max(0, Math.min(1, view.temp)) * 100)}%`;
    const ratio =
      view.gear === GEAR_NEUTRAL
        ? "нейтраль"
        : `${view.gear <= GEAR_REVERSE ? "задний " : ""}×${Math.abs(view.ratio).toFixed(2)}`;
    this.ratio.textContent = `${Math.round(view.rpm)} об/мин · ${ratio}`;

    // Указатель полосы нужен затем, что на обочине дорога уходит из кадра, а
    // вернуться вслепую нельзя: прибор говорит, в какую сторону руль.
    const corridor = view.halfWidth + SHOULDER_M;
    const laneFrac = view.halfWidth / corridor;
    this.laneRoad.style.left = `${((1 - laneFrac) / 2) * 100}%`;
    this.laneRoad.style.width = `${laneFrac * 100}%`;
    const offset = Math.max(-1, Math.min(1, view.lateral / corridor));
    this.laneCar.style.left = `${(offset + 1) * 50}%`;
    this.laneCar.classList.toggle("is-off", view.offroad);
    // Число рядом со шкалой: у края шкалы иначе не понять, насколько далеко съехал.
    const away = Math.abs(view.lateral) - view.halfWidth;
    this.laneLabel.textContent =
      away > 0
        ? `вне полосы на ${away.toFixed(1)} м ${view.lateral > 0 ? "вправо" : "влево"}`
        : `положение в полосе · ${view.lateral >= 0 ? "+" : "−"}${Math.abs(view.lateral).toFixed(1)} м`;

    // Селектор целиком, а не только ступени вперёд: задний ход и нейтраль — такие
    // же положения рычага, и по приборам должно быть видно, в каком из них стоишь.
    // Ступени вперёд остаются полосой, которая наливается: по ней передача читается
    // боковым зрением, не считая клеток.
    if (this.gearCells.length !== view.gears + 2) {
      this.gearCells = [
        el("div", { class: "race-gear slot", text: "R" }),
        el("div", { class: "race-gear slot", text: "N" }),
        ...Array.from({ length: view.gears }, () => el("div", { class: "race-gear" })),
      ];
      this.gears.replaceChildren(...this.gearCells);
    }
    this.gearCells.forEach((cell, index) => {
      const gear = index - 1;
      const on =
        index === 0 ? view.gear <= GEAR_REVERSE : index === 1 ? view.gear === GEAR_NEUTRAL : gear <= view.gear;
      cell.classList.toggle("is-on", on);
    });

    const left = Math.max(0, view.progress.blockMs - view.progress.playedMs);
    this.time.textContent = `осталось ${Math.ceil(left / 1000)} с`;

    const flags: HTMLElement[] = [];
    if (view.braking) flags.push(el("span", { class: "race-flag brake", text: "тормоз" }));
    if (view.overheat) flags.push(el("span", { class: "race-flag heat", text: "перегрев" }));
    if (view.offroad) flags.push(el("span", { class: "race-flag off", text: "вне полосы" }));
    if (view.finished) flags.push(el("span", { class: "race-flag done", text: "блок завершён" }));
    this.flags.replaceChildren(...flags);
  }
}
