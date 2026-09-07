import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extractedPackages = [
  "car",
  "env",
  "race",
  "elemental",
  "elemental-state",
  "elements",
  "elements-vision",
  "flora",
  "vision",
];
const forbiddenImports =
  /@gamespace\/(?:car|env|race|elemental(?:-state)?|elements(?:-vision)?|flora|vision)(?:\/|["'])/;

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry)) files.push(path);
  }
  return files;
}

describe("webdemo project boundary", () => {
  it("contains only the microgame platform packages", () => {
    for (const name of extractedPackages) {
      expect(existsSync(resolve(root, "packages", name))).toBe(false);
    }
    expect(existsSync(resolve(root, "apps/grasp"))).toBe(false);
    expect(existsSync(resolve(root, "apps/elements"))).toBe(false);
    expect(existsSync(resolve(root, "apps/elements-mobile"))).toBe(false);
  });

  it("does not depend on extracted game projects", () => {
    const packageJson = readFileSync(resolve(root, "package.json"), "utf8");
    expect(packageJson).not.toMatch(forbiddenImports);

    const production = [
      ...sourceFiles(resolve(root, "packages")),
      ...sourceFiles(resolve(root, "apps")),
    ];
    const offenders = production.filter((path) =>
      forbiddenImports.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
