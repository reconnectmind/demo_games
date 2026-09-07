import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const source = resolve(
  app,
  `src-tauri/target/release/reconnect-experiment${windows ? ".exe" : ""}`,
);
const platformDirectory = windows ? "windows-native" : "macos";
const output = resolve(
  app,
  `build/${platformDirectory}/Reconnect Experiment${windows ? ".exe" : ""}`,
);

await rm(resolve(app, `build/${platformDirectory}`), { recursive: true, force: true });
await mkdir(dirname(output), { recursive: true });
await copyFile(source, output);
await chmod(output, 0o755);

console.log(output);
