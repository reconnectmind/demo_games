use lsl::{ChannelFormat, ExPushable, Pullable, StreamInfo, StreamInlet, StreamOutlet};
use serde::Serialize;
use std::{
    sync::mpsc::{self, Sender},
    thread,
    time::Duration,
};
use uuid::Uuid;

const STREAM_NAME: &str = "Reconnect Markers";
const STREAM_TYPE: &str = "Markers";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LslStatus {
    pub ok: bool,
    pub message: String,
    pub stream_name: String,
    pub stream_type: String,
    pub source_id: String,
    pub has_consumers: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerReceipt {
    pub sent: bool,
    pub sink_time_s: Option<f64>,
    pub error: Option<String>,
}

enum Command {
    Prepare {
        source_id: String,
        reply: Sender<Result<LslStatus, String>>,
    },
    SelfTest {
        reply: Sender<Result<LslStatus, String>>,
    },
    Status {
        reply: Sender<Result<LslStatus, String>>,
    },
    Publish {
        code: i32,
        reply: Sender<MarkerReceipt>,
    },
    Close,
}

struct Worker {
    outlet: Option<StreamOutlet>,
    source_id: String,
}

impl Worker {
    fn status(&self, message: impl Into<String>) -> LslStatus {
        LslStatus {
            ok: self.outlet.is_some(),
            message: message.into(),
            stream_name: STREAM_NAME.into(),
            stream_type: STREAM_TYPE.into(),
            source_id: self.source_id.clone(),
            has_consumers: self
                .outlet
                .as_ref()
                .map(StreamOutlet::have_consumers)
                .unwrap_or(false),
        }
    }

    fn prepare(&mut self, source_id: String) -> Result<LslStatus, String> {
        let info = StreamInfo::new(
            STREAM_NAME,
            STREAM_TYPE,
            1,
            lsl::IRREGULAR_RATE,
            ChannelFormat::Int32,
            &source_id,
        )
        .map_err(|error| format!("не удалось описать LSL stream: {error}"))?;
        let outlet = StreamOutlet::new(&info, 0, 360)
            .map_err(|error| format!("не удалось открыть LSL outlet: {error}"))?;
        self.source_id = source_id;
        self.outlet = Some(outlet);
        Ok(self.status("LSL outlet готов; подтвердите видимость в LabRecorder"))
    }

    fn publish(&self, code: i32) -> MarkerReceipt {
        let Some(outlet) = &self.outlet else {
            return MarkerReceipt {
                sent: false,
                sink_time_s: None,
                error: Some("LSL outlet не подготовлен".into()),
            };
        };
        let timestamp = lsl::local_clock();
        match outlet.push_sample_ex(&vec![code], timestamp, true) {
            Ok(()) => MarkerReceipt {
                sent: true,
                sink_time_s: Some(timestamp),
                error: None,
            },
            Err(error) => MarkerReceipt {
                sent: false,
                sink_time_s: Some(timestamp),
                error: Some(error.to_string()),
            },
        }
    }

    fn self_test(&self) -> Result<LslStatus, String> {
        let source_id = format!("reconnect-self-test-{}", Uuid::new_v4());
        let info = StreamInfo::new(
            "Reconnect Self Test",
            "MarkersSelfTest",
            1,
            lsl::IRREGULAR_RATE,
            ChannelFormat::Int32,
            &source_id,
        )
        .map_err(|error| error.to_string())?;
        let outlet = StreamOutlet::new(&info, 0, 32).map_err(|error| error.to_string())?;
        let resolved = lsl::resolve_byprop("source_id", &source_id, 1, 3.0)
            .map_err(|error| format!("self-test discovery: {error}"))?;
        let found = resolved
            .first()
            .ok_or_else(|| "self-test outlet не найден локальным inlet".to_string())?;
        let inlet = StreamInlet::new(found, 8, 1, false)
            .map_err(|error| format!("self-test inlet: {error}"))?;
        inlet
            .open_stream(3.0)
            .map_err(|error| format!("self-test connect: {error}"))?;
        thread::sleep(Duration::from_millis(100));
        let sent_at = lsl::local_clock();
        outlet
            .push_sample_ex(&vec![424_242_i32], sent_at, true)
            .map_err(|error| format!("self-test publish: {error}"))?;
        let (sample, received_at): (Vec<i32>, f64) = inlet
            .pull_sample(3.0)
            .map_err(|error| format!("self-test receive: {error}"))?;
        if sample != [424_242] || received_at == 0.0 {
            return Err(format!(
                "self-test получил неверный sample: {sample:?}, timestamp={received_at}"
            ));
        }
        Ok(LslStatus {
            ok: true,
            message: "LSL outlet → inlet self-test пройден".into(),
            stream_name: STREAM_NAME.into(),
            stream_type: STREAM_TYPE.into(),
            source_id: self.source_id.clone(),
            has_consumers: self
                .outlet
                .as_ref()
                .map(StreamOutlet::have_consumers)
                .unwrap_or(false),
        })
    }
}

pub struct LslService {
    tx: Sender<Command>,
}

impl LslService {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("reconnect-lsl".into())
            .spawn(move || {
                let mut worker = Worker {
                    outlet: None,
                    source_id: String::new(),
                };
                while let Ok(command) = rx.recv() {
                    match command {
                        Command::Prepare { source_id, reply } => {
                            let _ = reply.send(worker.prepare(source_id));
                        }
                        Command::SelfTest { reply } => {
                            let _ = reply.send(worker.self_test());
                        }
                        Command::Status { reply } => {
                            let _ = reply.send(Ok(worker.status("LSL outlet готов")));
                        }
                        Command::Publish { code, reply } => {
                            let _ = reply.send(worker.publish(code));
                        }
                        Command::Close => break,
                    }
                }
            })
            .expect("failed to start LSL worker");
        Self { tx }
    }

    fn request<T>(&self, command: impl FnOnce(Sender<T>) -> Command) -> Result<T, String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(command(reply_tx))
            .map_err(|_| "LSL worker остановлен".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "LSL worker не вернул ответ".to_string())
    }

    pub fn prepare(&self, source_id: String) -> Result<LslStatus, String> {
        self.request(|reply| Command::Prepare { source_id, reply })?
    }

    pub fn self_test(&self) -> Result<LslStatus, String> {
        self.request(|reply| Command::SelfTest { reply })?
    }

    pub fn status(&self) -> Result<LslStatus, String> {
        self.request(|reply| Command::Status { reply })?
    }

    pub fn publish(&self, code: i32) -> MarkerReceipt {
        self.request(|reply| Command::Publish { code, reply })
            .unwrap_or_else(|error| MarkerReceipt {
                sent: false,
                sink_time_s: None,
                error: Some(error),
            })
    }
}

impl Drop for LslService {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Close);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_lsl_loopback_delivers_exact_marker() {
        let service = LslService::new();
        let status = service.self_test().expect("LSL loopback failed");
        assert!(status.ok);
    }
}
