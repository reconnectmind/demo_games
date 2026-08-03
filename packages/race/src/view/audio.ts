/**
 * Голос машины: граф Web Audio и больше ничего.
 *
 * Решение о том, что должно звучать, принимает `sound.ts` — чистая арифметика,
 * которую проверяет тест. Здесь остаётся только проводка: узлы, их соединения и
 * подстановка чисел из смеси в параметры. Разделено так нарочно — эта половина
 * без браузера не запускается вовсе, поэтому она должна быть настолько скучной,
 * чтобы в ней нечему было ломаться.
 *
 * Звук синтезируется, а не проигрывается из файлов. Причина не в экономии: у
 * записи нет оборотов. Мотор здесь — это поезд выхлопных импульсов, пропущенный
 * через резонансы трубы, и он тянется непрерывно от холостых до отсечки,
 * отзываясь на газ в тот же кадр; никакая склейка сэмплов так не умеет. Шины —
 * это шум под фильтром, и покрытие меняет ему окраску плавно, потому что колесо
 * съезжает на обочину плавно.
 *
 * Мотор собран как источник и труба порознь (`sound.ts` объясняет, почему это
 * единственный способ не получить синтезаторный писк):
 *
 * - на каждый ряд цилиндров свой осциллятор, и его волна — посчитанный спектр
 *   поезда вспышек этого ряда, так что высота едет с оборотами вся целиком;
 * - за осциллятором цепочка колокольных фильтров на резонансах трубы, и вот они
 *   стоят на месте при любых оборотах, потому что длина трубы от оборотов не
 *   зависит.
 */

import {
  BREATH_ORDERS,
  BREATH_PULSE,
  CABIN,
  EXHAUST_BANKS,
  INTAKE_CUT,
  INTAKE_DB,
  INTAKE_Q,
  MUFFLER,
  PIPE_DB,
  PIPE_PAN,
  PIPE_Q,
  PIPE_SHARE,
  PIPE_SPREAD,
  SILENCE,
  WIND_BAND,
  bankFirings,
  easeSound,
  exhaustOrders,
  intakeFirings,
  intakeModes,
  pipeDelay,
  pipeModes,
  soundMix,
  type Orders,
  type SoundIn,
  type SoundMix,
} from "./sound.js";

/** Длина петли шума, секунды. Короче — слышно повтор, длиннее — незачем. */
const NOISE_S = 2;

/** Полоса дыхания выпуска, Гц: ниже гудит труба, выше уже шипение, а не поток. */
const BREATH_HZ = 480;
const BREATH_Q = 0.5;

/** Резонанс визга: узкая полоса, иначе получится шипение, а не крик резины. */
const SQUEAL_Q = 9;
/** Как выше основного тона поёт вторая форманта визга. */
const SQUEAL_UP = 2.4;
const SQUEAL_UP_GAIN = 0.45;

export interface RaceAudio {
  update(input: SoundIn, dtS: number): void;
  setMuted(muted: boolean): void;
  muted(): boolean;
  /**
   * Что звучит прямо сейчас. Нужно затем, что звук — единственная часть сцены,
   * которую нельзя посмотреть глазами: тест проверяет смесь, но не проводку, а
   * на слух не отличишь «мотор не отзывается на газ» от «браузер не пустил
   * контекст». Здесь видно и то и другое.
   */
  probe(): { context: string; mix: SoundMix };
  dispose(): void;
}

type Ctor = typeof AudioContext;

function contextCtor(): Ctor | null {
  const scope = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Ровный шум: одна петля на всех, кто шумит. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * NOISE_S);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let value = 0;
  for (let i = 0; i < frames; i++) {
    // Лёгкое сглаживание убирает самый верх спектра: чистый белый шум звучит
    // как радиопомеха, а шина всё-таки шуршит, а не свистит.
    value = value * 0.35 + (Math.random() * 2 - 1) * 0.65;
    data[i] = value;
  }
  return buffer;
}

function noiseSource(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start();
  return source;
}

/** Осциллятор, играющий готовый спектр поезда импульсов. */
function pulseSource(ctx: AudioContext, orders: Orders): OscillatorNode {
  const wave = ctx.createPeriodicWave(Float32Array.from(orders.real), Float32Array.from(orders.imag), {
    disableNormalization: false,
  });
  const pulses = ctx.createOscillator();
  pulses.setPeriodicWave(wave);
  pulses.frequency.value = 20;
  return pulses;
}

/**
 * Один ряд цилиндров: поезд вспышек в свою трубу.
 *
 * Волна задана спектром, а не формой, и это не каприз API: фазы гармоник здесь
 * несут моменты вспышек, то есть всю неравномерность крестового коленвала, — а
 * из формы её пришлось бы вычислять обратно. Осцилляторы рядов пущены разом и
 * получают одну и ту же частоту, поэтому идут в фазе и разъезжаются ровно на те
 * доли цикла, что заложены в спектр.
 */
function bankVoice(ctx: AudioContext, bank: number, into: AudioNode): OscillatorNode {
  const pulses = pulseSource(ctx, exhaustOrders(bankFirings(bank)));
  let tail: AudioNode = pulses;
  pipeModes(bank).forEach((hz, mode) => {
    const bell = ctx.createBiquadFilter();
    bell.type = "peaking";
    bell.frequency.value = hz;
    bell.Q.value = PIPE_Q[mode] ?? 4;
    bell.gain.value = PIPE_DB[mode] ?? 4;
    tail = tail.connect(bell);
  });
  for (const hz of PIPE_SPREAD) {
    const spread = ctx.createBiquadFilter();
    spread.type = "allpass";
    spread.frequency.value = hz;
    spread.Q.value = 1;
    tail = tail.connect(spread);
  }
  for (const hz of MUFFLER.stages) {
    const chamber = ctx.createBiquadFilter();
    chamber.type = "lowpass";
    chamber.frequency.value = hz;
    chamber.Q.value = MUFFLER.q;
    tail = tail.connect(chamber);
  }

  const travel = ctx.createDelay(0.05);
  travel.delayTime.value = pipeDelay(bank);
  const side = ctx.createStereoPanner();
  side.pan.value = PIPE_PAN[bank] ?? 0;
  const level = ctx.createGain();
  level.gain.value = (PIPE_SHARE[bank] ?? 0.5) * MUFFLER.loss;
  tail.connect(travel).connect(side).connect(level).connect(into);
  pulses.start();
  return pulses;
}

/**
 * Впуск: все восемь тактов в один ресивер и наружу через заслонку.
 *
 * Устроен как ряд выпуска, только проще: ресивер один, поэтому ни разносить по
 * бортам, ни задерживать нечего, а вместо глушителя стоит воздушный фильтр.
 * Возвращает и осциллятор, и ручку громкости: этот голос запирается заслонкой,
 * а не глохнет вместе со всем мотором.
 */
function intakeVoice(ctx: AudioContext, into: AudioNode): { pulses: OscillatorNode; level: GainNode } {
  const pulses = pulseSource(ctx, exhaustOrders(intakeFirings()));
  let tail: AudioNode = pulses;
  intakeModes().forEach((hz, mode) => {
    const bell = ctx.createBiquadFilter();
    bell.type = "peaking";
    bell.frequency.value = hz;
    bell.Q.value = INTAKE_Q[mode] ?? 3;
    bell.gain.value = INTAKE_DB[mode] ?? 3;
    tail = tail.connect(bell);
  });
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = INTAKE_CUT;
  filter.Q.value = 0.7;
  const level = ctx.createGain();
  level.gain.value = 0;
  tail.connect(filter).connect(level).connect(into);
  pulses.start();
  return { pulses, level };
}

/**
 * Звук заезда. Возвращает `null`, если Web Audio в этом окружении нет: молчание
 * — не повод ронять сцену.
 */
export function createRaceAudio(muted = false): RaceAudio | null {
  const Ctor = contextCtor();
  if (!Ctor) return null;

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }

  const master = ctx.createGain();
  master.gain.value = muted ? 0 : 1;
  // Салон: последнее звено на пути к уху, и оно общее для всех голосов. Мода
  // объёма подпевает низу, закон массы снимает середину и верх, обивка добирает
  // остаток (см. `CABIN`).
  const boom = ctx.createBiquadFilter();
  boom.type = "peaking";
  boom.frequency.value = CABIN.boom.hz;
  boom.Q.value = CABIN.boom.q;
  boom.gain.value = CABIN.boom.db;
  let cabin: AudioNode = master.connect(boom);
  for (const step of CABIN.mass) {
    const shelf = ctx.createBiquadFilter();
    shelf.type = "highshelf";
    shelf.frequency.value = step.hz;
    shelf.gain.value = step.db;
    cabin = cabin.connect(shelf);
  }
  const soak = ctx.createBiquadFilter();
  soak.type = "lowpass";
  soak.frequency.value = CABIN.soak;
  soak.Q.value = 0.7;
  const makeup = ctx.createGain();
  makeup.gain.value = CABIN.makeup;
  cabin.connect(soak).connect(makeup).connect(ctx.destination);

  const noise = noiseBuffer(ctx);

  // Мотор: два ряда вспышек, каждый через свою трубу, и общий срез по нагрузке.
  const engineCut = ctx.createBiquadFilter();
  engineCut.type = "lowpass";
  engineCut.frequency.value = 500;
  engineCut.Q.value = 0.8;
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  engineCut.connect(engineGain).connect(master);
  // Все голоса, привязанные к коленвалу: два ряда выпуска и общий впуск. Частота
  // у них обязана быть одна и та же, иначе разъедутся фазы, на которых держится
  // и рокот выпуска, и совпадение впуска с выхлопом.
  const crank: OscillatorNode[] = [];
  for (let bank = 0; bank < EXHAUST_BANKS; bank++) crank.push(bankVoice(ctx, bank, engineCut));

  // Впуск идёт мимо среза мотора: заслонка запирает его сама, и глушить его ещё
  // раз по нагрузке значило бы посчитать одну и ту же заслонку дважды.
  const intake = intakeVoice(ctx, master);
  crank.push(intake.pulses);

  // Дыхание: поток газа в трубе. Идёт до среза, чтобы сброс газа глушил и его.
  const breath = noiseSource(ctx, noise);
  const breathCut = ctx.createBiquadFilter();
  breathCut.type = "bandpass";
  breathCut.frequency.value = BREATH_HZ;
  breathCut.Q.value = BREATH_Q;
  // И пыхает в такт вспышкам: громкость шума качается той же огибающей, что и
  // выпуск левого ряда, — порция газа уходит в трубу вместе с открытием клапана.
  const puff = ctx.createGain();
  puff.gain.value = 1 - BREATH_PULSE;
  const gust = pulseSource(ctx, exhaustOrders(bankFirings(0), BREATH_ORDERS));
  const depth = ctx.createGain();
  depth.gain.value = BREATH_PULSE;
  gust.connect(depth).connect(puff.gain);
  gust.start();
  crank.push(gust);
  const breathGain = ctx.createGain();
  breathGain.gain.value = 0;
  breath.connect(breathCut).connect(puff).connect(breathGain).connect(engineCut);

  // Качение: шум под фильтром. Покрытие слышно срезом, скорость — громкостью.
  const roll = noiseSource(ctx, noise);
  const rollCut = ctx.createBiquadFilter();
  rollCut.type = "lowpass";
  rollCut.frequency.value = 2000;
  rollCut.Q.value = 0.7;
  const rollGain = ctx.createGain();
  rollGain.gain.value = 0;
  roll.connect(rollCut).connect(rollGain).connect(master);

  // Визг: тот же шум, но через узкую полосу — резонанс сорванного пятна.
  const squeal = noiseSource(ctx, noise);
  const squealCut = ctx.createBiquadFilter();
  squealCut.type = "bandpass";
  squealCut.frequency.value = 900;
  squealCut.Q.value = SQUEAL_Q;
  const squealUp = ctx.createBiquadFilter();
  squealUp.type = "bandpass";
  squealUp.frequency.value = 900 * SQUEAL_UP;
  squealUp.Q.value = SQUEAL_Q;
  const squealUpGain = ctx.createGain();
  squealUpGain.gain.value = SQUEAL_UP_GAIN;
  const squealGain = ctx.createGain();
  squealGain.gain.value = 0;
  squeal.connect(squealCut).connect(squealGain);
  squeal.connect(squealUp).connect(squealUpGain).connect(squealGain);
  squealGain.connect(master);

  // Ветер: тот же шум, но в полосе. Снизу отрезано гудение кузова, сверху —
  // шипение, которого в закрытом салоне не слышно (см. `WIND_BAND`).
  const wind = noiseSource(ctx, noise);
  const windFrom = ctx.createBiquadFilter();
  windFrom.type = "highpass";
  windFrom.frequency.value = WIND_BAND.from;
  const windTo = ctx.createBiquadFilter();
  windTo.type = "lowpass";
  windTo.frequency.value = WIND_BAND.to;
  windTo.Q.value = 0.7;
  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  wind.connect(windFrom).connect(windTo).connect(windGain).connect(master);

  let mix: SoundMix = SILENCE;
  let off = muted;
  let dead = false;

  /**
   * Браузер не даёт звучать до первого действия человека, и на старте контекст
   * приходит остановленным. Будить его каждый кадр дешевле, чем городить
   * подписку на события: `resume` на уже работающем контексте ничего не стоит.
   */
  function wake(): void {
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  }

  /**
   * Параметры ставятся не прямо, а коротким скольжением. Смесь уже сглажена по
   * кадрам, но кадр — это шестнадцать миллисекунд, и ступенька такой длины на
   * громкости слышна щелчком. `setTargetAtTime` растягивает её по сэмплам.
   */
  const glide = (param: AudioParam, value: number): void => {
    param.setTargetAtTime(value, ctx.currentTime, 0.008);
  };

  return {
    update(input: SoundIn, dtS: number): void {
      if (dead) return;
      mix = easeSound(mix, soundMix(input), dtS);
      if (off) return;
      wake();
      // Все голоса коленвала получают одно и то же число: они идут в такт.
      for (const voice of crank) glide(voice.frequency, Math.max(1, mix.cycleHz));
      glide(engineCut.frequency, mix.engineCut);
      glide(engineGain.gain, mix.engineGain);
      glide(breathGain.gain, mix.breathGain);
      glide(intake.level.gain, mix.intakeGain);
      glide(rollCut.frequency, mix.rollCut);
      glide(rollGain.gain, mix.rollGain);
      glide(squealCut.frequency, mix.squealHz);
      glide(squealUp.frequency, mix.squealHz * SQUEAL_UP);
      glide(squealGain.gain, mix.squealGain);
      glide(windGain.gain, mix.windGain);
    },
    setMuted(next: boolean): void {
      off = next;
      if (dead) return;
      // Выключение — это тишина на мастере, а не остановка узлов: остановленный
      // осциллятор Web Audio не запускается заново, его пришлось бы пересобирать.
      glide(master.gain, next ? 0 : 1);
      if (!next) wake();
    },
    muted: () => off,
    probe: () => ({ context: ctx.state, mix }),
    dispose(): void {
      if (dead) return;
      dead = true;
      for (const source of [...crank, breath, roll, squeal, wind]) {
        try {
          source.stop();
        } catch {
          // Узел мог не успеть запуститься: молчание — уже нужный итог.
        }
      }
      void ctx.close().catch(() => undefined);
    },
  };
}
