# Codex Voice 클라이언트 오디오 중개 검증

- 날짜: 2026-10-31
- 최근 실행 확인: 2026-11-01
- 작업: `investigate/codex-voice-20261031` 워크트리, `00c02efb` 기반
- 설계: [ADR-0369](adr/0369-client-audio-for-codex-voice.md), [API 계약 §16](architecture/api-contracts.md#16-codex-voice-클라이언트-오디오-중개-실험)
- 상태: **실험 구현. Windows·WSL·Remote 모바일 페이지에서 실제 Codex 음성 송수신·종료를 확인했다. Claude는 WSL 로컬 받아쓰기까지 확인했다. Android 실기기와 Claude Remote 중개는 검증 범위 밖이다.**

## 확인한 프로토콜

설치된 Codex CLI 0.166.0에서 `codex app-server generate-json-schema --experimental`로 생성한
스키마에 `thread/realtime/start`, `appendAudio`, `outputAudio/delta`, WebRTC SDP가 있다.
격리된 로컬 app-server에 입력을 보내 실험 capability가 없으면 `requires experimentalApi`,
있으면 잘못된 thread에 `thread not found`를 반환하는 것을 확인했다. 이는 메서드가 실제로
처리됨을 보이며 모델·오디오 성공을 보장하는 검증은 아니다.

구현은 현재 pane의 TUI 프로세스·CODEX_HOME·PTY 세대와 managed title을 확인하고,
해당 제어 소켓의 loaded thread 목록에서 축약 ID를 유일하게 확장한다. `thread/resume`은
`excludeTurns:true`로 구독하여 전체 과거 대화를 전송하지 않는다. 별도 대화를 만들거나
모델·시스템 오디오 장치를 바꾸지 않는다.

## 실제 Codex 서비스 결과

dev(19281)와 합성 음성 WAV를 사용했다. Windows는 격리 CODEX_HOME, WSL은
`env -u WSL_INTEROP codex`로 실행했다. 첫 텍스트 메시지에 READY 응답을 받은 기존 대화에
연결했으며 모든 검증에서 실제 서비스 SDP answer·connected 상태·받아쓰기·응답 음성을 확인했다.

| 경로 | 전송 오디오 bytes | 수신 오디오 bytes | 수신 오디오 에너지 |
| --- | ---: | ---: | ---: |
| PC → Windows Codex | 59,841 | 74,162 | 0.0688 |
| PC → WSL Codex, WSL_INTEROP 없음 | 111,833 | 149,223 | 0.2173 |
| Remote 모바일 페이지 → Windows Codex | 17,470 | 8,642 | 0.0203 |

각각 다른 시점의 누적 통계이며 전송률 비교용 측정이 아니다. Remote는 Chromium 모바일
에뮬레이션에서 실제 배포 페이지·인증·lease·Voice 버튼·`/remote/v1/voice/*`를 사용했다.
수신 디코딩 샘플 268,800개와 `output_transcript.added`를 확인했고, 잘못된 lease의 조회는
거부됐다. 페이지 오류 없이 종료 후 RTCPeerConnection이 closed가 됐다. PC·WSL도 정상 종료했다.

**기존 에이전트 경로도 확인했다.** 합성 음성으로 현재 디렉터리를 확인하라고 요청하자
기존 Windows Codex CLI에 사용자 요청이 나타났고 실제 `pwd`가 실행됐다. 결과
`D:\PycharmProjects\laymux-worktrees\codex-voice-20261031`가 CLI에 표시되고 응답 음성으로
돌아왔다. 검증 요청은 파일 변경을 금지했으며 모델의 별도 STT·직접 모델 호출로 대체하지 않았다.

기본 realtime 버전의 첫 시도는 `invalid_quicksilver_alpha_header` 오류였으나 V3를 명시한
설치본에서는 실제 연결이 성공했다. 또 패킷은 수신되지만 Web Audio 경로에서 디코딩 샘플이
0인 재생 결함을 찾았다. 실제 브라우저 회귀 테스트에 샘플·에너지 검사를 추가해 실패를 재현한
뒤 `HTMLAudioElement.play()`로 수정했고 통과했다. Remote 배포 번들도 다시 빌드해 검증했다.

## Claude Code

Claude Code 2.1.316의 `/voice hold`를 실제 실행했다. WSLg PulseAudio에 검증 전용 null sink를
만들고 해당 monitor를 Claude 프로세스의 `PULSE_SOURCE`와 검증용 `ALSA_CONFIG_PATH`로만
지정했다. 합성 음성을 paplay로 이 가상 입력에 넣고 Space 반복 입력으로 녹음했다.
Claude 고유 Voice가 **“Please say voice bridge confirmed.”**를 입력창에 받아썼다.
검증 문장은 모델에 제출하지 않았다.

가상 입력 자체도 96,000개 PCM 샘플, peak 14,063, RMS 약 2,122로 확인했다. 종료 후 Claude를
기본 오디오 환경으로 다시 실행하고 정확히 검증용으로 만든 PulseAudio module만 제거했다.
시스템 기본 장치는 검증 전후 모두 RDPSink·RDPSource였다.

[Claude 공식 문서](https://code.claude.com/docs/en/voice-dictation)의 로컬 받아쓰기 경로를
검증한 결과다. Codex realtime과 같은 외부 API를 가정하지 않았고 별도 STT를 붙이지 않았다.
Claude Remote 연결 제품 기능을 구현·검증한 결과는 아니다.

## 자동 검증
- UI 전체 unit: 297개 파일, 5,953개 테스트 통과. production bundle 제한과 TypeScript·변경 파일 ESLint도 통과했다.
- Rust 전체 lib: 2,759개 통과, 12개 ignored. 이후 대화 귀속·요청 수정에는 Voice 6개와 Remote 기본값 1개를 다시 실행했고 release check·clippy를 통과했다.
- 관련 브라우저 E2E 80개 중 79개 통과 후, 새 Voice 기본 배치를 반영하지 못한 기대값 1개를 수정해 해당 테스트를 재실행·통과했다. 전체 E2E 스위트 실행 결과로 확대 해석하지 않는다.

- Rust: 외부 thread/server 지정 거부, controller별 이벤트·종료 권한, 이벤트 유실 감지,
  실제 Unix-domain WebSocket JSON-RPC와 서버 오류 전달 검증.
- 브라우저: 실제 Chromium peer 두 개로 양방향 RTP·디코딩 샘플·오디오 에너지를 확인하고
  중지 시 장치와 재생 element의 stream 참조를 해제했다. 제한적 CSP에서도 통과했다.
  이 로컬 회귀 테스트와 위의 실제 Codex 서비스 검증은 별개다.
- 클라이언트: 마이크 권한 대기 중 취소, 늦은 서버 응답 정리, 신호 응답 timeout 시 장치 해제.
- Android: 활성 문서·정확한 synthetic HTTPS origin·audio-only 권한 정책의 JVM 테스트와
  debug APK 빌드 성공. 실기기 WebRTC 통화 성공을 뜻하지 않는다.
- dev Automation screenshot으로 PC 제어 바와 Claude Voice 활성 안내를 확인했다.

## 제한과 남은 검증

- Android 실기기의 microphone 권한·스피커·백그라운드 전환·실제 네트워크에서의 통화.
- 승인 팝업을 요구하는 도구 실행의 전달. 이번 실제 에이전트 실행은 읽기 전용 `pwd`였다.
- 일반 음성 잡담 전체의 CLI 텍스트 대화 보존. 짧은 음성 대화 뒤 CLI에 내용을 물으면
  UNAVAILABLE을 반환했다. 위의 에이전트 위임과 동일한 계약으로 취급하지 않는다.
- 첫 메시지가 없는 새 대화에서는 현재 `thread/resume`이 `no rollout found for thread id …`로
  거부될 수 있다. 이번 검증은 첫 텍스트 메시지를 보낸 기존 대화에서 수행했다.
- 같은 thread에서 CLI 자체 Voice와 중개 Voice의 동시 사용은 지원하지 않는다.

Remote의 버튼은 새 기기 Keys 확장 행에 있다. 저장 배치를 유지하는 기존 기기는 Add keys에서
Codex Voice를 배치할 수 있다.

`thread/realtime/stop`의 설치본 계약은 `threadId`만 받는다. 따라서 제3자가 같은 thread의
음성을 교체했을 때 UUID만으로 종료 대상을 원자적으로 한정할 수 있다고 주장하지 않는다.
서버의 closed/error를 관측하면 stop을 다시 보내지 않지만, 동시 교체 경합의 보장은 남은 검증 항목이다.
현재 dev 실행 파일은 V3·대화 귀속 제한·`excludeTurns`와 Remote 재생 수정까지 반영했으며
해당 실행 파일과 배포 번들로 Remote 실서비스 연결을 검증했다. 테스트 연결·가상 오디오 장치는
정리했고 Remote runtime access와 제어권도 검증 전 상태로 복원했다.
합성 마이크용 WebView2 플래그도 제거하고 dev를 일반 오디오 환경으로 다시 실행했다.

버전 영향: minor — PC·Remote의 새 음성 중개 기능과 Android microphone 권한을 추가한다.
