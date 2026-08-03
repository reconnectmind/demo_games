import type { Microgame, PackageRef } from "./contracts.js";
import { validateManifest, type ValidationReport } from "./validation.js";

/**
 * Реестр адресуется парой id + version, а не одним id: протокол закрепляет
 * конкретную версию, и начатая сессия никогда не переезжает на новую.
 */
export class GameRegistry {
  private byKey = new Map<string, Microgame<never, never>>();
  private latest = new Map<string, string>();

  register(game: Microgame<any, any>): void {
    const report = validateManifest(game.manifest);
    if (!report.ok) {
      throw new Error(
        `Манифест ${game.manifest.id} не проходит схему: ${report.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const key = `${game.manifest.id}@${game.manifest.version}`;
    this.byKey.set(key, game as Microgame<never, never>);
    const known = this.latest.get(game.manifest.id);
    if (!known || compareVersions(game.manifest.version, known) > 0) {
      this.latest.set(game.manifest.id, game.manifest.version);
    }
  }

  resolve(ref: PackageRef | string): Microgame<any, any> {
    const id = typeof ref === "string" ? ref : ref.id;
    const version = typeof ref === "string" ? this.latest.get(id) : ref.version;
    if (!version) throw new Error(`Игра не зарегистрирована: ${id}`);
    const game = this.byKey.get(`${id}@${version}`);
    if (!game) throw new Error(`Версия не зарегистрирована: ${id}@${version}`);
    return game;
  }

  has(ref: PackageRef | string): boolean {
    try {
      this.resolve(ref);
      return true;
    } catch {
      return false;
    }
  }

  ref(id: string): PackageRef {
    const version = this.latest.get(id);
    if (!version) throw new Error(`Игра не зарегистрирована: ${id}`);
    return { id, version };
  }

  list(): Microgame<any, any>[] {
    return [...this.latest.entries()].map(([id, version]) => this.resolve({ id, version }));
  }

  validateAll(): Array<{ id: string; report: ValidationReport }> {
    return this.list().map((g) => ({ id: g.manifest.id, report: validateManifest(g.manifest) }));
  }
}

/**
 * Подготовить модули заранее. Витрина и протокол зовут это на старте: пока человек
 * читает список игр, физика заезда успевает догрузиться, и запуск не ждёт сети.
 * Ошибку подготовки глотать нельзя молча, но и валить приложение из-за одной игры
 * тоже: остальные должны работать.
 */
export async function prepareGames(games: Iterable<Microgame<any, any>>): Promise<void> {
  await Promise.all(
    [...games].map(async (game) => {
      try {
        await game.prepare?.();
      } catch (error) {
        console.warn(`Модуль ${game.manifest.id} не подготовился`, error);
      }
    }),
  );
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
