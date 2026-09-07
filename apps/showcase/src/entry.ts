function reportRendererError(error: unknown, source: string): void {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  void invoke("report_error", {
    source,
    message,
    stack,
  }).catch(() => undefined);
}

function showStartupError(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  const app = document.getElementById("app") ?? document.body;
  app.innerHTML = "";
  const panel = document.createElement("pre");
  panel.id = "startupError";
  panel.textContent = `Не удалось запустить Reconnect Experiment.\n\n${message}`;
  panel.style.cssText =
    "box-sizing:border-box;margin:32px;padding:24px;white-space:pre-wrap;color:#ffd7d7;" +
    "background:#321b1b;border:1px solid #a64c4c;border-radius:12px;font:15px/1.5 ui-monospace,monospace;";
  app.append(panel);
  reportRendererError(error, "renderer.startup");
  console.error(error);
}

let started = false;

function reportRuntimeError(error: unknown): void {
  reportRendererError(error, "renderer.runtime");
  console.error(error);
}

window.addEventListener("error", (event) => {
  const error = event.error ?? event.message;
  if (started) reportRuntimeError(error);
  else showStartupError(error);
});
window.addEventListener("unhandledrejection", (event) => {
  if (started) reportRuntimeError(event.reason);
  else showStartupError(event.reason);
});

void import("./main.js")
  .then(() => {
    started = true;
  })
  .catch(showStartupError);
