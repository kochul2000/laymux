# 0189. 업데이트는 stable·beta 두 채널을 가지며 채널 매니페스트가 최신 릴리스의 단일 진실원이다

- Status: Proposed
- Date: 2026-08-21
- Source: 사용자 요구("테스트 버전을 먼저 따라가고 안정되면 정식으로 승격해 다른 사람이 따라가게", "설정으로 어느 채널을 따라갈지 선택할 수 있어야 한다", "PC·Android 둘 다") · [ADR-0174](0174-github-signed-desktop-self-update.md) · [ADR-0172](0172-android-e2e-compat-version-gate.md) · [architecture/api-contracts.md §10·§12·§13](../architecture/api-contracts.md)
- Extends: ADR-0174
- Corrects: ADR-0174 — 단일 stable endpoint(채널 매니페스트로 대체, `releases/latest`는 구버전 앱 전용 경로로 격하), `x.y.z` 전용 클라이언트 버전 계약, prerelease 데스크톱 번들 집합, prerelease tag의 느슨한 문자 집합 검사, prerelease에서 Android job을 실행하지 않는 정책과 그에 딸린 게시 게이트

## Context

ADR-0174는 PC 자기 갱신을 stable 하나로 좁혔다. 앱에는 `releases/latest/download/latest.json` 하나가 고정되어 있고, GitHub의 latest 지정이 stable 채널의 단일 진실원이다. 클라이언트는 최종 안전장치로 manifest `version`이 정확히 `x.y.z`이고 download URL의 tag가 `v?x.y.z`이며 두 값이 같은지 검사한다. release workflow는 prerelease 입력을 받지만 그 결과는 latest로 승격되지 않으므로 어떤 앱도 그것을 보지 않으며, Android job은 stable에서만 실행된다.

이제 배포자 자신이 새 버전을 먼저 쓰고 문제가 없을 때 나머지 사용자에게 풀고 싶다. 지금 구조에서는 그 요구를 만족시킬 수 없다. prerelease를 발행해도 앱이 보지 않고, 앱이 보게 하려고 latest로 승격하면 모든 사용자가 즉시 같은 빌드를 받는다. 즉 "먼저 받는 집단"과 "나중에 받는 집단"을 나눌 수단이 아예 없다.

수단을 만들려면 세 가지가 동시에 필요하다. 첫째, 앱이 자기가 따라갈 채널을 알아야 한다. 둘째, 각 채널의 "지금 최신"을 가리키는 안정된 주소가 있어야 한다. GitHub에는 최신 prerelease를 가리키는 고정 alias가 없다 — `releases/latest`는 정의상 `make_latest=true`인 릴리스 하나만 가리키고, 그것을 prerelease가 차지하면 stable 사용자가 테스트 빌드를 받는다. 셋째, 클라이언트의 좁은 `x.y.z` 계약을 채널별로 다시 정의해야 한다. 이 계약은 수동 발행 실수를 막는 방어선이므로 단순히 없앨 수 없고, 넓히더라도 채널마다 다른 형태만 허용해야 한다.

Android는 제약이 다르다. 앱에 자체 업데이트 경로가 없어 APK를 GitHub 릴리스에서 손으로 설치하고, versionCode는 `major*1_000_000 + minor*1_000 + patch`로 stable `x.y.z`만 인코딩할 수 있다. 테스트 빌드를 끼워 넣을 자리가 없고, 한 번 발행한 versionCode보다 낮은 값은 Android가 설치를 거부하므로 인코딩 변경은 되돌릴 수 없다. 또 ADR-0172의 compat version은 데스크톱과 앱이 한 릴리스로 함께 배포되는 하나의 계약이라는 전제 위에 있는데, 데스크톱만 자동으로 앞서 나가는 채널은 그 전제를 흔든다.

번들 형식도 force로 작용한다. RPM `Version` 필드는 `-`를 담을 수 없고 deb 버전 정렬 규칙은 semver prerelease 순서와 일치하지 않는다. 즉 prerelease 접미사를 붙인 버전은 현재 stable이 만드는 번들 집합 전체를 그대로 만들 수 없다.

범위는 Windows·Linux 데스크톱 자기 갱신의 채널 분리, 채널 선택 설정과 그것을 노출하는 표면, 채널별 릴리스 매니페스트 발행, prerelease Android APK 발행과 그 versionCode 인코딩이다. Android 앱의 자체 업데이트(매니페스트 조회·APK 다운로드·설치)와 그에 필요한 Android 채널 설정은 이 결정의 비목표이며, 신뢰 경계가 다르므로 별도 ADR로 정한다. delta update, 자동 무인 설치, rollback, 점진 롤아웃(비율 배포)도 비목표다.

## Decision

**Laymux 업데이트는 stable과 beta 두 채널을 가지고, 클라이언트가 따라갈 채널은 `settings.json`의 `update.channel`이, 각 채널의 최신 릴리스는 저장소 `release-channels` 브랜치에 커밋된 채널 매니페스트가 단일 진실원이다.**

### 채널 선택

- 채널은 `settings.json`의 `update.channel`이며 값은 `"stable"` 또는 `"beta"`, 기본값 `"stable"`, applyMode `live`다. 디스크의 `settings.json`이 SoT이므로 업데이트 확인은 매번 저장된 값을 읽고, 저장되지 않은 UI 초안은 확인 결과에 반영되지 않는다.
- 필드는 문자열로 모델링하고 알 수 없는 값은 런타임에서 stable로 해석한다. 저장 시에는 검증이 알 수 없는 값을 거절하되, 이미 파일에 들어 있는 값은 타입 오류로 만들지 않는다 — 채널 문자열 하나 때문에 설정 전체가 부분 복구 상태로 떨어지면 안 되고, 오독은 사용자를 테스트 빌드로 올리는 방향으로 기울지 않아야 한다.
- 채널을 바꾸는 표면은 데스크톱 Settings와 Automation(REST·MCP)의 일반 설정 patch뿐이다. Automation의 채널 변경 권한은 ADR-0174가 install에 부여한 것과 같은 등급 — IP allowlist를 통과한 로컬 자동화 주체는 이미 앱 제어권을 가진 trusted operator — 로 본다. Remote는 host 설정을 쓰는 표면이 아니므로 채널을 바꾸지 않고, snapshot에 실린 채널을 읽어 표시만 한다.
- 데스크톱 표면은 Settings ▸ Interface의 Update 그룹이며, beta를 고르면 안정성이 보장되지 않는 계열임을 그 자리에서 알린다. 업데이트가 있을 때만 나타나는 상단 action과 Remote의 업데이트 카드는 현재 채널을 함께 보여준다 — 어느 계열을 따라가는 중인지 모르면 사용자는 자기가 받은 버전을 해석할 수 없다.
- 채널 변경은 즉시 1회 확인을 트리거한다. 주기 확인은 6시간이므로 그것에만 의존하면 채널을 바꾼 사용자가 최대 6시간 동안 "후보 없음"만 본다.

### 채널 매니페스트

- 채널 매니페스트는 `release-channels` 브랜치의 `desktop-stable.json`·`desktop-beta.json`이며, 각 파일은 해당 채널 최신 릴리스의 Tauri updater manifest 전문이다. 앱은 `https://raw.githubusercontent.com/kochul2000/laymux/release-channels/desktop-<channel>.json`을 고정 endpoint로 삼는다. host·저장소·브랜치·파일명은 바이너리에 고정하며 설정으로 바꿀 수 없다.
- 이 브랜치는 릴리스 workflow만 쓰는 배포 산출물이며 소스 히스토리와 무관한 orphan 계보다. 사람이 직접 커밋하지 않는다.
- 브랜치를 만들 때 두 파일을 현재 stable 매니페스트로 시딩한다. 따라서 두 채널 모두 항상 유효한 매니페스트를 가지며, 첫 beta 발행 전에 채널을 beta로 바꾼 사용자도 stable 최신을 본다. **시딩은 게시보다 먼저 성공해야 한다** — 채널을 아는 빌드가 latest가 된 뒤에 시딩하면, 그 사이 올라온 설치본은 고정 endpoint에서 404를 받고 시딩이 실패하면 그 상태가 영구히 남는다. 그럼에도 매니페스트를 못 읽으면(삭제·404·파싱 실패) 업데이트 없음이 아니라 확인 오류로 취급해 `lastError`에 남긴다 — 배포 경로가 끊긴 것과 최신 상태를 같은 표시로 접으면 아무도 알아차리지 못한다.
- 매니페스트를 커밋하기 전에 workflow가 검증한다. manifest `version`이 발행 tag의 버전과 같고, 모든 `platforms` 항목의 URL이 `https://github.com/kochul2000/laymux/releases/download/<tag>/` 하위이며, 클라이언트가 소비하는 플랫폼 키(`windows-x86_64`·`linux-x86_64`)가 모두 존재해야 한다. 하나라도 어긋나면 커밋하지 않는다. 채널 갱신이 실패하면 릴리스는 게시된 채로 남고 채널은 옛 버전을 계속 가리킨다 — 부분 매니페스트가 채널에 노출되는 것보다 낫다.
- **beta 채널은 항상 stable 이상을 가리킨다.** 이 불변식을 무조건 덮어쓰기로 만들지 않는다. stable 발행은 `desktop-stable.json`을 갱신하고, `desktop-beta.json`은 발행 버전이 현재 beta 매니페스트 버전보다 높을 때만 함께 전진시킨다. prerelease 발행은 `desktop-beta.json`만 갱신한다. 두 파일 갱신은 한 커밋으로 원자적으로 이뤄지며, 중간 상태를 노출하지 않는다.
- **두 채널 모두 전진만 허용하되, 같은 버전 재실행은 no-op이다.** 채널 후퇴는 거절한다 — 클라이언트가 다운그레이드를 제안하지 않으므로 후퇴한 채널은 그 시점부터 사용자를 정지시킨다. 반대로 같은 릴리스로 job을 다시 돌리는 것은 성공해야 한다. ref 갱신이 서버에서 성공했는데 응답이 유실되면 재실행이 유일한 복구 수단이기 때문이다.
- **채널 전진성은 게시 전에 확인한다.** 채널 파일을 쓰는 시점에야 후퇴를 잡으면 낮은 버전이 이미 latest로 공개되어 레거시 endpoint가 그것을 내려주고, Android는 새 versionCode 인코딩이 옛 값보다 크다는 이유로 다운그레이드를 업그레이드로 받는다.
- 앱 config의 정적 endpoint는 `desktop-stable.json`으로 바꾼다. 런타임 주입이 채널을 결정하므로 정적 값은 stable 기본값과 같아야 하고, 사문화된 옛 주소를 남겨 "어느 것이 진짜인가"를 만들지 않는다.
- GitHub의 `latest` 지정은 계속 stable 릴리스에만 부여하고 `latest.json` asset 업로드도 유지한다. ADR-0174가 고정한 `releases/latest/download/latest.json`은 채널 도입 이전에 배포된 앱의 유일한 업데이트 경로이므로 계속 유효해야 한다. 마이그레이션 로직은 만들지 않는다. 이 레거시 경로는 채널을 아는 버전이 stable로 한 번 나간 뒤, 그보다 낮은 버전의 설치 기반이 없다고 판단할 수 있을 때 폐기를 재검토한다.

### 클라이언트 버전 계약

- 앱은 확인 시점에 채널을 읽어 그 채널의 endpoint를 updater에 주입한다. 채널마다 다른 빌드를 배포하지 않는다 — 같은 바이너리가 설정에 따라 다른 채널을 본다.
- stable 채널은 ADR-0174의 계약을 그대로 유지한다. manifest `version`은 정확히 `x.y.z`, download URL의 tag는 `v?x.y.z`, 두 버전은 같아야 한다.
- beta 채널은 `x.y.z` 또는 `x.y.z-beta.N`을 허용한다. `N`은 선행 0이 없는 1 이상의 십진수이고, tag도 같은 형태여야 하며 두 버전은 같아야 한다. `alpha`·`rc` 등 다른 prerelease 라벨과 build metadata(`+`)는 거절한다. 채널을 넓히는 것이 임의 문자열 수용으로 번지지 않게 계약을 좁게 유지한다.
- **beta는 자기가 만들지 않는 설치 형식에서 후보를 내지 않는다.** updater는 `{os}-{arch}-{installer}` 항목이 없으면 맨 `{os}-{arch}` 항목으로 폴백하므로, deb/rpm 설치본이 beta를 따라가면 AppImage를 받아 설치 단계에서 형식 오류로 실패한다. beta는 NSIS·AppImage만 만들기로 했으니, deb/rpm 설치본에서는 확인 자체를 거절하고 이유를 표시한다 — 받을 수 없는 후보를 제시했다가 설치에서 깨지는 것보다 낫다.
- 버전 비교는 updater 기본 semver 비교(`remote > current`)를 유지한다. 다운그레이드는 제안하지 않는다. 따라서 beta에서 stable로 채널을 되돌린 사용자는 stable이 자기 버전을 넘어설 때까지 업데이트가 없으며, 이 상태는 오류가 아니라 정상으로 표시한다.
- **채널 전환의 경계는 install 수락 시점이다.** 확인은 시작 시점의 채널을 기억하고, 완료 시점의 채널이 다르면 결과를 버린다(옛 채널 endpoint로 이미 떠난 요청의 응답이 후보로 남지 않는다). 발견된 후보는 그것을 찾은 채널과 함께 기록하고, 설치 요청 시 후보의 채널이 현재 채널과 다르면 거절하고 다시 확인하게 한다. 반대로 수락된 설치는 수락 시점의 채널·버전으로 완주한다 — ADR-0174가 정한 "수락된 signed install은 이후 취소하지 않는다"를 이 결정이 약화시키지 않는다. 설치 직전 재확인 결과가 사용자가 승인한 버전과 정확히 같아야 한다는 계약도 그대로다.
- 프로세스 전역 `UpdateStatus`가 현재 채널을 함께 실어 데스크톱·Automation·Remote가 같은 snapshot에서 채널을 읽는다. debug build의 self-update 비활성은 유지한다.

### 릴리스 workflow

- 앱 버전 문자열의 SoT는 `tauri.conf.json`이다. updater의 비교 기준이 그 값이므로, 릴리스 검증은 tag ↔ `tauri.conf.json` 일치에 더해 `Cargo.toml` 버전 일치까지 확인한다. 두 파일이 어긋난 릴리스는 표시 버전과 비교 버전이 다른 앱을 만든다.
- prerelease tag는 `v?x.y.z-beta.N`만 허용하고, stable과 동일하게 앱 버전과의 일치를 검사한다. ADR-0174는 prerelease tag를 느슨한 문자 집합으로만 검사했는데, prerelease가 실제 업데이트 입력이 되는 순간 그 느슨함은 클라이언트 tag 대조를 통과할 수 없는 릴리스를 만든다.
- prerelease 데스크톱 번들은 NSIS·AppImage와 updater artifact만 만든다. RPM은 `Version`에 `-`를 담을 수 없고 deb 버전 정렬은 semver prerelease 순서와 다르므로, 두 형식은 beta 채널에서 제공하지 않는다. stable은 현행 번들 집합을 유지한다.
- Android job은 prerelease에서도 실행하며, **게시 게이트는 stable과 같다**. 데스크톱과 Android job이 모두 성공해야 draft를 해제하고 채널 매니페스트를 갱신한다. 데스크톱만 앞서 게시하면 ADR-0172의 compat version이 올라간 beta에서 폰이 연결을 거부하는데 따라갈 APK가 아직 없는 구간이 생긴다. beta는 배포자 자신이 먼저 쓰는 채널이므로 발행 실패를 고치는 비용이 그 구간을 감수하는 비용보다 낮다.
- Android `versionName`은 tag 버전을 그대로 쓰고 `versionCode`는 `(major*1_000_000 + minor*1_000 + patch) * 10 + slot`으로 인코딩한다. `slot`은 beta `N`(1..8), stable 9다. Android versionCode 상한이 `2_100_000_000`이므로 이 인코딩이 감당하는 최대 major는 209이며, 여유를 두어 `major <= 200`, `minor <= 999`, `patch <= 999`, `N <= 8`을 넘으면 릴리스를 거절한다. 이는 현행 검사 `major < 2100`을 좁히는 정정이다.
- 이 인코딩은 기존 스킴이 발행한 모든 값보다 크고, 같은 `x.y.z`에서 stable(9)이 모든 beta(1..8)보다 크다. 따라서 기존 설치의 업그레이드가 성립하고, 같은 `x.y.z`의 beta에서 stable로 올라가는 승격 설치도 성립한다. 거부되는 것은 더 낮은 버전으로 내려가는 설치뿐이다. applicationId는 하나로 유지한다.
- 배포 계약의 판정 — versionCode 인코딩과 채널 매니페스트 검증 — 은 단위 테스트로 고정할 수 있어야 한다. workflow 인라인 스크립트만으로 판정하면 첫 오류가 실제 릴리스에서 드러난다.

## Alternatives Considered

- **롤링 tag `beta`를 만들고 `releases/download/beta/latest.json`을 endpoint로 쓴다.** 브랜치를 새로 만들지 않아 가장 단순하다. 그러나 tag에 버전이 없으므로 클라이언트의 tag↔manifest 버전 대조를 포기해야 하고, beta 릴리스의 tag 히스토리가 남지 않아 "어느 커밋이 beta.3이었나"를 릴리스만으로 되짚을 수 없다. 방어선을 유지하는 쪽을 택했다.
- **별도 beta 제품(다른 identifier·productName)으로 side-by-side 설치한다.** VS Code Insiders 류의 흔한 인사이더 구현이고, stable을 그대로 두고 beta를 병행 검증할 수 있어 "되돌릴 수 없음" 문제 전부를 회피한다. 그러나 설정·세션·페어링·Automation 포트 등 프로세스 상태가 두 벌로 갈라져 "테스트 계열에서 확인한 것이 정식에서도 같다"는 보장이 약해지고, 릴리스 산출물·서명·설치 안내가 이중화된다. 이번 요구는 한 설치본을 채널만 바꿔 따라가는 것이므로 단일 제품을 유지했다.
- **`app.laymux.com`이 GitHub API를 조회해 채널 매니페스트를 프록시한다.** 점진 롤아웃, 특정 버전 강제 고정, 채널 이동 집계까지 열린다. 대신 클라우드 서버 가용성이 데스크톱 업데이트 경로의 의존성이 되고, 서명 검증과 별개로 배포 계약을 서버 코드로 옮기게 된다. 현재 요구는 두 채널 분리뿐이므로 무서버 안을 택했다.
- **매니페스트를 브랜치가 아니라 고정 tag의 릴리스 asset으로 올린다.** raw 캐시 대신 릴리스 CDN을 쓰지만, 그 고정 릴리스를 매번 clobber해야 하고 "릴리스는 불변"이라는 현재 운영 전제를 깬다. 배포 산출물을 브랜치에 두면 변경 이력이 git으로 남는다.
- **앱이 GitHub API로 최신 prerelease를 직접 조회한다.** 브랜치도 서버도 필요 없다. 그러나 Tauri updater의 표준 manifest 계약 밖에서 asset 선택과 버전 판정을 다시 구현해야 하고, 인증 없는 API rate limit이 업데이트 확인 주기에 얹힌다. ADR-0174가 이미 같은 이유로 기각한 방향이다.
- **beta에 prerelease 접미사를 쓰지 않고 홀수 minor를 테스트 계열로 쓴다.** RPM·deb 제약과 Android versionCode 문제를 한 번에 피한다. 그러나 버전 문자열만 봐서는 그것이 테스트 빌드인지 알 수 없고, stable 채널이 홀수 minor를 실수로 승격하는 것을 클라이언트가 구조적으로 막을 수 없다. 버전에 채널을 드러내는 쪽이 잘못된 발행을 거절할 근거가 된다.
- **채널을 기기-로컬 상태로 저장한다.** 설정 동기화나 백업이 채널을 옮기지 않는다는 장점이 있다. 그러나 채널은 사용자가 명시적으로 고르고 계속 유지하는 구성이며, Automation·MCP에서 읽고 쓸 수 있어야 한다. 설정 스키마에 두는 쪽이 계약이 하나로 유지된다.
- **Android도 이번에 자체 업데이트를 붙인다.** 사용자 요구에는 폰도 채널을 따라간다는 기대가 있다. 그러나 APK 다운로드·해시 검증·`PackageInstaller` 설치·설치 권한은 데스크톱 updater와 다른 신뢰 경계이고, Play 배포로 전환하면 경로 자체가 폐기된다. 이번에는 beta APK 발행과 versionCode 자리 확보까지만 정하고 클라이언트는 후속 ADR로 분리했다.
- **beta 채널에서도 RPM·deb를 만든다.** 리눅스 테스트 사용자를 포괄하지만, 두 형식의 버전 규칙이 semver prerelease와 맞지 않아 버전 문자열을 변형해야 하고 그러면 클라이언트의 tag↔버전 대조가 깨진다. beta는 NSIS·AppImage로 한정했다.
- **stable 발행이 `desktop-beta.json`을 무조건 덮어쓴다.** 규칙이 더 단순하다. 그러나 beta가 더 높은 버전을 가리키는 동안 낮은 stable을 발행하면 beta 채널이 후퇴해 beta 후보가 사라진다. 전진만 허용하는 쪽이 "beta ≥ stable" 불변식을 규칙 자체로 보장한다.
- **prerelease는 데스크톱 job 성공만으로 게시하고 Android 실패는 APK 부재로 남긴다.** beta 회전이 빨라진다. 그러나 compat version이 올라간 beta에서 폰이 따라갈 APK 없이 연결을 거부하는 구간이 생기고, 그 구간의 길이는 다음 발행까지로 정해지지 않는다. 게이트를 stable과 같게 두었다.

## Consequences

- 배포자는 정식 사용자를 건드리지 않고 새 빌드를 먼저 받을 수 있고, 정식 승격 한 번으로 두 채널이 다시 합쳐진다. 채널 전환은 설정 한 줄이므로 재설치가 필요 없다.
- `release-channels` 브랜치가 새 배포 계약이 된다. 브랜치나 파일이 삭제·변조되면 업데이트 확인이 오류로 남는다. Tauri 서명 검증은 그대로이므로 임의 코드 실행으로는 이어지지 않지만 가용성 위험이 생기며, 브랜치 보호와 workflow 외 쓰기 금지가 운영 후속 작업이다.
- `raw.githubusercontent.com`은 짧은 캐시를 가지므로 발행 직후 몇 분간 옛 매니페스트가 응답할 수 있다. 업데이트 확인 주기(6시간)에 비하면 무해하지만 발행 직후 즉시 확인은 한 번 헛돌 수 있다.
- beta 채널 사용자는 RPM·deb를 받지 못한다. 리눅스에서 beta를 따라가려면 AppImage를 쓰거나 stable에 머물러야 한다.
- 데스크톱에서 beta에서 stable로 되돌리면 다음 정식이 자기 버전을 넘어설 때까지 업데이트가 없다. Android에서 같은 되돌림은 설치 자체가 거부되므로 재설치가 필요하고, 앱은 페어링 자료를 앱-프라이빗 저장소에 두고 `allowBackup="false"`이므로 **재설치는 페어링·연결 설정의 영구 소실**을 뜻한다. 같은 applicationId를 유지하기로 한 선택의 대가다.
- beta 데스크톱이 자동으로 앞서 나가므로 compat version이 올라간 릴리스에서는 폰이 beta APK를 손으로 설치할 때까지 연결이 거부된다. 게시 게이트가 APK 존재를 보장하지만 설치 시점은 사용자에게 달려 있고, 그 사이 폰 접속 단절을 수용한다. Android 자체 업데이트가 생기면 이 구간이 사라진다.
- Android versionCode 인코딩 변경은 되돌릴 수 없다. 이 결정 이후 발행한 값보다 낮은 코드로는 갱신할 수 없으므로, `patch`가 999에 접근하거나 버전당 beta가 8개를 넘어야 하면 새 ADR로 자리 배분을 다시 정해야 한다.
- prerelease tag 계약이 좁아지므로 이전에 통과했던 임의 문자열 tag(`nightly-…` 등)로는 더 이상 발행할 수 없다. 발행 절차가 `v?x.y.z-beta.N`으로 고정된다.
- `main`의 앱 버전이 beta 기간 동안 `x.y.z-beta.N`으로 유지되고, 승격 시 같은 커밋 계보에서 `x.y.z`로 올리는 커밋이 한 번 더 필요하다. 정식은 beta에서 검증한 바이너리를 복사하지 않고 같은 소스를 다시 빌드한다 — 버전 문자열이 산출물 파일명과 패키지 메타데이터에 박히므로 재사용이 불가능하다. 즉 정식 빌드는 beta에서 검증한 것과 같은 소스이되 같은 바이너리는 아니다.
- 레거시 `releases/latest` 경로를 유지하는 동안 stable 발행은 `latest.json` asset 업로드와 `make_latest=true`를 계속 지켜야 한다. 채널을 아는 버전이 충분히 퍼졌다고 판단할 때 폐기를 재검토한다.
- 문서 후속 작업: `docs/architecture/api-contracts.md` §10에 `update.channel` 설정 키, §12·§13의 update 응답에 채널 필드, 채널 매니페스트 발행 절차와 검증 스크립트의 위치를 같은 PR에서 갱신한다.
- 자동 검증은 채널별 버전·tag 계약, 진행 중 확인의 채널 세대 비교와 후보 무효화, 설정 스키마·검증·기본값·표면, versionCode 인코딩과 경계, 채널 매니페스트 검증 규칙을 포함한다. prerelease 번들이 실제로 만들어지는지와 채널 endpoint가 실제 업데이트를 성사시키는지는 첫 beta 발행에서 실측해야 한다.
