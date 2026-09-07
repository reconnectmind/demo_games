import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(app, "../..");
const source = resolve(app, "src-tauri/target/release/bundle/macos/Reconnect Experiment.app");
const outputDirectory = resolve(app, "build/macos");
const output = resolve(outputDirectory, "Reconnect Experiment.app");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(resolve(outputDirectory, "protocols"), { recursive: true });
await mkdir(resolve(outputDirectory, "data"), { recursive: true });
await cp(source, output, { recursive: true });
await cp(
  resolve(root, "packages/protocol/examples/reconnect-pilot.json"),
  resolve(outputDirectory, "protocols/reconnect-pilot.json"),
);

console.log(output);
