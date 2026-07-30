import type { Rng, RngState } from "./contracts.js";

/**
 * Чистые операции над состоянием PRNG. Ядро игры не может держать объект
 * с мутирующим состоянием, поэтому носит RngState прямо в CoreState.
 */
export function createRngState(seed: number): RngState {
  return new SeededRng(seed).save();
}

export function rngNext(state: RngState): [number, RngState] {
  const rng = new SeededRng(1);
  rng.load(state);
  const value = rng.next();
  return [value, rng.save()];
}

export function rngInt(state: RngState, min: number, max: number): [number, RngState] {
  const [value, next] = rngNext(state);
  return [min + Math.floor(value * (max - min + 1)), next];
}

export function rngPick<T>(state: RngState, items: readonly T[]): [T, RngState] {
  const [index, next] = rngInt(state, 0, items.length - 1);
  return [items[index] as T, next];
}

export function rngShuffle<T>(state: RngState, items: readonly T[]): [T[], RngState] {
  const out = [...items];
  let s = state;
  for (let i = out.length - 1; i > 0; i--) {
    const [j, next] = rngInt(s, 0, i);
    s = next;
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return [out, s];
}

/**
 * sfc32: быстрый PRNG с состоянием из четырёх 32-битных слов. Состояние
 * сериализуемо целиком, поэтому checkpoint восстанавливает ту же последовательность.
 */
export class SeededRng implements Rng {
  private s: RngState;

  constructor(seed: number) {
    let h = 2166136261 >>> 0;
    const mix = (n: number) => {
      h ^= n;
      h = Math.imul(h, 16777619) >>> 0;
      return h;
    };
    this.s = {
      a: mix(seed) || 1,
      b: mix(seed ^ 0x9e3779b9) || 2,
      c: mix(seed ^ 0x85ebca6b) || 3,
      d: mix(seed ^ 0xc2b2ae35) || 4,
    };
    for (let i = 0; i < 12; i++) this.next();
  }

  next(): number {
    const s = this.s;
    const t = (s.a + s.b) >>> 0;
    s.a = s.b ^ (s.b >>> 9);
    s.b = (s.c + (s.c << 3)) >>> 0;
    s.c = ((s.c << 21) | (s.c >>> 11)) >>> 0;
    s.c = (s.c + t) >>> 0;
    s.d = (s.d + 0x9e3779b9) >>> 0;
    return ((t + s.d) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("rng.pick: пустой список");
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }

  save(): RngState {
    return { ...this.s };
  }

  load(state: RngState): void {
    this.s = { ...state };
  }
}
