use crate::lsl::{LslService, MarkerReceipt};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const DEFAULT_PROTOCOL: &str =
    include_str!("../../../../packages/protocol/examples/reconnect-pilot.json");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolFile {
    pub file_name: String,
    pub content: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInfo {
    pub portable_root: String,
    pub writable: bool,
    pub storage_error: Option<String>,
    pub protocols: Vec<ProtocolFile>,
    pub interrupted_sessions: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStart {
    pub participant_id: String,
    pub protocol_id: String,
    pub protocol_title: String,
    pub protocol_json: Value,
    pub app_version: String,
    pub seed: u64,
    pub order: Vec<String>,
    pub input: Value,
    pub theme: String,
    pub pace: String,
    pub game_versions: BTreeMap<String, String>,
    pub codebook_version: String,
    pub codebook: BTreeMap<String, i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub token: String,
    pub directory: String,
    pub source_id: String,
}

#[derive(Debug, Serialize)]
struct MarkerRow<'a> {
    seq: u64,
    code: i32,
    label: &'a str,
    t_ms: f64,
    wall_ms: f64,
    sent: u8,
    sink_time_s: Option<f64>,
    error: Option<&'a str>,
}

pub struct SessionWriter {
    token: String,
    directory: PathBuf,
    events: File,
    markers: csv::Writer<File>,
    manifest: Value,
    codebook: BTreeMap<String, i32>,
    last_seq: u64,
    event_count: u64,
    marker_count: u64,
    pending: usize,
}

impl SessionWriter {
    pub fn start(
        root: &Path,
        request: SessionStart,
        source_id: String,
    ) -> Result<(Self, SessionInfo), String> {
        let token = Uuid::new_v4().to_string();
        let stamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ").to_string();
        let participant = safe_component(&request.participant_id);
        let protocol_id = safe_component(&request.protocol_id);
        let directory = root
            .join("data")
            .join(&participant)
            .join(format!("{stamp}_{protocol_id}_{token}"));
        fs::create_dir_all(&directory).map_err(io_error("создать папку сессии"))?;

        let protocol_text = serde_json::to_string_pretty(&request.protocol_json)
            .map_err(|error| error.to_string())?;
        write_atomic(&directory.join("protocol.json"), protocol_text.as_bytes())?;
        let protocol_hash = hex_sha256(protocol_text.as_bytes());

        let events_path = directory.join("events.jsonl");
        let events = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&events_path)
            .map_err(io_error("создать events.jsonl"))?;
        let marker_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(directory.join("markers.csv"))
            .map_err(io_error("создать markers.csv"))?;
        let markers = csv::WriterBuilder::new()
            .has_headers(true)
            .from_writer(marker_file);

        write_codebook(
            &directory.join("codebook.csv"),
            &request.codebook_version,
            &request.codebook,
        )?;

        let started_at = Utc::now().to_rfc3339();
        let manifest = json!({
            "schemaVersion": "1.0",
            "status": "running",
            "sessionUuid": token,
            "participantId": request.participant_id,
            "protocolId": request.protocol_id,
            "protocolTitle": request.protocol_title,
            "protocolSha256": protocol_hash,
            "appVersion": request.app_version,
            "seed": request.seed,
            "compiledOrder": request.order,
            "input": request.input,
            "theme": request.theme,
            "pace": request.pace,
            "gameVersions": request.game_versions,
            "runtimeVersion": env!("CARGO_PKG_VERSION"),
            "protocolVersion": request.protocol_json.get("protocolVersion").cloned().unwrap_or(Value::Null),
            "startedAt": started_at,
            "endedAt": Value::Null,
            "lastSeq": 0,
            "events": 0,
            "markers": 0,
            "codebookVersion": request.codebook_version,
            "lsl": {
                "name": "Reconnect Markers",
                "type": "Markers",
                "sourceId": source_id,
                "channelFormat": "int32",
                "nominalRate": 0
            }
        });
        write_json_atomic(&directory.join("session.json"), &manifest)?;

        let info = SessionInfo {
            token: token.clone(),
            directory: directory.display().to_string(),
            source_id,
        };
        Ok((
            Self {
                token,
                directory,
                events,
                markers,
                manifest,
                codebook: request.codebook,
                last_seq: 0,
                event_count: 0,
                marker_count: 0,
                pending: 0,
            },
            info,
        ))
    }

    pub fn append(&mut self, token: &str, event: &Value, lsl: &LslService) -> Result<(), String> {
        self.check_token(token)?;
        let seq = event
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or_else(|| "event.seq отсутствует".to_string())?;
        if seq <= self.last_seq {
            return Err(format!(
                "нарушен порядок журнала: seq {seq} после {}",
                self.last_seq
            ));
        }
        let line = serde_json::to_vec(event).map_err(|error| error.to_string())?;
        self.events
            .write_all(&line)
            .and_then(|_| self.events.write_all(b"\n"))
            .map_err(io_error("дописать events.jsonl"))?;
        self.last_seq = seq;
        self.event_count += 1;
        self.pending += 1;

        let label = event.get("type").and_then(Value::as_str).unwrap_or("");
        let mut marker_error = None;
        let marker = if let Some(code) = self.codebook.get(label).copied() {
            let receipt = lsl.publish(code);
            self.write_marker(event, code, label, &receipt)?;
            if !receipt.sent {
                marker_error = Some(
                    receipt
                        .error
                        .unwrap_or_else(|| "LSL не подтвердил отправку".into()),
                );
            }
            true
        } else {
            false
        };
        if marker || label.ends_with(".end") || self.pending >= 20 {
            self.flush()?;
        }
        marker_error
            .map(|error| Err(format!("LSL marker {label} не отправлен: {error}")))
            .unwrap_or(Ok(()))
    }

    fn write_marker(
        &mut self,
        event: &Value,
        code: i32,
        label: &str,
        receipt: &MarkerReceipt,
    ) -> Result<(), String> {
        self.markers
            .serialize(MarkerRow {
                seq: self.last_seq,
                code,
                label,
                t_ms: event.get("tMs").and_then(Value::as_f64).unwrap_or(0.0),
                wall_ms: event.get("wallMs").and_then(Value::as_f64).unwrap_or(0.0),
                sent: u8::from(receipt.sent),
                sink_time_s: receipt.sink_time_s,
                error: receipt.error.as_deref(),
            })
            .map_err(|error| format!("дописать markers.csv: {error}"))?;
        self.marker_count += 1;
        Ok(())
    }

    pub fn flush(&mut self) -> Result<(), String> {
        self.events
            .flush()
            .and_then(|_| self.events.sync_data())
            .map_err(io_error("синхронизировать events.jsonl"))?;
        self.markers
            .flush()
            .map_err(|error| format!("синхронизировать markers.csv: {error}"))?;
        self.markers
            .get_ref()
            .sync_data()
            .map_err(io_error("синхронизировать markers.csv"))?;
        self.pending = 0;
        self.manifest["lastSeq"] = json!(self.last_seq);
        self.manifest["events"] = json!(self.event_count);
        self.manifest["markers"] = json!(self.marker_count);
        write_json_atomic(&self.directory.join("session.json"), &self.manifest)
    }

    pub fn flush_for(&mut self, token: &str) -> Result<(), String> {
        self.check_token(token)?;
        self.flush()
    }

    pub fn finish(&mut self, token: &str, status: &str, summary: Value) -> Result<PathBuf, String> {
        self.check_token(token)?;
        self.flush()?;
        write_json_atomic(&self.directory.join("summary.json"), &summary)?;
        generate_events_csv(&self.directory)?;
        self.manifest["status"] = json!(status);
        self.manifest["endedAt"] = json!(Utc::now().to_rfc3339());
        self.manifest["lastSeq"] = json!(self.last_seq);
        write_json_atomic(&self.directory.join("session.json"), &self.manifest)?;
        Ok(self.directory.clone())
    }

    pub fn abort(mut self) -> Result<PathBuf, String> {
        self.flush()?;
        generate_events_csv(&self.directory)?;
        self.manifest["status"] = json!("aborted");
        self.manifest["endedAt"] = json!(Utc::now().to_rfc3339());
        write_json_atomic(&self.directory.join("session.json"), &self.manifest)?;
        Ok(self.directory)
    }

    fn check_token(&self, token: &str) -> Result<(), String> {
        if self.token == token {
            Ok(())
        } else {
            Err("сессия не совпадает с активной".into())
        }
    }
}

pub fn portable_root() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("RECONNECT_PORTABLE_ROOT") {
        return Ok(PathBuf::from(root));
    }
    if cfg!(debug_assertions) {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has parent")
            .join("portable"));
    }
    std::env::current_exe()
        .map_err(io_error("определить путь executable"))
        .and_then(|path| portable_root_for_executable(&path))
}

fn portable_root_for_executable(executable: &Path) -> Result<PathBuf, String> {
    let binary_directory = executable
        .parent()
        .ok_or_else(|| "у executable нет родительской папки".to_string())?;
    let contents = binary_directory.parent();
    let app_bundle = contents.and_then(Path::parent);
    if binary_directory.file_name().and_then(|name| name.to_str()) == Some("MacOS")
        && contents
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("Contents")
        && app_bundle
            .and_then(Path::extension)
            .and_then(|extension| extension.to_str())
            == Some("app")
    {
        return app_bundle
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .ok_or_else(|| "у app bundle нет родительской папки".to_string());
    }
    Ok(binary_directory.to_path_buf())
}

pub fn append_diagnostic(
    root: &Path,
    level: &str,
    source: &str,
    message: &str,
    details: Option<&str>,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(io_error("создать portable-root для диагностики"))?;
    let record = json!({
        "timestamp": Utc::now().to_rfc3339(),
        "level": level,
        "source": source,
        "message": message,
        "details": details,
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("diagnostics.jsonl"))
        .map_err(io_error("открыть diagnostics.jsonl"))?;
    serde_json::to_writer(&mut file, &record).map_err(|error| error.to_string())?;
    file.write_all(b"\n")
        .map_err(io_error("дописать diagnostics.jsonl"))?;
    file.sync_data()
        .map_err(io_error("синхронизировать diagnostics.jsonl"))
}

pub fn bootstrap(root: &Path) -> BootstrapInfo {
    let result = prepare_root(root);
    let interrupted_sessions = mark_interrupted_sessions(&root.join("data")).unwrap_or(0);
    let protocols = read_protocols(&root.join("protocols")).unwrap_or_else(|error| {
        vec![ProtocolFile {
            file_name: String::new(),
            content: String::new(),
            error: Some(error),
        }]
    });
    BootstrapInfo {
        portable_root: root.display().to_string(),
        writable: result.is_ok(),
        storage_error: result.err(),
        protocols,
        interrupted_sessions,
    }
}

pub fn save_protocol(root: &Path, file_name: &str, content: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(content).map_err(|error| format!("протокол не JSON: {error}"))?;
    let name = protocol_file_name(file_name);
    write_atomic(&root.join("protocols").join(name), content.as_bytes())
}

pub fn delete_protocol(root: &Path, file_name: &str) -> Result<(), String> {
    let name = protocol_file_name(file_name);
    if name == "reconnect-pilot.json" {
        return Err("базовый протокол удалять нельзя".into());
    }
    fs::remove_file(root.join("protocols").join(name)).map_err(io_error("удалить протокол"))
}

pub fn read_session_file(directory: &Path, name: &str) -> Result<String, String> {
    const ALLOWED: &[&str] = &[
        "events.jsonl",
        "events.csv",
        "markers.csv",
        "codebook.csv",
        "protocol.json",
        "session.json",
        "summary.json",
    ];
    if !ALLOWED.contains(&name) {
        return Err("этот файл нельзя читать через renderer".into());
    }
    fs::read_to_string(directory.join(name)).map_err(io_error("прочитать файл сессии"))
}

fn prepare_root(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("protocols")).map_err(io_error("создать protocols"))?;
    fs::create_dir_all(root.join("data")).map_err(io_error("создать data"))?;
    let default = root.join("protocols").join("reconnect-pilot.json");
    if !default.exists() {
        write_atomic(&default, DEFAULT_PROTOCOL.as_bytes())?;
    }
    let probe = root.join(".write-probe");
    let mut file = File::create(&probe).map_err(io_error("проверить запись рядом с executable"))?;
    file.write_all(b"ok")
        .and_then(|_| file.sync_all())
        .map_err(io_error("синхронизировать portable-root"))?;
    drop(file);
    match fs::remove_file(probe) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error("убрать проверочный файл")(
            error,
        )),
    }
}

fn read_protocols(directory: &Path) -> Result<Vec<ProtocolFile>, String> {
    let mut entries = fs::read_dir(directory)
        .map_err(io_error("прочитать protocols"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries
        .into_iter()
        .map(|entry| {
            let file_name = entry.file_name().to_string_lossy().to_string();
            match fs::read_to_string(entry.path()) {
                Ok(content) => ProtocolFile {
                    error: serde_json::from_str::<Value>(&content)
                        .err()
                        .map(|error| error.to_string()),
                    file_name,
                    content,
                },
                Err(error) => ProtocolFile {
                    file_name,
                    content: String::new(),
                    error: Some(error.to_string()),
                },
            }
        })
        .collect())
}

fn mark_interrupted_sessions(directory: &Path) -> Result<usize, String> {
    if !directory.exists() {
        return Ok(0);
    }
    let mut changed = 0;
    for entry in fs::read_dir(directory).map_err(io_error("прочитать data"))? {
        let path = entry.map_err(io_error("прочитать data entry"))?.path();
        if path.is_dir() {
            changed += mark_interrupted_sessions(&path)?;
            continue;
        }
        if path.file_name().and_then(|x| x.to_str()) != Some("session.json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut manifest) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        if manifest.get("status").and_then(Value::as_str) == Some("running") {
            manifest["status"] = json!("interrupted");
            manifest["endedAt"] = json!(Utc::now().to_rfc3339());
            write_json_atomic(&path, &manifest)?;
            changed += 1;
        }
    }
    Ok(changed)
}

fn generate_events_csv(directory: &Path) -> Result<(), String> {
    let input = File::open(directory.join("events.jsonl")).map_err(io_error("прочитать журнал"))?;
    let output =
        File::create(directory.join("events.csv")).map_err(io_error("создать events.csv"))?;
    let mut csv = csv::Writer::from_writer(output);
    csv.write_record([
        "seq",
        "run_id",
        "section_id",
        "run_index",
        "slot",
        "t_ms",
        "wall_ms",
        "source",
        "type",
        "payload",
    ])
    .map_err(|error| error.to_string())?;
    for line in BufReader::new(input).lines() {
        let line = line.map_err(io_error("прочитать строку журнала"))?;
        let value: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        csv.write_record([
            value["seq"].to_string(),
            value["runId"].as_str().unwrap_or("").to_string(),
            value["sectionId"].as_str().unwrap_or("").to_string(),
            value
                .get("runIndex")
                .map(Value::to_string)
                .unwrap_or_default(),
            value["slot"].as_str().unwrap_or("").to_string(),
            value["tMs"].to_string(),
            value["wallMs"].to_string(),
            value["source"].as_str().unwrap_or("").to_string(),
            value["type"].as_str().unwrap_or("").to_string(),
            value["payload"].to_string(),
        ])
        .map_err(|error| error.to_string())?;
    }
    csv.flush().map_err(|error| error.to_string())?;
    csv.get_ref()
        .sync_all()
        .map_err(io_error("синхронизировать events.csv"))
}

fn write_codebook(
    path: &Path,
    version: &str,
    codebook: &BTreeMap<String, i32>,
) -> Result<(), String> {
    let file = File::create(path).map_err(io_error("создать codebook.csv"))?;
    let mut csv = csv::Writer::from_writer(file);
    csv.write_record(["version", "code", "label"])
        .map_err(|error| error.to_string())?;
    for (label, code) in codebook {
        csv.write_record([version, &code.to_string(), label])
            .map_err(|error| error.to_string())?;
    }
    csv.flush().map_err(|error| error.to_string())?;
    csv.get_ref()
        .sync_all()
        .map_err(io_error("синхронизировать codebook.csv"))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    write_atomic(path, &content)
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    {
        let mut file = File::create(&temp).map_err(io_error("создать временный файл"))?;
        file.write_all(content)
            .and_then(|_| file.sync_all())
            .map_err(io_error("записать временный файл"))?;
    }
    replace_atomic(&temp, path)
}

#[cfg(not(target_os = "windows"))]
fn replace_atomic(temp: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temp, destination).map_err(io_error("атомарно переименовать файл"))
}

#[cfg(target_os = "windows")]
fn replace_atomic(temp: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from = temp
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let to = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(format!(
            "атомарно переименовать файл: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn protocol_file_name(value: &str) -> String {
    let base = value.trim_end_matches(".json");
    format!("{}.json", safe_component(base))
}

fn safe_component(value: &str) -> String {
    let clean = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    clean
        .trim_matches('_')
        .to_string()
        .chars()
        .take(80)
        .collect()
}

fn hex_sha256(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn io_error(action: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{action}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn bootstrap_creates_portable_layout_and_default_protocol() {
        let dir = tempdir().unwrap();
        let info = bootstrap(dir.path());
        assert!(info.writable, "{:?}", info.storage_error);
        assert!(dir.path().join("protocols/reconnect-pilot.json").exists());
        assert!(dir.path().join("data").is_dir());
        assert!(info
            .protocols
            .iter()
            .any(|p| p.file_name == "reconnect-pilot.json"));
    }

    #[test]
    fn mac_app_uses_directory_beside_bundle_as_portable_root() {
        let executable =
            Path::new("/lab/Reconnect Experiment.app/Contents/MacOS/reconnect-experiment");
        assert_eq!(
            portable_root_for_executable(executable).unwrap(),
            Path::new("/lab")
        );
        assert_eq!(
            portable_root_for_executable(Path::new("/lab/reconnect-experiment.exe")).unwrap(),
            Path::new("/lab")
        );
    }

    #[test]
    fn diagnostics_are_appended_as_durable_json_lines() {
        let dir = tempdir().unwrap();
        append_diagnostic(
            dir.path(),
            "error",
            "renderer.startup",
            "boom",
            Some("stack"),
        )
        .unwrap();
        append_diagnostic(dir.path(), "info", "app", "started", None).unwrap();
        let lines = fs::read_to_string(dir.path().join("diagnostics.jsonl")).unwrap();
        let records = lines
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["source"], "renderer.startup");
        assert_eq!(records[1]["message"], "started");
    }

    #[test]
    fn protocol_names_cannot_escape_portable_root() {
        assert_eq!(protocol_file_name("../../evil.json"), "evil.json");
    }

    #[test]
    fn completed_session_has_immutable_inputs_and_final_exports() {
        let dir = tempdir().unwrap();
        let request = SessionStart {
            participant_id: "p-001".into(),
            protocol_id: "pilot".into(),
            protocol_title: "Pilot".into(),
            protocol_json: json!({"protocolVersion": "1.0", "id": "pilot"}),
            app_version: "test".into(),
            seed: 7,
            order: vec!["baseline".into()],
            input: json!({"keys": ["KeyQ", "KeyW", "KeyE"]}),
            theme: "low-contrast".into(),
            pace: "full".into(),
            game_versions: BTreeMap::new(),
            codebook_version: "1.0.0".into(),
            codebook: BTreeMap::from([("section.start".into(), 1)]),
        };
        let (mut writer, info) =
            SessionWriter::start(dir.path(), request, "test-source".into()).unwrap();
        let session_dir = writer
            .finish(&info.token, "completed", json!({"runs": 0}))
            .unwrap();
        for name in [
            "protocol.json",
            "session.json",
            "events.jsonl",
            "events.csv",
            "markers.csv",
            "codebook.csv",
            "summary.json",
        ] {
            assert!(session_dir.join(name).exists(), "{name}");
        }
        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(session_dir.join("session.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["status"], "completed");
        assert_eq!(manifest["lsl"]["sourceId"], "test-source");
    }
}
