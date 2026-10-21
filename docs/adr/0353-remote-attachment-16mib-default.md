# 0353. Remote 첨부 상한은 기본값과 최대값 모두 16 MiB이고, Cloud relay 요청 상한은 24 MiB다

- Status: Accepted
- Date: 2026-10-21
- Source: 사용자 요구("최대 16MiB 상한을 기본값으로 다 수정 및 배포해") · [ADR-0227](0227-remote-document-attachments.md) · [ADR-0351](0351-android-e2e-binary-rpc-streamed-through-relay.md) · [ADR-0352](0352-android-e2e-early-rejection-drains-body.md)
- Amends: ADR-0227(첨부 상한 범위 1–10 MiB, 기본 1 MiB, 10 MiB의 근거인 relay 16 MiB), ADR-0351(relay 요청 상한 16 MiB)

## Context

ADR-0227은 `remote.attachmentMaxMib`를 1–10 MiB, 기본 1 MiB로 정했다. 상한 10 MiB는 Cloud relay의 HTTP 요청 상한 16 MiB 안에 base64 JSON을 넣기 위한 값이었다. ADR-0351·0352로 Android E2E 경로도 relay에서 버퍼 없이 흘려보내게 되면서 relay 메모리는 더 이상 요청 크기에 비례하지 않는다. 그런데도 기본값 1 MiB 때문에 사용자가 설정을 바꾸지 않으면 사진 한 장도 첨부하지 못한다.

사용자는 첨부 최대값을 16 MiB로 올리고 그 값을 기본으로 쓰기를 원한다. 16 MiB 첨부는 base64 JSON으로 약 21.4 MiB이고 Android binary envelope도 약 21.4 MiB라서 relay 16 MiB 상한을 넘는다.

## Decision

**`remote.attachmentMaxMib`의 범위를 1–16 MiB로 넓히고 기본값을 16 MiB로 한다. Cloud relay의 HTTP 요청 상한(`TUNNEL_HTTP_REQUEST_BYTES_LIMIT`)을 24 MiB로 올리고, desktop의 미러와 tunnel 경계를 같은 값에서 유도한다.**

- **settings**: 범위 1–16, 기본 16. 설정 파일에 값이 없는 기존 사용자도 16 MiB가 된다. 명시적으로 값을 둔 사용자는 그 값을 유지한다.
- **relay (laymux-server)**: `TUNNEL_HTTP_REQUEST_BYTES_LIMIT` 기본값과 prod 환경을 24 MiB(25,165,824 B)로 올린다. 브라우저 경로와 Android binary 경로 모두 이 값을 쓴다. 두 경로 모두 body를 흘려보내므로 relay 메모리는 늘지 않는다. 구 Android JSON route의 2 MiB 상한은 그대로 둔다.
- **desktop 미러와 tunnel**:
  - `CLOUD_RELAY_HTTP_REQUEST_BYTES_LIMIT`와 Android E2E relay 미러를 24 MiB로 올린다. 노출되는 relay 상한은 브라우저·Android 모두 17 MiB(MiB 내림)이고, host 최대 16 MiB를 구속하지 않는다.
  - tunnel의 요청·stream pending 상한은 24 MiB에서 유도한다.
  - socket pending 상한은 최대 크기 E2E 업로드 4개에 브라우저 요청 하나를 더한 값으로, ADR-0352 구현과 같은 식을 쓴다.
  - Android E2E body 상한, Direct 버리기 상한, plaintext 상한은 모두 상한 상수에서 자동으로 따라온다.
- **Android native bridge**: body 문자열 상한(`MAX_REMOTE_ATTACHMENT_BYTES`)을 16 MiB 기준으로 올린다.
- **첨부 cache quota**: "최대 크기 첨부 64개"를 그대로 두면 기본값 16 MiB에서 1 GiB가 된다. 대신 "최대 크기 첨부 16개"(기본 256 MiB)로 바꾼다. 파일 수 상한 1024와 7일 정리는 그대로다.
- **배포 순서**: relay의 prod 환경(SSM, Terraform)과 코드를 먼저 바꾸고 24 MiB가 실제로 적용됐는지 확인한 뒤 desktop·앱을 릴리스한다. desktop 미러가 relay 실제 값보다 크면 relay 쪽 413이 먼저 나타나므로 이 순서를 지킨다.
- **호환성**: compat 번호는 올리지 않는다.
  - 구 앱(3.0.0)과 신 desktop 조합에서 10 MiB를 넘는 첨부는 앱의 bridge 상한에서 오류로 거절된다. 조용한 실패가 아니고 큰 첨부에만 해당하므로 ADR-0172의 비호환 기준에 들지 않는다.
  - 신 앱과 구 desktop 조합은 desktop이 광고하는 상한(최대 10 MiB) 안에서 동작한다.

## Alternatives Considered

- **기본값만 10 MiB로**: relay를 바꾸지 않아도 되지만 사용자가 요청한 16 MiB에 못 미친다.
- **relay 상한을 22 MiB처럼 딱 맞게**: wrapper slack이나 envelope 형식이 조금만 바뀌어도 다시 넘친다. 24 MiB는 16 MiB 첨부의 두 경로(약 21.4 MiB)에 여유를 둔다.
- **cache quota를 64× 그대로**: 기본 설정에서 디스크 1 GiB까지 쌓일 수 있다. 첨부는 CLI가 곧 읽고 7일 뒤 정리되는 임시 파일이므로 256 MiB면 충분하다.
- **compat 번호 증가**: 큰 첨부 하나 때문에 모든 사용자에게 앱·desktop 동시 업데이트를 다시 강제한다. 불일치 조합의 증상이 명시적 오류이므로 필요 없다.

## Consequences

- 설정을 바꾸지 않아도 웹·Android·Direct 모두 16 MiB까지 첨부할 수 있다.
- relay egress는 큰 첨부를 보내는 만큼만 늘고, relay 메모리는 요청 크기와 무관하다. desktop은 세션 검증 전에 host 상한(기본 약 21.4 MiB)까지 버퍼한다. ADR-0227 5(a)와 ADR-0351의 host 상한 버퍼 원칙은 그대로이고 기본값만 커진다.
- prod relay 변경은 Terraform 환경 변경(Infrastructure workflow plan/apply)과 애플리케이션 배포가 함께 필요하다.
- 구 앱 사용자는 10 MiB를 넘는 첨부에서 오류를 보고, 앱을 업데이트하면 해결된다.
- 테스트: settings 범위·기본값, 상한 산술(16 MiB 첨부가 24 MiB 안에 드는지, relay 노출 상한 17 MiB), cache quota, Android bridge 상한, 문서의 범위 표기.
