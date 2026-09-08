use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::{effective_remote_settings, lease::effective_heartbeat_timeout_seconds};
use crate::{lock_ext::MutexExt, state::AppState};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SNAPSHOT_MAX_AGE: Duration = Duration::from_secs(15);
#[path = "device_settings_schema.rs"]
mod schema;
use schema::{prepare, SCHEMA};

pub(crate) fn context(state: &AppState) -> Result<Value, String> {
    let settings = effective_remote_settings(state)?;
    let control = state
        .remote_control
        .lock_or_err()
        .map_err(|e| e.to_string())?;
    Ok(context_for(
        &control,
        Duration::from_secs(effective_heartbeat_timeout_seconds(&settings)),
    ))
}

fn context_for(control: &super::lease::RemoteControlState, timeout: Duration) -> Value {
    let uncertain = control.transitioning
        || control
            .lease
            .as_ref()
            .is_some_and(|lease| lease.last_heartbeat.elapsed() >= timeout);
    let scope = if uncertain {
        None
    } else if control.lease.is_some() {
        Some("remoteDevice")
    } else {
        Some("pc")
    };
    let device = control
        .lease
        .as_ref()
        .filter(|_| !uncertain)
        .and_then(|lease| control.device_settings.current(&lease.lease_id).ok());
    json!({
        "defaultScope": scope, "source": "currentHumanControlOwner", "ownerEpoch": control.owner_epoch,
        "targetReady": scope == Some("pc") || device.is_some(),
        "clientId": device.map(|report| &report.client_id),
        "scopes": {
            "pc": {"tools":"describe_settings/get_settings/validate_settings/update_settings", "description":"PC 앱·터미널 설정"},
            "remoteDevice": {"tools":"describe_remote_settings/get_remote_settings/validate_remote_settings/update_remote_settings", "description":"현재 Remote 표면의 기기 로컬 표시·플로팅·입력 설정"},
            "hostRemote": {"tools":"describe_settings/get_settings/validate_settings/update_settings", "path":"/remote", "description":"PC의 Remote 연결·공개·보안 정책. Remote에서 요청해도 이 범위"}
        },
        "guide": "설정 작업 첫 단계와 변경 직전에 이 맥락을 조회하세요. 사용자가 대상을 명시하면 그 대상이 우선합니다. 대상을 생략한 글자·스크롤·입력 요청은 defaultScope를 따르세요. 연결·보안 정책은 표면과 관계없이 hostRemote입니다. defaultScope=null은 제어권 전환·만료로 미확정입니다. targetReady=false인 Remote를 PC로 대체하지 마세요. 프로세스가 PC/localhost에서 실행된다는 사실로 PC 요청이라고 판단하지 마세요. 현재 제어 표면을 나타내며 채팅 메시지 출처를 증명하지는 않습니다. 백그라운드 자동화·다른 채팅 출처가 명백하면 이 기본값을 맹신하지 말고 대상을 확인하세요."
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeviceReport {
    client_id: String,
    revision: String,
    settings: Value,
    result: Option<DeviceResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceResult {
    request_id: String,
    success: bool,
    error: Option<String>,
}

#[derive(Debug)]
struct Snapshot {
    lease_id: String,
    report: DeviceReport,
    observed_at: Instant,
}

#[derive(Debug)]
struct Pending {
    id: String,
    lease_id: String,
    client_id: String,
    expected_revision: String,
    patch: Value,
    candidate: Value,
    deadline: Instant,
    reply: oneshot::Sender<Result<Value, String>>,
}

/// Volatile relay only. The device remains the owner of its localStorage values.
#[derive(Debug, Default)]
pub(crate) struct DeviceSettingsBridge {
    snapshot: Option<Snapshot>,
    pending: Option<Pending>,
}

pub(crate) fn describe() -> Value {
    json!({
        "scope": "remoteDevice", "schema": *SCHEMA,
        "guide": "먼저 get_settings_context로 현재 사용 표면과 대상을 확인하세요. 현재 Remote 표면의 기기 로컬 환경설정입니다. PC settings.remote는 연결·보안 정책으로 별개입니다. get_remote_settings로 clientId·revision·현재 값을 읽고 validate_remote_settings로 최상위 키별 patch(그 안의 객체·배열은 전체 교체)를 검증한 뒤 update_remote_settings에 client_id와 expected_revision을 함께 보내세요. 예: {terminalFontSize:20,touchScrollSensitivity:2}. 현재보다 두 배는 현재 값 × 2입니다. 설정은 기기에만 저장하며 다른 기기와 공유하지 않습니다. 연결이 없으면 Remote 화면에서 연결·제어권 획득 후 재시도하세요. 적용 확인에는 heartbeat 왕복이 필요합니다. snapshotMaxKib는 다음 attach, 나머지는 즉시 적용됩니다. 플로팅 전체 표시·개별 패드·일반 버튼, 입력바 행 배치·사용자 키, 에이전트별 숨김 줄 수, 탐색 제외도 지원합니다. actionCatalog로 액션을 찾고 배열 변경 시 다른 항목을 보존하세요. 사용자 키는 설정된 단축 입력이며 저장만으로 실행하지 않습니다. 입력 초안·과거 입력 내용·인증정보는 노출하지 않습니다. 제외 항목과 이유는 schema.excluded에 있습니다."
    })
}

impl DeviceSettingsBridge {
    pub(super) fn sync(
        &mut self,
        lease_id: &str,
        report: DeviceReport,
    ) -> Result<Option<Value>, String> {
        if !(16..=64).contains(&report.client_id.len())
            || !report
                .client_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || report.revision.len() > 128
            || report.revision.is_empty()
            || report.settings.as_object().map(|v| v.len())
                != SCHEMA["properties"].as_object().map(|v| v.len())
        {
            return Err("Remote 설정 snapshot 형식이 올바르지 않습니다.".into());
        }
        prepare(&json!({}), &report.settings)?;
        let now = Instant::now();
        if let Some(pending) = self.pending.as_ref() {
            let wrong_client =
                pending.lease_id != lease_id || pending.client_id != report.client_id;
            let completed = report
                .result
                .as_ref()
                .is_some_and(|result| result.request_id == pending.id);
            if wrong_client || now >= pending.deadline || completed || pending.reply.is_closed() {
                if let Some(pending) = self.pending.take() {
                    let reply = if wrong_client {
                        Err("Remote 대상 기기가 바뀌었습니다. 최신 기기를 조회하세요.".into())
                    } else if now >= pending.deadline {
                        Err("Remote 적용 확인 시간이 만료됐습니다. 실제 값은 재조회하세요.".into())
                    } else if let Some(result) = report
                        .result
                        .as_ref()
                        .filter(|r| r.request_id == pending.id)
                    {
                        if result.success && report.settings == pending.candidate {
                            Ok(
                                json!({"applied":true,"scope":"remoteDevice","clientId":report.client_id,
                                "revision":report.revision,"settings":report.settings}),
                            )
                        } else {
                            Err(result
                                .error
                                .as_deref()
                                .unwrap_or("Remote 기기가 요청한 설정 적용을 확인하지 못했습니다.")
                                .chars()
                                .take(512)
                                .collect())
                        }
                    } else {
                        Err("Remote 설정 요청이 취소됐습니다.".into())
                    };
                    let _ = pending.reply.send(reply);
                }
            }
        }
        self.snapshot = Some(Snapshot {
            lease_id: lease_id.into(),
            report,
            observed_at: now,
        });
        Ok(self.pending.as_ref().map(|pending| {
            json!({
                "requestId":pending.id, "leaseId":pending.lease_id, "clientId":pending.client_id,
                "expectedRevision":pending.expected_revision, "patch":pending.patch,
                "validForMs":pending.deadline.saturating_duration_since(now).as_millis(),
            })
        }))
    }

    fn current(&self, lease_id: &str) -> Result<&DeviceReport, String> {
        self.snapshot.as_ref().filter(|snapshot| snapshot.lease_id == lease_id
            && snapshot.observed_at.elapsed() < SNAPSHOT_MAX_AGE)
            .map(|snapshot| &snapshot.report)
            .ok_or_else(|| "현재 Remote 기기의 설정 snapshot이 없습니다. 최신 Remote 페이지로 연결하고 heartbeat를 기다리세요.".into())
    }
}

fn with_current<R>(
    state: &AppState,
    operation: impl FnOnce(&mut DeviceSettingsBridge, &str) -> Result<R, String>,
) -> Result<R, String> {
    let settings = effective_remote_settings(state)?;
    let timeout = Duration::from_secs(effective_heartbeat_timeout_seconds(&settings));
    let mut control = state
        .remote_control
        .lock_or_err()
        .map_err(|e| e.to_string())?;
    let lease = control
        .lease
        .as_ref()
        .filter(|lease| !control.transitioning && lease.last_heartbeat.elapsed() < timeout)
        .ok_or(
            "연결된 Remote controller가 없습니다. 대상 기기에서 연결·제어권 획득 후 재시도하세요.",
        )?;
    let lease_id = lease.lease_id.clone();
    operation(&mut control.device_settings, &lease_id)
}

pub(crate) fn get(state: &AppState) -> Result<Value, String> {
    with_current(state, |bridge, lease| {
        let report = bridge.current(lease)?;
        Ok(json!({"scope":"remoteDevice", "clientId":report.client_id,
            "revision":report.revision, "settings":report.settings}))
    })
}

pub(crate) fn validate(state: &AppState, patch: &Value) -> Result<Value, String> {
    with_current(state, |bridge, lease| {
        let current = bridge.current(lease)?;
        match prepare(&current.settings, patch) {
            Ok(candidate) => Ok(json!({"valid":true,"clientId":current.client_id,
                "currentRevision":current.revision,"settings":candidate})),
            Err(error) => Ok(json!({"valid":false,"errors":[error]})),
        }
    })
}

pub(crate) async fn update(
    state: &AppState,
    client_id: &str,
    expected_revision: &str,
    patch: &Value,
) -> Result<Value, String> {
    let receiver = with_current(state, |bridge, lease| {
        let current = bridge.current(lease)?;
        if current.client_id != client_id || current.revision != expected_revision {
            return Err(
                "Remote 대상 또는 revision 충돌입니다. get_remote_settings 후 재시도하세요.".into(),
            );
        }
        let candidate = prepare(&current.settings, patch)?;
        if bridge
            .pending
            .as_ref()
            .is_some_and(|p| p.deadline > Instant::now() && !p.reply.is_closed())
        {
            return Err("다른 Remote 설정 변경을 적용 중입니다. 완료 후 재시도하세요.".into());
        }
        let (reply, receiver) = oneshot::channel();
        bridge.pending = Some(Pending {
            id: uuid::Uuid::new_v4().to_string(),
            lease_id: lease.into(),
            client_id: client_id.into(),
            expected_revision: expected_revision.into(),
            patch: patch.clone(),
            candidate,
            deadline: Instant::now() + REQUEST_TIMEOUT,
            reply,
        });
        Ok(receiver)
    })?;
    tokio::time::timeout(REQUEST_TIMEOUT, receiver)
        .await
        .map_err(|_| {
            "Remote 적용 확인 시간 초과입니다. 성공 여부는 get_remote_settings로 재조회하세요."
                .to_string()
        })?
        .map_err(|_| {
            "Remote 연결 또는 설정 요청이 종료됐습니다. 최신 값을 조회하세요.".to_string()
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_context_follows_human_control_not_the_agents_host_os() {
        use super::super::lease::{RemoteControlLease, RemoteControlState};
        let mut control = RemoteControlState::default();
        let timeout = Duration::from_secs(45);
        assert_eq!(context_for(&control, timeout)["defaultScope"], "pc");
        control.transitioning = true;
        assert!(context_for(&control, timeout)["defaultScope"].is_null());
        control.transitioning = false;
        control.lease = Some(RemoteControlLease {
            lease_id: "lease".into(),
            remote_addr: "127.0.0.1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        });
        assert_eq!(
            context_for(&control, timeout)["defaultScope"],
            "remoteDevice"
        );
        assert_eq!(context_for(&control, timeout)["targetReady"], false);
        let device = report();
        let client_id = device.client_id.clone();
        control.device_settings.sync("lease", device).unwrap();
        assert_eq!(context_for(&control, timeout)["clientId"], client_id);
        assert_eq!(context_for(&control, timeout)["targetReady"], true);
        control
            .device_settings
            .snapshot
            .as_mut()
            .unwrap()
            .observed_at -= SNAPSHOT_MAX_AGE;
        assert_eq!(
            context_for(&control, timeout)["defaultScope"],
            "remoteDevice"
        );
        assert_eq!(context_for(&control, timeout)["targetReady"], false);
        control.lease.as_mut().unwrap().last_heartbeat -= timeout;
        assert!(context_for(&control, timeout)["defaultScope"].is_null());
    }
    fn report() -> DeviceReport {
        DeviceReport {
            client_id: uuid::Uuid::new_v4().to_string(),
            revision: "revision-1".into(),
            result: None,
            settings: Value::Object(
                SCHEMA["properties"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, field)| (key.clone(), field["default"].clone()))
                    .collect(),
            ),
        }
    }
    #[test]
    fn device_schema_validates_all_defaults_and_rejects_invalid_writes() {
        let current = report();
        assert!(prepare(&json!({}), &current.settings).is_ok());
        for patch in [
            json!({"terminalFontSize":99}),
            json!({"terminalFontSize":"18"}),
            json!({"authToken":"secret"}),
            json!({"composerIdleOpacity":100}),
        ] {
            assert!(prepare(&current.settings, &patch).is_err());
        }
        let changed = prepare(&current.settings, &json!({"terminalFontSize":18})).unwrap();
        assert_eq!(changed["composerFontSize"], 16);
    }
    #[test]
    fn snapshots_are_bound_to_the_controller_and_expire() {
        let mut bridge = DeviceSettingsBridge::default();
        let mut device = report();
        // Existing Remote pages normalize every custom key with a submit flag.
        device.settings["inputBarUserKeys"] = json!([
            {"id":"u-one", "label":"Tab", "seq":"\t", "submit":false},
            {"id":"u-two", "label":"Run", "seq":"echo ok", "submit":true}
        ]);
        bridge.sync("lease-1", device).unwrap();
        assert!(bridge.current("lease-1").is_ok());
        assert!(bridge.current("lease-2").is_err());
        bridge.snapshot.as_mut().unwrap().observed_at -= SNAPSHOT_MAX_AGE;
        assert!(bridge.current("lease-1").is_err());
    }

    #[tokio::test]
    async fn only_the_target_devices_matching_applied_snapshot_completes_a_write() {
        for outcome in [
            "success",
            "storage-error",
            "other-device",
            "expired",
            "mismatched-values",
        ] {
            let mut bridge = DeviceSettingsBridge::default();
            let mut device = report();
            let patch = json!({"terminalFontSize":20});
            let candidate = prepare(&device.settings, &patch).unwrap();
            let (reply, receiver) = oneshot::channel();
            bridge.pending = Some(Pending {
                id: "request".into(),
                lease_id: "lease".into(),
                client_id: device.client_id.clone(),
                expected_revision: device.revision.clone(),
                patch,
                candidate: candidate.clone(),
                deadline: Instant::now() + REQUEST_TIMEOUT,
                reply,
            });
            if outcome == "other-device" {
                device.client_id = uuid::Uuid::new_v4().to_string();
            }
            if outcome == "expired" {
                bridge.pending.as_mut().unwrap().deadline = Instant::now();
            }
            device.result = Some(DeviceResult {
                request_id: "request".into(),
                success: outcome != "storage-error",
                error: Some("storage unavailable".into()),
            });
            if outcome == "success" {
                device.settings = candidate;
                device.revision = "revision-2".into();
            }
            assert!(bridge.sync("lease", device).unwrap().is_none());
            let result = receiver.await.unwrap();
            assert_eq!(
                result.is_ok(),
                outcome == "success",
                "{outcome}: {result:?}"
            );
            if let Ok(value) = result {
                assert_eq!(value["settings"]["terminalFontSize"], 20);
            }
        }
    }
}
