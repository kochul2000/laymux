# 0369. Codex Voice는 클라이언트 오디오와 기존 대화를 연결한다

- Status: Proposed
- Date: 2026-10-31
- Source: 사용자 요청 — PC·WSL·Remote 음성 중개 구현과 Codex/Claude 실행 검증; architecture/api-contracts.md §12; Codex 0.166.0 실험용 app-server 스키마

## Context

PTY는 키 입력과 화면 바이트를 전달하며 클라이언트 마이크를 호스트 에이전트에 전달하지 않는다.
Windows Codex의 로컬 음성 장치는 사용 가능하지만 WSL 오디오 장치와 휴대폰 마이크는 별개다.
Codex app-server는 thread 단위 realtime 시작과 외부 오디오 입력, WebRTC SDP를 제공한다.
Claude Code의 `/voice`는 받아쓰기이며 같은 realtime 프로토콜을 제공한다고 가정할 수 없다.

## Decision

**laymux는 검증된 현재 Codex 대화에 클라이언트의 WebRTC 오디오를 연결하고, 모델·대화·도구 실행은 Codex가 소유한다.**

- 현재 pane의 process/세대/대화 귀속을 재사용한다. 클라이언트가 임의 thread ID나 서버 주소를 지정하지 못한다.
- 기존 로컬 Codex 제어 소켓에 연결한다. WSL은 제한된 Unix 소켓 byte relay를 사용하며 Windows interop나 새 네트워크 listener를 요구하지 않는다.
- PC는 기존 인간 제어권을, Remote는 기존 인증·활성 lease·Android E2E 계약을 따른다. 한 laymux 인스턴스의 중개 음성은 한 소유자와 한 pane에만 속한다.
- 종료·연결 해제·lease 상실·pane 세대 변경·heartbeat 만료 시 시작 성공한 중개 세션을 정리한다. 서버의 closed/error를 관측한 뒤에는 stop을 다시 보내지 않는다. 설치본 stop 계약은 thread 단위이므로 동일 thread에서 CLI Voice와의 동시 사용은 지원 범위에서 제외하며, 원자적 세션 종료 계약이 확인되면 재검토한다.
- SDP는 기존 인증 채널로 전달한다. WebRTC 미디어는 클라이언트와 Codex 서비스 사이로 전송된다. PC·relay에 마이크 오디오를 저장하지 않는다.
- 기본 시스템 마이크·스피커 변경, 가상 오디오 드라이버 설치, 별도 STT/TTS·모델 호출로의 자동 fallback은 하지 않는다.
- 실험용 프로토콜 미지원·귀속 실패·기존 음성 충돌은 명시적 오류다. Claude 지원을 Codex의 성공으로 추정하지 않는다.

## Alternatives Considered

- 음성 인식 후 PTY에 텍스트 입력: 기존 에이전트는 유지하지만 Codex 고유 음성 대화를 보존하지 못한다.
- Windows 가상 마이크와 loopback: 다른 CLI에도 적용 가능하지만 드라이버 설치·장치 선택·출력 분리가 필요하고 WSL 장치 문제를 함께 해결하지 않는다.
- PCM을 Remote HTTP 요청으로 중계: 진단에는 유용하지만 지속 미디어에 불필요한 relay 대역폭·base64 비용·버퍼링을 추가한다.

## Consequences

모바일 미디어를 PC relay에서 처리하지 않아 전송 부하를 줄이고 WSL의 물리 오디오 장치 접근을 우회한다.
Codex 실험용 API 버전 변화와 WebRTC 연결 환경에 영향을 받으며 실제 CLI 대화 연결·음성 송수신 검증이 필요하다.
Android는 활성 Remote 문서의 명시적 사용자 동작에만 녹음 권한을 부여한다. 일반 HTTP의 비보안 문서에서는 녹음 기능을 제공하지 못한다.
Claude는 공식 로컬 Voice 실행 결과와 외부 오디오 지원 가능성을 별도로 기록한다. 외부 입력 계약이 없으면 가상 장치 또는 공급자 지원 여부를 다시 결정한다.
