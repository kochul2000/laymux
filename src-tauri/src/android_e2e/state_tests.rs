use super::super::crypto::{decrypt_response, encrypt_request};
use super::*;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use zeroize::Zeroizing;

fn request() -> ChallengeRequest {
    ChallengeRequest {
        version: 1,
        instance_id: "desktop-7".into(),
        pairing_id: URL_SAFE_NO_PAD.encode([1_u8; 16]),
        client_nonce: URL_SAFE_NO_PAD.encode([2_u8; 16]),
        client_session_nonce: URL_SAFE_NO_PAD.encode([3_u8; 16]),
    }
}

fn material() -> ConfirmedPairingMaterial {
    ConfirmedPairingMaterial {
        seed: Zeroizing::new(vec![7_u8; 32]),
        revision: crate::android_pairing::pairing_revision(),
    }
}

#[test]
fn current_request_context_commit_serializes_against_session_clear() {
    let e2e = Arc::new(AndroidE2eState::default());
    let context = e2e.install_test_request_context("desktop-7", "session-a", u64::MAX);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let commit_e2e = Arc::clone(&e2e);
    let commit = thread::spawn(move || {
        commit_e2e
            .with_current_request_context(&context, 1_000, || {
                entered_tx.send(()).expect("signal commit entry");
                release_rx.recv().expect("release commit");
                7_u8
            })
            .expect("registry lock")
    });
    entered_rx.recv().expect("commit entered");

    let (clear_started_tx, clear_started_rx) = mpsc::channel();
    let (clear_done_tx, clear_done_rx) = mpsc::channel();
    let clear_e2e = Arc::clone(&e2e);
    let clear = thread::spawn(move || {
        clear_started_tx.send(()).expect("signal clear start");
        clear_e2e.clear().expect("clear sessions");
        clear_done_tx.send(()).expect("signal clear completion");
    });
    clear_started_rx.recv().expect("clear started");
    assert!(clear_done_rx
        .recv_timeout(Duration::from_millis(50))
        .is_err());

    release_tx.send(()).expect("finish commit");
    assert_eq!(commit.join().expect("commit thread"), Some(7));
    clear_done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("clear follows commit");
    clear.join().expect("clear thread");
}

#[tokio::test]
async fn output_stream_nonce_can_only_be_used_once_per_session() {
    let keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let session = AndroidE2eSession {
        instance_id: "desktop-7".into(),
        session_id: URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES]),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(1_060),
        revoked: AtomicBool::new(false),
        next_sequence_floor: AtomicU64::new(0),
        state: AsyncMutex::new(SessionState {
            keys,
            used_output_nonces: HashSet::new(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    };
    let nonce = URL_SAFE_NO_PAD.encode([5_u8; OUTPUT_STREAM_NONCE_BYTES]);

    assert!(session.open_output_cipher(&nonce, 1_000).await.is_ok());
    assert!(matches!(
        session.open_output_cipher(&nonce, 1_000).await,
        Err(E2eError::Invalid)
    ));
    assert!(!session.is_revoked());
}

#[tokio::test]
async fn output_stream_nonce_limit_revokes_session_for_rollover() {
    let keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let session = AndroidE2eSession {
        instance_id: "desktop-7".into(),
        session_id: URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES]),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(1_060),
        revoked: AtomicBool::new(false),
        next_sequence_floor: AtomicU64::new(0),
        state: AsyncMutex::new(SessionState {
            keys,
            used_output_nonces: (0..MAX_OUTPUT_STREAM_NONCES)
                .map(|index| format!("used-{index}"))
                .collect(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    };
    let nonce = URL_SAFE_NO_PAD.encode([5_u8; OUTPUT_STREAM_NONCE_BYTES]);

    assert!(matches!(
        session.open_output_cipher(&nonce, 1_000).await,
        Err(E2eError::Expired)
    ));
    assert!(session.is_revoked());
    assert!(matches!(
        session.ensure_active(1_000),
        Err(E2eError::Invalid)
    ));
}

fn establish_request(
    challenge_request: &ChallengeRequest,
    response: &ChallengeResponse,
    seed: &[u8],
) -> EstablishRequest {
    let mut request = EstablishRequest {
        version: 1,
        instance_id: challenge_request.instance_id.clone(),
        pairing_id: challenge_request.pairing_id.clone(),
        client_nonce: challenge_request.client_nonce.clone(),
        client_session_nonce: challenge_request.client_session_nonce.clone(),
        challenge_id: response.challenge_id.clone(),
        client_proof: String::new(),
    };
    let fields = proof_fields_establish(
        &request,
        &response.server_nonce,
        response.challenge_expires_at,
    );
    request.client_proof = proof(seed, ESTABLISH_REQUEST_DOMAIN, &field_refs(&fields)).unwrap();
    request
}

#[tokio::test]
async fn exact_request_replay_returns_cached_encrypted_response() {
    let e2e = AndroidE2eState::default();
    let material = material();
    let challenge_request = request();
    let challenge = e2e
        .issue_challenge_with_material(
            challenge_request.clone(),
            &material,
            1_000,
            [4_u8; 16],
            [5_u8; 32],
            &mut e2e.registry.lock().unwrap(),
        )
        .unwrap();
    let establish_request = establish_request(&challenge_request, &challenge, &material.seed);
    let established = e2e.establish(establish_request, &material, 1_001).unwrap();
    let keys = derive_session_keys(&material.seed, &key_fields(&established)).unwrap();
    let session = e2e
        .session(&established.instance_id, &established.session_id, 1_001)
        .unwrap();
    let envelope = RpcRequestEnvelope {
        session_id: established.session_id.clone(),
        sequence: 0,
        ciphertext: encrypt_request(
            &keys.a2d,
            &established.instance_id,
            &established.session_id,
            0,
            br#"{"kind":"test"}"#,
        )
        .unwrap(),
    };
    let first = session
        .process(
            envelope.clone(),
            || Ok(1_001),
            |_, _| async {
                Ok(AndroidE2eDispatchResult::unguarded(
                    serde_json::json!({"ok": true}),
                ))
            },
            |_, _, _| Ok(()),
        )
        .await
        .unwrap();
    let replay = session
        .process(
            envelope,
            || Ok(1_800),
            |_, _| async { panic!("cached replay must not dispatch twice") },
            |_, _, _| Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(first, replay);
    assert_eq!(session.expires_at.load(Ordering::Acquire), 1_901);
    let plaintext = decrypt_response(
        &keys.d2a,
        &first.instance_id,
        &first.session_id,
        first.sequence,
        &first.ciphertext,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&plaintext).unwrap(),
        serde_json::json!({
            "version": 1,
            "expiresAt": 1_901,
            "response": {"ok": true},
        })
    );
}

#[tokio::test]
async fn guarded_exact_retry_revalidates_authority_and_revokes_on_change() {
    let server_keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let client_keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let session_id = URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES]);
    let session = Arc::new(AndroidE2eSession {
        instance_id: "desktop-7".into(),
        session_id: session_id.clone(),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(2_000),
        revoked: AtomicBool::new(false),
        next_sequence_floor: AtomicU64::new(0),
        state: AsyncMutex::new(SessionState {
            keys: server_keys,
            used_output_nonces: HashSet::new(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    });
    let envelope = RpcRequestEnvelope {
        session_id,
        sequence: 0,
        ciphertext: encrypt_request(
            &client_keys.a2d,
            "desktop-7",
            &session.session_id,
            0,
            br#"{"kind":"http","method":"POST","path":"/remote/v1/file-viewer/render"}"#,
        )
        .unwrap(),
    };
    let guard = AndroidE2eReplayGuard::new(
        "lease-1".into(),
        7,
        11,
        "desktop-7".into(),
        session.session_id.clone(),
    );
    let allowed = Arc::new(AtomicBool::new(true));
    let checks = Arc::new(AtomicUsize::new(0));

    let first_allowed = Arc::clone(&allowed);
    let first_checks = Arc::clone(&checks);
    let first = session
        .process(
            envelope.clone(),
            || Ok(1_000),
            move |_, _| {
                let guard = guard.clone();
                async move {
                    Ok(AndroidE2eDispatchResult::guarded(
                        serde_json::json!({"secret": "payload"}),
                        guard,
                    ))
                }
            },
            move |_, _, _| {
                first_checks.fetch_add(1, Ordering::AcqRel);
                first_allowed
                    .load(Ordering::Acquire)
                    .then_some(())
                    .ok_or(E2eError::Invalid)
            },
        )
        .await
        .expect("initial guarded response");

    let replay_allowed = Arc::clone(&allowed);
    let replay_checks = Arc::clone(&checks);
    let replay = session
        .process(
            envelope.clone(),
            || Ok(1_100),
            |_, _| async { panic!("guarded retry must not dispatch twice") },
            move |_, _, _| {
                replay_checks.fetch_add(1, Ordering::AcqRel);
                replay_allowed
                    .load(Ordering::Acquire)
                    .then_some(())
                    .ok_or(E2eError::Invalid)
            },
        )
        .await
        .expect("still-authorized replay");
    assert_eq!(replay, first);

    allowed.store(false, Ordering::Release);
    let denied_checks = Arc::clone(&checks);
    assert!(matches!(
        session
            .process(
                envelope,
                || Ok(1_200),
                |_, _| async { panic!("denied retry must not dispatch twice") },
                move |_, _, _| {
                    denied_checks.fetch_add(1, Ordering::AcqRel);
                    Err(E2eError::Invalid)
                },
            )
            .await,
        Err(E2eError::Invalid)
    ));
    assert!(session.is_revoked());
    assert_eq!(checks.load(Ordering::Acquire), 3);
}

#[tokio::test]
async fn guarded_fresh_response_is_not_encrypted_when_authority_changed_during_dispatch() {
    let server_keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let client_keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let session_id = URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES]);
    let session = Arc::new(AndroidE2eSession {
        instance_id: "desktop-7".into(),
        session_id: session_id.clone(),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(2_000),
        revoked: AtomicBool::new(false),
        next_sequence_floor: AtomicU64::new(0),
        state: AsyncMutex::new(SessionState {
            keys: server_keys,
            used_output_nonces: HashSet::new(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    });
    let envelope = RpcRequestEnvelope {
        session_id,
        sequence: 0,
        ciphertext: encrypt_request(
            &client_keys.a2d,
            "desktop-7",
            &session.session_id,
            0,
            br#"{"kind":"http","method":"POST","path":"/remote/v1/file-viewer/render"}"#,
        )
        .unwrap(),
    };
    let guard = AndroidE2eReplayGuard::new(
        "lease-1".into(),
        7,
        11,
        "desktop-7".into(),
        session.session_id.clone(),
    );

    assert!(matches!(
        session
            .process(
                envelope,
                || Ok(1_000),
                move |_, _| async move {
                    Ok(AndroidE2eDispatchResult::guarded(
                        serde_json::json!({"secret": "must-not-be-encrypted"}),
                        guard,
                    ))
                },
                |_, _, _| Err(E2eError::Invalid),
            )
            .await,
        Err(E2eError::Invalid)
    ));
    assert!(session.is_revoked());
    let state = session.state.lock().await;
    assert_eq!(state.next_sequence, 0);
    assert!(state.last_response.is_none());
}

#[tokio::test]
async fn authenticated_requests_slide_the_inactivity_deadline() {
    let session_keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let client_keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let session_id = URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES]);
    let session = Arc::new(AndroidE2eSession {
        instance_id: "desktop-7".into(),
        session_id: session_id.clone(),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(1_060),
        revoked: AtomicBool::new(false),
        next_sequence_floor: AtomicU64::new(0),
        state: AsyncMutex::new(SessionState {
            keys: session_keys,
            used_output_nonces: HashSet::new(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    });

    let first = session
        .process(
            RpcRequestEnvelope {
                session_id: session_id.clone(),
                sequence: 0,
                ciphertext: encrypt_request(
                    &client_keys.a2d,
                    "desktop-7",
                    &session_id,
                    0,
                    br#"{"kind":"test"}"#,
                )
                .unwrap(),
            },
            || Ok(1_059),
            |_, _| async {
                Ok(AndroidE2eDispatchResult::unguarded(
                    serde_json::json!({"ok": true}),
                ))
            },
            |_, _, _| Ok(()),
        )
        .await
        .unwrap();
    let first_plaintext = decrypt_response(
        &client_keys.d2a,
        &first.instance_id,
        &first.session_id,
        first.sequence,
        &first.ciphertext,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&first_plaintext).unwrap(),
        serde_json::json!({
            "version": 1,
            "expiresAt": 1_959,
            "response": {"ok": true},
        })
    );

    session
        .process(
            RpcRequestEnvelope {
                session_id,
                sequence: 1,
                ciphertext: encrypt_request(
                    &client_keys.a2d,
                    "desktop-7",
                    &first.session_id,
                    1,
                    br#"{"kind":"test"}"#,
                )
                .unwrap(),
            },
            || Ok(1_958),
            |_, _| async {
                Ok(AndroidE2eDispatchResult::unguarded(
                    serde_json::json!({"ok": true}),
                ))
            },
            |_, _, _| Ok(()),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn failed_dispatch_does_not_slide_the_inactivity_deadline() {
    let keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let session_id = URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES]);
    let ciphertext = encrypt_request(
        &keys.a2d,
        "desktop-7",
        &session_id,
        0,
        br#"{"kind":"test"}"#,
    )
    .unwrap();
    let session = Arc::new(AndroidE2eSession {
        instance_id: "desktop-7".into(),
        session_id: session_id.clone(),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(1_060),
        revoked: AtomicBool::new(false),
        next_sequence_floor: AtomicU64::new(0),
        state: AsyncMutex::new(SessionState {
            keys,
            used_output_nonces: HashSet::new(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    });

    assert!(matches!(
        session
            .process(
                RpcRequestEnvelope {
                    session_id,
                    sequence: 0,
                    ciphertext,
                },
                || Ok(1_059),
                |_, _| async { Err(AppError::Other("dispatch failed".into())) },
                |_, _, _| Ok(()),
            )
            .await,
        Err(E2eError::Internal(_))
    ));
    assert_eq!(session.expires_at.load(Ordering::Acquire), 1_060);
}

#[test]
fn challenge_expires_at_the_exact_boundary() {
    let e2e = AndroidE2eState::default();
    let material = material();
    let challenge_request = request();
    let challenge = e2e
        .issue_challenge_with_material(
            challenge_request.clone(),
            &material,
            1_000,
            [4_u8; 16],
            [5_u8; 32],
            &mut e2e.registry.lock().unwrap(),
        )
        .unwrap();
    let establish_request = establish_request(&challenge_request, &challenge, &material.seed);
    assert!(matches!(
        e2e.establish(establish_request, &material, 1_060),
        Err(E2eError::Invalid | E2eError::Expired)
    ));
}

#[tokio::test]
async fn session_expires_at_the_exact_boundary_after_waiting_for_its_lock() {
    let keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let session = Arc::new(AndroidE2eSession {
        instance_id: "desktop-7".into(),
        session_id: URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES]),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(1_060),
        revoked: AtomicBool::new(false),
        next_sequence_floor: AtomicU64::new(0),
        state: AsyncMutex::new(SessionState {
            keys,
            used_output_nonces: HashSet::new(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    });
    let envelope = RpcRequestEnvelope {
        session_id: session.session_id.clone(),
        sequence: 0,
        ciphertext: b"invalid".to_vec(),
    };

    assert!(matches!(
        session
            .process(
                envelope,
                || Ok(1_060),
                |_, _| async { panic!("an expired request must not dispatch") },
                |_, _, _| Ok(()),
            )
            .await,
        Err(E2eError::Expired)
    ));
}

#[tokio::test]
async fn clear_revokes_a_session_arc_that_was_already_looked_up() {
    let e2e = AndroidE2eState::default();
    let keys = derive_session_keys(&[7_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
    let session_id = URL_SAFE_NO_PAD.encode([8_u8; SESSION_ID_BYTES]);
    let ciphertext = encrypt_request(
        &keys.a2d,
        "desktop-7",
        &session_id,
        0,
        br#"{"kind":"test"}"#,
    )
    .unwrap();
    let session = Arc::new(AndroidE2eSession {
        instance_id: "desktop-7".into(),
        session_id: session_id.clone(),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(2_000),
        revoked: AtomicBool::new(false),
        next_sequence_floor: AtomicU64::new(0),
        state: AsyncMutex::new(SessionState {
            keys,
            used_output_nonces: HashSet::new(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    });
    e2e.registry
        .lock()
        .unwrap()
        .sessions
        .insert(session_id.clone(), session.clone());
    e2e.clear().unwrap();

    assert!(matches!(
        session
            .process(
                RpcRequestEnvelope {
                    session_id,
                    sequence: 0,
                    ciphertext,
                },
                || Ok(1_000),
                |_, _| async { panic!("a revoked request must not dispatch") },
                |_, _, _| Ok(()),
            )
            .await,
        Err(E2eError::Invalid)
    ));
}

#[tokio::test]
async fn a_new_establish_replaces_the_previous_session_for_the_pairing() {
    let e2e = AndroidE2eState::default();
    let material = material();
    let first_request = request();
    let first_challenge = e2e
        .issue_challenge_with_material(
            first_request.clone(),
            &material,
            1_000,
            [4_u8; 16],
            [5_u8; 32],
            &mut e2e.registry.lock().unwrap(),
        )
        .unwrap();
    let first_established = e2e
        .establish(
            establish_request(&first_request, &first_challenge, &material.seed),
            &material,
            1_001,
        )
        .unwrap();
    let first_session = e2e
        .session(
            &first_established.instance_id,
            &first_established.session_id,
            1_001,
        )
        .unwrap();

    let mut second_request = request();
    second_request.client_session_nonce = URL_SAFE_NO_PAD.encode([6_u8; 16]);
    let second_challenge = e2e
        .issue_challenge_with_material(
            second_request.clone(),
            &material,
            1_002,
            [7_u8; 16],
            [8_u8; 32],
            &mut e2e.registry.lock().unwrap(),
        )
        .unwrap();
    let second_established = e2e
        .establish(
            establish_request(&second_request, &second_challenge, &material.seed),
            &material,
            1_003,
        )
        .unwrap();

    assert!(first_session.is_revoked());
    assert_eq!(e2e.registry.lock().unwrap().sessions.len(), 1);
    assert!(e2e
        .session(
            &second_established.instance_id,
            &second_established.session_id,
            1_003,
        )
        .is_ok());

    // 앱의 E2eProtocol.COMPAT_VERSION과 항상 같은 값이어야 한다 (ADR-0172).
    // 언어가 달라 공유 상수를 둘 수 없으므로 양쪽에 리터럴로 핀한다 —
    // Kotlin 쪽 동일 핀은 E2eProtocolTest에 있다.
    // 2: RPC 요청 binary envelope (ADR-0351).
    assert_eq!(crate::android_e2e::COMPAT_VERSION, 2);
    assert_eq!(second_challenge.compat_version, 2);

    // The claim path frees a lease bound to the replaced session (ADR-0170):
    // the revoked session must read as dead, the replacement as alive, and an
    // expired clock must kill both.
    assert!(!e2e.session_is_active(
        &first_established.instance_id,
        &first_established.session_id,
        1_003,
    ));
    assert!(e2e.session_is_active(
        &second_established.instance_id,
        &second_established.session_id,
        1_003,
    ));
    assert!(!e2e.session_is_active("other-instance", &second_established.session_id, 1_003,));
    assert!(!e2e.session_is_active(
        &second_established.instance_id,
        &second_established.session_id,
        1_003 + 15 * 60,
    ));
}

fn established_state(now: u64) -> (AndroidE2eState, EstablishResponse, SessionKeys) {
    let e2e = AndroidE2eState::default();
    let material = material();
    let challenge_request = request();
    let challenge = e2e
        .issue_challenge_with_material(
            challenge_request.clone(),
            &material,
            now,
            [4_u8; 16],
            [5_u8; 32],
            &mut e2e.registry.lock().unwrap(),
        )
        .unwrap();
    let establish = establish_request(&challenge_request, &challenge, &material.seed);
    let established = e2e.establish(establish, &material, now).unwrap();
    let keys = derive_session_keys(&material.seed, &key_fields(&established)).unwrap();
    (e2e, established, keys)
}

fn binary_request(
    keys: &SessionKeys,
    instance_id: &str,
    session_id: &str,
    sequence: u64,
    plaintext: &[u8],
) -> Vec<u8> {
    crate::android_e2e::encode_rpc_request(
        session_id,
        sequence,
        &encrypt_request(&keys.a2d, instance_id, session_id, sequence, plaintext).unwrap(),
    )
}

fn prefix_only(session_id: &str, sequence: u64) -> Vec<u8> {
    crate::android_e2e::encode_rpc_request(session_id, sequence, &[])
}

async fn process_ok(session: &Arc<AndroidE2eSession>, body: &[u8], now: u64) {
    session
        .process(
            RpcRequestEnvelope::parse(body.to_vec()).unwrap(),
            || Ok(now),
            |_, _| async {
                Ok(AndroidE2eDispatchResult::unguarded(
                    serde_json::json!({"ok": true}),
                ))
            },
            |_, _, _| Ok(()),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn binary_request_resolves_its_session_without_an_instance_on_the_wire() {
    let (e2e, established, keys) = established_state(1_000);
    let body = binary_request(
        &keys,
        &established.instance_id,
        &established.session_id,
        0,
        br#"{"kind":"test"}"#,
    );
    let session = e2e
        .session_for_request(&established.session_id, 1_000)
        .unwrap();
    assert_eq!(session.instance_id, established.instance_id);
    process_ok(&session, &body, 1_000).await;
    assert!(matches!(
        e2e.session_for_request(&URL_SAFE_NO_PAD.encode([0_u8; 16]), 1_000),
        Err(E2eError::Invalid)
    ));
}

#[tokio::test]
async fn aad_binds_the_session_instance_not_a_caller_supplied_one() {
    let (e2e, established, keys) = established_state(1_000);
    let session = e2e
        .session_for_request(&established.session_id, 1_000)
        .unwrap();
    // Same session keys and id, but sealed for another instance: a relay that
    // misroutes or rewrites the instance header cannot make this authenticate.
    let foreign = binary_request(
        &keys,
        "desktop-8",
        &established.session_id,
        0,
        br#"{"kind":"test"}"#,
    );
    assert!(matches!(
        session
            .process(
                RpcRequestEnvelope::parse(foreign).unwrap(),
                || Ok(1_000),
                |_, _| async { panic!("a foreign-instance request must not dispatch") },
                |_, _, _| Ok(()),
            )
            .await,
        Err(E2eError::Invalid)
    ));
    // The failed attempt did not consume the sequence.
    let genuine = binary_request(
        &keys,
        &established.instance_id,
        &established.session_id,
        0,
        br#"{"kind":"test"}"#,
    );
    process_ok(&session, &genuine, 1_000).await;
}

#[tokio::test]
async fn prefix_check_rejects_unknown_expired_revoked_and_stale_sequences() {
    let (e2e, established, keys) = established_state(1_000);
    let sid = established.session_id.clone();

    // Fewer than 31 bytes: undecided.
    assert!(e2e
        .check_rpc_prefix(&prefix_only(&sid, 0)[..30], 1_000)
        .is_none());
    assert!(e2e.check_rpc_prefix(&[], 1_000).is_none());
    // Wrong format byte (e.g. the old JSON envelope's `{`).
    let mut legacy = prefix_only(&sid, 0);
    legacy[0] = b'{';
    assert_eq!(
        e2e.check_rpc_prefix(&legacy, 1_000),
        Some(Err(EnvelopeRejection::Malformed))
    );
    // Unknown session.
    assert!(matches!(
        e2e.check_rpc_prefix(&prefix_only(&URL_SAFE_NO_PAD.encode([0_u8; 16]), 0), 1_000),
        Some(Err(EnvelopeRejection::Session(E2eError::Invalid)))
    ));
    // Live session: the first sequence and later ones pass.
    assert_eq!(
        e2e.check_rpc_prefix(&prefix_only(&sid, 0), 1_000),
        Some(Ok(()))
    );
    assert_eq!(
        e2e.check_rpc_prefix(&prefix_only(&sid, 5), 1_000),
        Some(Ok(()))
    );

    // Advance to next_sequence = 2.
    let session = e2e.session_for_request(&sid, 1_000).unwrap();
    for sequence in 0..2 {
        let body = binary_request(&keys, &established.instance_id, &sid, sequence, b"{}");
        process_ok(&session, &body, 1_000).await;
    }
    // The previous sequence stays allowed (exact retry); older ones fail early.
    assert_eq!(
        e2e.check_rpc_prefix(&prefix_only(&sid, 1), 1_000),
        Some(Ok(()))
    );
    assert_eq!(
        e2e.check_rpc_prefix(&prefix_only(&sid, 2), 1_000),
        Some(Ok(()))
    );
    assert!(matches!(
        e2e.check_rpc_prefix(&prefix_only(&sid, 0), 1_000),
        Some(Err(EnvelopeRejection::Session(E2eError::Sequence)))
    ));

    // Expired at the exact boundary.
    let expires_at = session.expires_at.load(Ordering::Acquire);
    assert_eq!(
        e2e.check_rpc_prefix(&prefix_only(&sid, 2), expires_at - 1),
        Some(Ok(()))
    );
    assert!(matches!(
        e2e.check_rpc_prefix(&prefix_only(&sid, 2), expires_at),
        Some(Err(EnvelopeRejection::Session(E2eError::Expired)))
    ));
    // Revoked.
    session.revoked.store(true, Ordering::Release);
    assert!(matches!(
        e2e.check_rpc_prefix(&prefix_only(&sid, 2), 1_000),
        Some(Err(EnvelopeRejection::Session(E2eError::Invalid)))
    ));
}

#[tokio::test]
async fn prefix_check_consumes_no_sequence_and_renews_no_lifetime() {
    let (e2e, established, keys) = established_state(1_000);
    let sid = established.session_id.clone();
    let session = e2e.session_for_request(&sid, 1_000).unwrap();
    let expires_before = session.expires_at.load(Ordering::Acquire);
    let body = binary_request(&keys, &established.instance_id, &sid, 0, b"{}");

    // Many accepted and rejected prefix checks, late in the session's life.
    for _ in 0..8 {
        assert_eq!(
            e2e.check_rpc_prefix(&body, expires_before - 1),
            Some(Ok(()))
        );
        let mut bad = body.clone();
        bad[0] = 1;
        assert!(matches!(
            e2e.check_rpc_prefix(&bad, expires_before - 1),
            Some(Err(_))
        ));
    }
    assert_eq!(session.expires_at.load(Ordering::Acquire), expires_before);
    assert_eq!(session.next_sequence_floor.load(Ordering::Acquire), 0);
    assert_eq!(session.state.lock().await.next_sequence, 0);
    assert_eq!(e2e.registry.lock().unwrap().sessions.len(), 1);

    // An expired-session prefix check must not prune the registry either.
    drop(session);
    assert!(matches!(
        e2e.check_rpc_prefix(&body, expires_before),
        Some(Err(EnvelopeRejection::Session(E2eError::Expired)))
    ));
    assert_eq!(e2e.registry.lock().unwrap().sessions.len(), 1);

    // The full request with the same sequence still succeeds afterwards and
    // only then moves the sequence floor and the lifetime.
    let session = e2e.session_for_request(&sid, 1_010).unwrap();
    process_ok(&session, &body, 1_010).await;
    assert_eq!(session.next_sequence_floor.load(Ordering::Acquire), 1);
    assert_eq!(
        session.expires_at.load(Ordering::Acquire),
        1_010 + SESSION_INACTIVITY_TIMEOUT_SECONDS
    );
}

#[tokio::test]
async fn prefix_check_does_not_wait_for_an_in_flight_request() {
    let (e2e, established, _keys) = established_state(1_000);
    let session = e2e
        .session_for_request(&established.session_id, 1_000)
        .unwrap();
    // A request mid-dispatch holds the session lock; the pre-check must not block.
    let _held = session.state.lock().await;
    assert_eq!(
        e2e.check_rpc_prefix(&prefix_only(&established.session_id, 1), 1_000),
        Some(Ok(()))
    );
}
