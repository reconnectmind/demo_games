# Reconnect Experiment desktop

Tauri 2 host for the Reconnect protocol. The renderer is the existing
`apps/showcase` build; games do not depend on Tauri.

## macOS development

Prerequisites: Node 22, current stable Rust, CMake, and Xcode command-line tools.

```bash
npm ci
npm run experiment:dev
```

Dev mode keeps the Scenario, Constructor, and Module Debug tabs. Its portable
root is `apps/experiment/portable/`; protocols are read from `protocols/` and
sessions are written to `data/`.

Run verification:

```bash
npm run typecheck
npm test
npm run experiment:test
npm run experiment:build
```

The first Rust build compiles and statically links the official liblsl source,
so it takes longer than subsequent builds.

The application bundle is copied to
`apps/experiment/build/macos/Reconnect Experiment.app`; writable `protocols/`
and `data/` directories live beside it. This local macOS build keeps Scenario,
Constructor, and Module Debug available; LabRecorder confirmation is advisory,
while the native LSL self-test remains required before starting a session.

## Windows artifact

Windows x64 can be cross-compiled locally on macOS:

```bash
npm run experiment:build:windows
```

The script installs missing Homebrew build tools and `cargo-xwin`, then writes
the portable directory and ZIP to `apps/experiment/build/`. macOS cannot run
the resulting PE executable, so the packaged self-test still runs in the
Windows CI workflow.

Run the **Reconnect experiment Windows portable** workflow and download
`Reconnect-Experiment-<version>-windows-x64`. Unzip the artifact before
launching `Reconnect Experiment.exe`.

The portable directory contains:

- the executable;
- pinned fixed WebView2 x64 runtime;
- `protocols/reconnect-pilot.json`;
- writable `data/`;
- `README.txt` for the operator.

Windows and macOS expose the same Scenario, Constructor, and Module Debug tabs.
The constructor can save protocols directly into the portable `protocols/`
repository or load a JSON exported by the website. On Windows, Start remains
blocked until the portable root is writable, the selected protocol compiles,
native LSL outlet→inlet self-test passes, and the operator confirms that
LabRecorder sees the working stream.

## Laboratory preflight

1. Copy the entire unzipped directory to a local writable disk.
2. Start LabRecorder.
3. Launch the executable and choose participant, protocol, pace, and theme.
4. Click **Проверить LSL**.
5. Confirm that `Reconnect Markers` with the shown `source_id` appears in
   LabRecorder, then tick the confirmation.
6. Review the compiled section order and start the session.
7. After completion, verify the displayed session path and
   `session.json` status `completed`.

The backend creates `data/<participant>/<UTC>_<protocol>_<uuid>/` before the
first stimulus. It continuously appends `events.jsonl` and `markers.csv`; final
exports do not depend on pressing a download button. Rust panics, renderer
failures, and rejected desktop IPC calls are appended to `diagnostics.jsonl`
beside the application.
