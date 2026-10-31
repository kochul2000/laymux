# 0368. 훅 helper 비교에서 Windows PE의 빌드 식별 메타데이터를 제외한다

- Status: Accepted
- Date: 2026-10-31
- Source: 사용자 보고(훅 내용이 같은 앱 업데이트에서도 갱신 안내), 실제 v3.8.1/v3.8.2 설치 파일 비교, [ADR-0289](0289-agent-hook-update-notification.md), [api-contracts §10](../architecture/api-contracts.md)
- 관계: ADR-0289의 helper 전체 바이트 비교만 확장한다. 검사 시점·캐시·설치 소유권·등록 명령 비교는 유지한다.

## Context

Windows v3.8.1과 v3.8.2의 훅 소스·의존성에는 변경이 없고 실행 코드도 동일하다. 실행 파일의 COFF/Debug Directory 빌드 시각과 PDB GUID 23바이트만 달랐지만 기존 전체 바이트 비교는 `helper_outdated`를 반환한다. 같은 두 릴리스의 WSL helper는 바이트까지 동일하다. 앱 버전이나 파일 존재만으로 최신 여부를 판단하면 실제 코드 변경·손상도 놓칠 수 있다.

문제의 범위는 동일한 레이아웃의 PE helper에 들어가는 비실행 빌드 식별자다. 서로 다른 컴파일러가 생성한 코드를 의미적으로 동등하다고 판정하거나, ELF 및 모든 PE 디버그 형식을 정규화하는 것은 비목표다.

## Decision

**검증된 x86-64 PE32+ helper에서 COFF 및 Debug Directory의 시각과 RSDS PDB GUID·age만 비교에서 제외하고, 나머지 바이트는 계속 일치해야 한다.**

- 동봉된 helper만 제외 범위의 정본으로 삼는다. 설치 파일이 주장하는 포인터로 제외 범위를 정하지 않는다. 파일 길이·헤더·섹션·디렉터리·포인터·RSDS signature와 PDB 경로는 계속 비교한다.
- PE/Optional Header와 섹션의 유계 범위, 중첩 없는 raw/RVA 매핑, 읽기 전용·비실행 debug 테이블과 payload, RSDS 구조를 모두 확인한 경우에만 예외를 적용한다. 해석 실패·미지원 형식·모호한 범위는 전체 바이트 비교로 돌아간다. ELF·일반 파일 비교는 바뀌지 않는다.
- 기존 64 MiB 파일 상한과 일반 파일·symlink 거부를 유지한다. 동봉 파일 읽기도 상한 안에서 수행하고, 설치 파일은 작은 chunk로 읽는다. 검사 중 파일 길이 변경이나 I/O 오류는 최신으로 합성하지 않고 기존 warning/unknown 정책을 따른다.
- 원본 실행 파일을 수정하거나 파일의 시각을 맞추지 않는다. 저장된 source fingerprint 또는 임의의 앱 버전 문자열로 실행 파일 비교를 대체하지 않는다. 현재 등록 명령·이벤트·누락·외부 사용자 훅 보존 정책은 유지한다.

## Alternatives Considered

- 앱 버전 또는 수동 helper 버전 비교: 무관한 앱 버전 상승에 묶이거나 helper 변경 시 버전 올리기를 누락할 수 있다.
- 소스 fingerprint만 비교: 실제 설치 파일의 코드·데이터 변경과 손상을 검증하지 못한다.
- Windows 재현 가능한 빌드만 도입: 기존 설치 파일의 비결정적 메타데이터와 비교하는 문제는 남는다. 추후 빌드 개선으로 별도 검토할 수 있다.
- `.rdata`/debug 영역 전체 제외: 실행 시 사용하는 상수·설정과 구조 변경을 놓칠 수 있어 선택하지 않는다.

## Consequences

빌드 시각·PDB 식별자만 달라진 Windows 재빌드에서 갱신 안내가 반복되지 않는다. 실행 코드·상수·PE 구조·레이아웃 또는 미지원 메타데이터가 달라지면 보수적으로 갱신을 요구한다. 제한된 PE 판독 책임과 bounded source buffer 비용이 추가된다.

이 수정 자체는 helper의 실행 코드를 바꾸므로 최초 적용 때 기존 helper 갱신이 필요할 수 있다. 그 이후에도 실제 코드 변경과 등록 명령 변경은 계속 갱신 대상이며, 모든 향후 앱 업데이트의 훅 갱신 안내를 없애는 정책은 아니다.

검증은 메타데이터만 다른 설치 상태의 안내 억제, 코드·상수·구조 변경 감지, 위조된 설치 파일 포인터, 잘못된/중첩/초과 범위의 엄격 비교 복귀, ELF 보존, 검사 중 파일·설정 불변성을 포함한다. 실제 공개 v3.8.1/v3.8.2 helper 파일 쌍도 검증한다. 재현 가능한 빌드나 다른 PE 형식을 지원할 때 제외 필드를 다시 검토한다. 앱 설정·API 스키마·마이그레이션은 없으며 버전 영향은 patch다.

형식 정본: [Microsoft PE Format](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format), [Microsoft PDB/CodeView 정의](https://github.com/microsoft/microsoft-pdb/blob/master/include/cvinfo.h).
