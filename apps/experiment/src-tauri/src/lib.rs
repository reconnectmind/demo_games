mod lsl;
mod storage;

#[cfg(all(
    target_os = "windows",
    not(debug_assertions),
    not(feature = "custom-protocol")
))]
compile_error!("Windows release must be built with --features custom-protocol");

use lsl::{LslService, LslStatus};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use storage::{BootstrapInfo, SessionInfo, SessionStart, SessionWriter};
use tauri::{Manager, State};
use uuid::Uuid;

struct AppState {
    root: PathBuf,
    lsl: LslService,
    session: Mutex<Option<SessionWriter>>,
    last_directory: Mutex<Option<PathBuf>>,
}

fn locked<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "внутренняя блокировка повреждена".into())
}

fn abort_with_diagnostics(root: &std::path::Path, writer: SessionWriter) {
    if let Err(error) = writer.abort() {
        let _ = storage::append_diagnostic(root, "error", "session.abort", &error, None);
    }
}

#[tauri::command]
fn report_error(
    state: State<'_, AppState>,
    source: String,
    message: String,
    stack: Option<String>,
) -> Result<(), String> {
    storage::append_diagnostic(&state.root, "error", &source, &message, stack.as_deref())
}

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> BootstrapInfo {
    storage::bootstrap(&state.root)
}

#[tauri::command]
fn save_protocol(
    state: State<'_, AppState>,
    file_name: String,
    content: String,
) -> Result<(), String> {
    storage::save_protocol(&state.root, &file_name, &content)
}

#[tauri::command]
fn delete_protocol(state: State<'_, AppState>, file_name: String) -> Result<(), String> {
    storage::delete_protocol(&state.root, &file_name)
}

#[tauri::command]
fn lsl_preflight(
    state: State<'_, AppState>,
    participant_id: String,
    protocol_id: String,
) -> Result<LslStatus, String> {
    state.lsl.self_test()?;
    let source_id = format!(
        "reconnect-{}-{}-{}",
        participant_id,
        protocol_id,
        Uuid::new_v4()
    );
    state.lsl.prepare(source_id)
}

#[tauri::command]
fn lsl_status(state: State<'_, AppState>) -> Result<LslStatus, String> {
    state.lsl.status()
}

#[tauri::command]
fn start_session(state: State<'_, AppState>, request: SessionStart) -> Result<SessionInfo, String> {
    let status = state.lsl.status()?;
    if !status.ok || status.source_id.is_empty() {
        return Err("сначала выполните LSL self-test".into());
    }
    let mut slot = locked(&state.session)?;
    if slot.is_some() {
        return Err("сессия уже активна".into());
    }
    let (writer, info) = SessionWriter::start(&state.root, request, status.source_id.clone())?;
    *locked(&state.last_directory)? = Some(PathBuf::from(&info.directory));
    *slot = Some(writer);
    Ok(info)
}

#[tauri::command]
fn append_event(state: State<'_, AppState>, token: String, event: Value) -> Result<(), String> {
    let mut slot = locked(&state.session)?;
    let writer = slot
        .as_mut()
        .ok_or_else(|| "нет активной сессии".to_string())?;
    writer.append(&token, &event, &state.lsl)
}

#[tauri::command]
fn flush_session(state: State<'_, AppState>, token: String) -> Result<(), String> {
    let mut slot = locked(&state.session)?;
    let writer = slot
        .as_mut()
        .ok_or_else(|| "нет активной сессии".to_string())?;
    // Token validation happens through a zero-cost explicit session check in append/finish.
    // A flush from a stale renderer must not touch the current run.
    writer.flush_for(&token)
}

#[tauri::command]
fn finish_session(
    state: State<'_, AppState>,
    token: String,
    status: String,
    summary: Value,
) -> Result<String, String> {
    let mut slot = locked(&state.session)?;
    let writer = slot
        .as_mut()
        .ok_or_else(|| "нет активной сессии".to_string())?;
    let directory = writer.finish(&token, &status, summary)?;
    slot.take();
    *locked(&state.last_directory)? = Some(directory.clone());
    Ok(directory.display().to_string())
}

#[tauri::command]
fn abort_session(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let Some(writer) = locked(&state.session)?.take() else {
        return Ok(None);
    };
    let directory = writer.abort()?;
    *locked(&state.last_directory)? = Some(directory.clone());
    Ok(Some(directory.display().to_string()))
}

#[tauri::command]
fn read_session_file(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let directory = locked(&state.last_directory)?
        .clone()
        .ok_or_else(|| "ещё нет папки сессии".to_string())?;
    storage::read_session_file(&directory, &name)
}

#[tauri::command]
fn open_session_folder(state: State<'_, AppState>) -> Result<(), String> {
    let directory = locked(&state.last_directory)?
        .clone()
        .ok_or_else(|| "ещё нет папки сессии".to_string())?;
    open_folder(&directory)
}

#[cfg(target_os = "windows")]
fn open_folder(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("открыть папку: {error}"))
}

#[cfg(target_os = "macos")]
fn open_folder(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("открыть папку: {error}"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn open_folder(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("открыть папку: {error}"))
}

pub fn run() {
    let root = storage::portable_root().expect("failed to determine portable root");
    let panic_root = root.clone();
    let previous_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        let _ = storage::append_diagnostic(
            &panic_root,
            "fatal",
            "rust.panic",
            &panic.to_string(),
            Some(&format!("{panic:?}")),
        );
        previous_panic_hook(panic);
    }));
    let _ = storage::append_diagnostic(
        &root,
        "info",
        "app.lifecycle",
        "Reconnect Experiment started",
        Some(env!("CARGO_PKG_VERSION")),
    );
    #[cfg(target_os = "windows")]
    {
        let fixed_runtime = root.join("webview2");
        let root_check = storage::bootstrap(&root);
        if !root_check.writable || !fixed_runtime.is_dir() {
            let reason = root_check.storage_error.unwrap_or_else(|| {
                format!(
                    "Не найден fixed WebView2 runtime: {}",
                    fixed_runtime.display()
                )
            });
            let _ = storage::append_diagnostic(&root, "fatal", "windows.preflight", &reason, None);
            windows_blocking_error(&format!(
                "Reconnect Experiment не может запуститься.\n\n{reason}\n\n\
                 Распакуйте ZIP целиком в папку, доступную для записи."
            ));
            std::process::exit(2);
        }
        let _ = storage::append_diagnostic(
            &root,
            "info",
            "windows.preflight",
            "Portable root and WebView2 runtime are available",
            None,
        );
        let _ = storage::append_diagnostic(
            &root,
            "info",
            "windows.webview-acl",
            "Checking AppContainer access",
            None,
        );
        if let Err(error) = ensure_webview_acl(&fixed_runtime) {
            let _ = storage::append_diagnostic(&root, "fatal", "windows.webview-acl", &error, None);
            windows_blocking_error(&error);
            std::process::exit(2);
        }
        let _ = storage::append_diagnostic(
            &root,
            "info",
            "windows.webview-acl",
            "AppContainer access is ready",
            None,
        );
        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", fixed_runtime);
    }
    let page_root = root.clone();
    let app = tauri::Builder::default()
        .on_page_load(move |_webview, payload| {
            let _ = storage::append_diagnostic(
                &page_root,
                "info",
                "renderer.page-load",
                &format!("Page load {:?}", payload.event()),
                Some(payload.url().as_str()),
            );
        })
        .manage(AppState {
            root,
            lsl: LslService::new(),
            session: Mutex::new(None),
            last_directory: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            report_error,
            bootstrap,
            save_protocol,
            delete_protocol,
            lsl_preflight,
            lsl_status,
            start_session,
            append_event,
            flush_session,
            finish_session,
            abort_session,
            read_session_file,
            open_session_folder
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Reconnect Experiment");
    let _ = storage::append_diagnostic(
        &app.state::<AppState>().root,
        "info",
        "app.lifecycle",
        "Native window created",
        None,
    );

    app.run(|handle, event| match event {
        tauri::RunEvent::Ready => {
            let state = handle.state::<AppState>();
            let _ = storage::append_diagnostic(
                &state.root,
                "info",
                "app.lifecycle",
                "Event loop ready",
                None,
            );
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api: close_api, .. },
            ..
        } => {
            let state = handle.state::<AppState>();
            let active = state
                .session
                .lock()
                .map(|session| session.is_some())
                .unwrap_or(false);
            #[cfg(not(target_os = "windows"))]
            let _ = &close_api;
            #[cfg(target_os = "windows")]
            if active && !windows_confirm_abort() {
                close_api.prevent_close();
                return;
            }
            if active {
                if let Ok(mut session) = state.session.lock() {
                    if let Some(writer) = session.take() {
                        abort_with_diagnostics(&state.root, writer);
                    }
                };
            }
        }
        tauri::RunEvent::ExitRequested { .. } => {
            let state = handle.state::<AppState>();
            if let Ok(mut session) = state.session.lock() {
                if let Some(writer) = session.take() {
                    abort_with_diagnostics(&state.root, writer);
                }
            };
        }
        _ => {}
    });
}

pub fn portable_self_test() -> Result<(), String> {
    let root = storage::portable_root()?;
    let boot = storage::bootstrap(&root);
    if !boot.writable {
        return Err(boot
            .storage_error
            .unwrap_or_else(|| "portable-root недоступен".into()));
    }
    let lsl = LslService::new();
    lsl.self_test()?;
    let source_id = format!("reconnect-packaged-smoke-{}", Uuid::new_v4());
    lsl.prepare(source_id.clone())?;
    let request = SessionStart {
        participant_id: "_packaged-smoke".into(),
        protocol_id: "smoke".into(),
        protocol_title: "Packaged smoke test".into(),
        protocol_json: serde_json::json!({"protocolVersion": "1.0", "id": "smoke"}),
        app_version: env!("CARGO_PKG_VERSION").into(),
        seed: 1,
        order: vec!["smoke".into()],
        input: serde_json::json!({"keys": ["KeyQ", "KeyW", "KeyE"]}),
        theme: "low-contrast".into(),
        pace: "smoke".into(),
        game_versions: BTreeMap::new(),
        codebook_version: "1.0.0".into(),
        codebook: BTreeMap::from([("section.start".into(), 1)]),
    };
    let (mut writer, info) = SessionWriter::start(&root, request, source_id)?;
    writer.append(
        &info.token,
        &serde_json::json!({
            "seq": 1,
            "runId": "packaged-smoke",
            "sectionId": "smoke",
            "runIndex": 0,
            "tMs": 0.0,
            "wallMs": chrono::Utc::now().timestamp_millis() as f64,
            "source": "runtime",
            "type": "section.start",
            "payload": {"section": "smoke"}
        }),
        &lsl,
    )?;
    writer.finish(
        &info.token,
        "completed",
        serde_json::json!({"packagedSmoke": true}),
    )?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_blocking_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let body = message.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let title = "Reconnect Experiment"
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(target_os = "windows")]
fn windows_confirm_abort() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_YESNO,
    };
    let body = "Сессия ещё записывается. Закрыть окно и сохранить её как aborted?"
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let title = "Reconnect Experiment"
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING,
        ) == IDYES
    }
}

#[cfg(target_os = "windows")]
fn ensure_webview_acl(runtime: &std::path::Path) -> Result<(), String> {
    let stamp = runtime.join(".appcontainer-acl-ok");
    if stamp.exists() {
        return Ok(());
    }
    let output = std::process::Command::new("icacls")
        .arg(runtime)
        .args([
            "/grant",
            "*S-1-15-2-2:(OI)(CI)(RX)",
            "*S-1-15-2-1:(OI)(CI)(RX)",
            "/Q",
        ])
        .output()
        .map_err(|error| format!("не удалось запустить icacls для WebView2: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Не удалось дать WebView2 runtime права AppContainer (icacls: {}). {}\n\
             Переместите portable-папку в каталог, которым владеет текущий пользователь.",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    std::fs::write(&stamp, b"ok")
        .map_err(|error| format!("не удалось записать отметку ACL WebView2: {error}"))
}
