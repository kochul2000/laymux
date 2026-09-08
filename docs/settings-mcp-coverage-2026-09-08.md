# 설정 MCP 전수 대조 — 2026-09-08

ADR: [0236](adr/0242-settings-mcp-scoped-discovery-and-remote-device-bridge.md).

## 실행 맥락과 변경 범위

설정 작업은 `get_settings_context`로 시작한다. 현재 human-control owner가 Local이면 PC, 유효한 Remote이면 그 기기의 로컬 설정을 기본값으로 삼는다. 에이전트 프로세스가 실행되는 OS나 localhost 주소는 사용자 표면을 나타내지 않는다. 대상이 명시되면 사용자 지시가 우선한다. 연결 전환·만료는 미확정이며 다른 범위로 대체하지 않는다. 변경 직전 다시 조회한다.

이 맥락은 현재 입력 제어 표면이며 개별 채팅 메시지의 출처 증명은 아니다. 외부 채팅·백그라운드 자동화가 제어 표면과 다른 경우에는 대상을 확인해야 한다. 현재의 단일 controller 모델에서 다른 기기나 오프라인 기기를 임의 선택하지 않는다.

| 범위 | 예 | 도구 |
| --- | --- | --- |
| PC 앱 | 테마·PC 터미널·프로필·단축키·위젯 | describe/get/validate/update_settings |
| Remote 기기 로컬 | 폰트·플로팅·입력바·숨김 줄 수·탐색 제외 | describe/get/validate/update_remote_settings |
| PC의 Remote 연결 정책 | heartbeat 유예·IP/Origin·첨부 상한·위젯 공개 | PC settings의 /remote |

## 발견한 누락과 보완

- Remote의 플로팅 전체 표시, 패드별 활성·크기·불투명도·위치, 일반 버튼 목록을 추가했다. 전체 끄기는 개별 배치를 보존한다.
- 입력바의 main/expanded × left/center/right 배치, 사용자 등록 특수키, Claude/Codex/Grok별 입력영역 숨김 줄 수, pane/workspace 탐색 제외를 추가했다.
- PC 위젯 options는 자유 JSON이라 기존 schema만으로는 세부 옵션을 발견하기 어려웠다. 이제 `describe_settings(/widgets)`가 실제 frontend 레지스트리의 옵션·기본값·범위를 함께 제공한다.
- PC CWD 동기화의 자유 JSON에도 send/receive·workspace/dock 구조와 상속 의미를 설명했다.
- Remote의 중첩 객체와 배열은 해당 최상위 키의 **전체 교체**다. 호스트와 기기에서 타입·범위·필수 필드·알 수 없는 키·사용자 키 참조·중복 배치를 검사한다. 변경하지 않은 배열 항목을 보존해야 한다.
- 사용자 등록 특수키는 설정된 전송 문자열이다. 저장만으로 실행하지 않으며, 입력 초안·과거 입력 기록을 읽지 않는다.

## Remote 저장소 전체 대조

코드의 `const ...Key = "laymux.remote.…"` 선언 17개를 대조했다. MCP는 총 44개 최상위 설정 키를 제공한다. 객체/배열 내부 개별 필드는 이 수에 포함하지 않았다.

| 저장 키 접미사 | 지원/분류 |
| --- | --- |
| displaySettings | 표시·스크롤·snapshot 예산·버튼 배율·선택 핸들 17개 모두 지원 |
| keybar | 행/정렬/순서, 사용자 키, 플로팅 전체·패드·버튼 지원. expanded는 마지막 펼침 상태이며 설정 스키마에서 제외 |
| inputMode | direct/composer 지원 |
| composerHistoryPopup | 지원 |
| composerAutocomplete | 지원 |
| composerHideAgentInput | 지원 |
| composerHiddenAgentInputLines | Claude/Codex/Grok 3종 모두 지원 |
| composerHistoryScope | global/workspace/pane 지원 |
| widgetStrip | 기기 선호 지원. PC /remote/widgets 공개 정책과 구분 |
| edgeSwipeDrawers | 지원 |
| swipeCloseDrawers | 지원 |
| spatialExcludedPaneIds | 지원. workspace 제외와 일치하도록 변경 |
| spatialExcludedWorkspaceIds | 지원. 소속 터미널 pane 제외와 일치하도록 변경 |
| token | 인증 비밀. 기기 설정으로 노출하지 않음 |
| resumeToken | 연결 복구 capability. 기기 설정으로 노출하지 않음 |
| autoConnect | 재연결 의사·lifecycle 내부 상태. 설정 스위치가 아님 |
| settingsPanel | 마지막 방문 탭. 환경설정 변경 대상이 아님 |

Remote 설정 화면의 Input bar/Floating/Composer/Display를 위 항목과 대조했다. App 탭의 업데이트 설치·PWA 설치는 설정값이 아니라 lifecycle/사용자 제스처 작업이다. Android 네이티브 호스트 등록·pairing·OS 권한도 이 브라우저 기기 설정 계약에 포함되지 않는다.

## PC 설정 화면 대조

Startup·Font·Defaults·Profile·Color schemes·Paste·Terminal·Interface·Remote connection·Workspaces·Claude·Codex·Grok·File explorer·Viewer·Issue reporter·GitHub·Widgets·Memo·Keybindings의 영속 설정은 아래 스키마에 포함된다. Update의 채널은 /update, 설치·재시작 버튼은 별도 lifecycle 작업이다. 런타임 Remote 활성화·token 발급·cloud 등록 상태도 일반 영속 필드 변경과 구분한다.

다음은 실제 dev MCP의 섹션별 설명을 모두 조회해 얻은 **305개 필드 경로 패턴**이다. 배열 원소의 개수와 무관하게 구조 하나를 세며, 자유 JSON은 그 경계에서 센다. 따라서 305개 모두를 일반 patch로 쓸 수 있다는 뜻은 아니다.

일반 patch 읽기 전용 경로: /workspaces, /layouts, /docks, /workspaceDisplayOrder, /remote/cloudInstanceId, /remote/cloudTunnelUrl, /remote/cloudServerBaseUrl, /terminal/composerStarredEntries. 구조·등록·사용자 콘텐츠의 소유 API/화면을 사용해야 하며 임의 설정 쓰기로 우회하지 않는다. PC 메뉴 글자 크기 자체는 현재 설정에 없다.

| 섹션 | 경로 수 | 섹션 쓰기 |
| --- | ---: | --- |
| /appearance | 5 | 지원(하위 읽기 전용 예외 있음) |
| /claude | 9 | 지원(하위 읽기 전용 예외 있음) |
| /codex | 6 | 지원(하위 읽기 전용 예외 있음) |
| /colorSchemes | 21 | 지원(하위 읽기 전용 예외 있음) |
| /controlBar | 2 | 지원(하위 읽기 전용 예외 있음) |
| /defaultProfile | 1 | 지원(하위 읽기 전용 예외 있음) |
| /dock | 3 | 지원(하위 읽기 전용 예외 있음) |
| /docks | 11 | 구조 상태: 일반 patch 불가 |
| /exit | 3 | 지원(하위 읽기 전용 예외 있음) |
| /fileExplorer | 11 | 지원(하위 읽기 전용 예외 있음) |
| /github | 11 | 지원(하위 읽기 전용 예외 있음) |
| /grok | 5 | 지원(하위 읽기 전용 예외 있음) |
| /issueReporter | 9 | 지원(하위 읽기 전용 예외 있음) |
| /keybindings | 2 | 지원(하위 읽기 전용 예외 있음) |
| /language | 1 | 지원(하위 읽기 전용 예외 있음) |
| /layouts | 8 | 구조 상태: 일반 patch 불가 |
| /memo | 12 | 지원(하위 읽기 전용 예외 있음) |
| /notifications | 1 | 지원(하위 읽기 전용 예외 있음) |
| /paneClear | 4 | 지원(하위 읽기 전용 예외 있음) |
| /paste | 8 | 지원(하위 읽기 전용 예외 있음) |
| /power | 2 | 지원(하위 읽기 전용 예외 있음) |
| /profileDefaults | 24 | 지원(하위 읽기 전용 예외 있음) |
| /profiles | 29 | 지원(하위 읽기 전용 예외 있음) |
| /remote | 23 | 지원(하위 읽기 전용 예외 있음) |
| /syncCwdDefaults | 4 | 지원(하위 읽기 전용 예외 있음) |
| /terminal | 25 | 지원(하위 읽기 전용 예외 있음) |
| /update | 1 | 지원(하위 읽기 전용 예외 있음) |
| /usage | 21 | 지원(하위 읽기 전용 예외 있음) |
| /viewOrder | 1 | 지원(하위 읽기 전용 예외 있음) |
| /viewer | 6 | 지원(하위 읽기 전용 예외 있음) |
| /widgets | 16 | 지원(하위 읽기 전용 예외 있음) |
| /workspaceDisplayOrder | 1 | 구조 상태: 일반 patch 불가 |
| /workspaceSelector | 10 | 지원(하위 읽기 전용 예외 있음) |
| /workspaces | 9 | 구조 상태: 일반 patch 불가 |

## 전체 경로 목록

`{index}`는 실제 배열 인덱스로 바꾼다. 현재 값이 없는 optional은 null로 읽을 수 있으며, 실제 없는 배열 원소는 현재 값 조회 시 오류다.

### /appearance

- `/appearance/font/face`
- `/appearance/font/size`
- `/appearance/font/weight`
- `/appearance/themeId`
- `/appearance/uiFontFamily`

### /claude

- `/claude/command`
- `/claude/restoreSession`
- `/claude/sessionLimitAutoResume`
- `/claude/sessionLimitResumeDelaySeconds`
- `/claude/sessionLimitResumeMessage`
- `/claude/sessionMaxAgeHours`
- `/claude/statusMessageDelimiter`
- `/claude/statusMessageMode`
- `/claude/syncCwd`

### /codex

- `/codex/command`
- `/codex/restoreSession`
- `/codex/sessionMaxAgeHours`
- `/codex/statusMessageDelimiter`
- `/codex/statusMessageMode`
- `/codex/transcriptScrollEnabled`

### /colorSchemes

- `/colorSchemes/{index}/background`
- `/colorSchemes/{index}/black`
- `/colorSchemes/{index}/blue`
- `/colorSchemes/{index}/brightBlack`
- `/colorSchemes/{index}/brightBlue`
- `/colorSchemes/{index}/brightCyan`
- `/colorSchemes/{index}/brightGreen`
- `/colorSchemes/{index}/brightPurple`
- `/colorSchemes/{index}/brightRed`
- `/colorSchemes/{index}/brightWhite`
- `/colorSchemes/{index}/brightYellow`
- `/colorSchemes/{index}/cursorColor`
- `/colorSchemes/{index}/cyan`
- `/colorSchemes/{index}/foreground`
- `/colorSchemes/{index}/green`
- `/colorSchemes/{index}/name`
- `/colorSchemes/{index}/purple`
- `/colorSchemes/{index}/red`
- `/colorSchemes/{index}/selectionBackground`
- `/colorSchemes/{index}/white`
- `/colorSchemes/{index}/yellow`

### /controlBar

- `/controlBar/defaultMode`
- `/controlBar/hoverIdleSeconds`

### /defaultProfile

- `/defaultProfile`

### /dock

- `/dock/arrowFocusPane`
- `/dock/arrowNav`
- `/dock/persistState`

### /docks

- `/docks/{index}/activeView`
- `/docks/{index}/panes/{index}/h`
- `/docks/{index}/panes/{index}/id`
- `/docks/{index}/panes/{index}/view`
- `/docks/{index}/panes/{index}/w`
- `/docks/{index}/panes/{index}/x`
- `/docks/{index}/panes/{index}/y`
- `/docks/{index}/position`
- `/docks/{index}/size`
- `/docks/{index}/views/{index}`
- `/docks/{index}/visible`

### /exit

- `/exit/interruptRounds`
- `/exit/interruptTerminals`
- `/exit/settleMs`

### /fileExplorer

- `/fileExplorer/copyOnSelect`
- `/fileExplorer/extensionViewers/{index}/command`
- `/fileExplorer/extensionViewers/{index}/extensions/{index}`
- `/fileExplorer/extensionViewers/{index}/profile`
- `/fileExplorer/fontFamily`
- `/fileExplorer/fontSize`
- `/fileExplorer/paddingBottom`
- `/fileExplorer/paddingLeft`
- `/fileExplorer/paddingRight`
- `/fileExplorer/paddingTop`
- `/fileExplorer/shellProfile`

### /github

- `/github/defaultTab`
- `/github/fontFamily`
- `/github/fontSize`
- `/github/hideDraftPulls`
- `/github/labelMaxCount`
- `/github/labelMaxWidth`
- `/github/numberColor`
- `/github/refreshSeconds`
- `/github/showAuthor`
- `/github/showDraftBadge`
- `/github/showUpdated`

### /grok

- `/grok/command`
- `/grok/restoreSession`
- `/grok/sessionMaxAgeHours`
- `/grok/statusMessageDelimiter`
- `/grok/statusMessageMode`

### /issueReporter

- `/issueReporter/fontFamily`
- `/issueReporter/fontSize`
- `/issueReporter/fontWeight`
- `/issueReporter/paddingBottom`
- `/issueReporter/paddingLeft`
- `/issueReporter/paddingRight`
- `/issueReporter/paddingTop`
- `/issueReporter/repositories/{index}`
- `/issueReporter/shell`

### /keybindings

- `/keybindings/{index}/command`
- `/keybindings/{index}/keys`

### /language

- `/language`

### /layouts

- `/layouts/{index}/id`
- `/layouts/{index}/name`
- `/layouts/{index}/panes/{index}/h`
- `/layouts/{index}/panes/{index}/viewConfig`
- `/layouts/{index}/panes/{index}/viewType`
- `/layouts/{index}/panes/{index}/w`
- `/layouts/{index}/panes/{index}/x`
- `/layouts/{index}/panes/{index}/y`

### /memo

- `/memo/copyOnSelect`
- `/memo/fontFamily`
- `/memo/fontSize`
- `/memo/fontWeight`
- `/memo/indentSize`
- `/memo/paddingBottom`
- `/memo/paddingLeft`
- `/memo/paddingRight`
- `/memo/paddingTop`
- `/memo/paragraphCopy/enabled`
- `/memo/paragraphCopy/minBlankLines`
- `/memo/tripleClickParagraphSelect`

### /notifications

- `/notifications/dismiss`

### /paneClear

- `/paneClear/busyPolicy`
- `/paneClear/interruptRounds`
- `/paneClear/settleMs`
- `/paneClear/shellCommand`

### /paste

- `/paste/imageDir`
- `/paste/largeWarning`
- `/paste/linkJoin`
- `/paste/pathQuote`
- `/paste/pathSeparator`
- `/paste/removeIndent`
- `/paste/removeLineBreak`
- `/paste/smart`

### /power

- `/power/keepAwake`
- `/power/keepAwakeWhenBusy`

### /profileDefaults

- `/profileDefaults/antialiasingMode`
- `/profileDefaults/bellStyle`
- `/profileDefaults/closeOnExit`
- `/profileDefaults/colorScheme`
- `/profileDefaults/cursorBlink`
- `/profileDefaults/cursorShape`
- `/profileDefaults/font/face`
- `/profileDefaults/font/size`
- `/profileDefaults/font/weight`
- `/profileDefaults/maxOutputCacheKB`
- `/profileDefaults/opacity`
- `/profileDefaults/padding/bottom`
- `/profileDefaults/padding/left`
- `/profileDefaults/padding/right`
- `/profileDefaults/padding/top`
- `/profileDefaults/restoreCwd`
- `/profileDefaults/restoreOutput`
- `/profileDefaults/scrollbackLines`
- `/profileDefaults/snapOnInput`
- `/profileDefaults/stabilizeInteractiveCursor`
- `/profileDefaults/suppressApplicationTitle`
- `/profileDefaults/syncCwd`
- `/profileDefaults/syncCwd/receive`
- `/profileDefaults/syncCwd/send`

### /profiles

- `/profiles/{index}/antialiasingMode`
- `/profiles/{index}/bellStyle`
- `/profiles/{index}/closeOnExit`
- `/profiles/{index}/colorScheme`
- `/profiles/{index}/commandLine`
- `/profiles/{index}/cursorBlink`
- `/profiles/{index}/cursorShape`
- `/profiles/{index}/font/face`
- `/profiles/{index}/font/size`
- `/profiles/{index}/font/weight`
- `/profiles/{index}/hidden`
- `/profiles/{index}/name`
- `/profiles/{index}/opacity`
- `/profiles/{index}/padding/bottom`
- `/profiles/{index}/padding/left`
- `/profiles/{index}/padding/right`
- `/profiles/{index}/padding/top`
- `/profiles/{index}/restoreCwd`
- `/profiles/{index}/restoreOutput`
- `/profiles/{index}/scrollbackLines`
- `/profiles/{index}/snapOnInput`
- `/profiles/{index}/stabilizeInteractiveCursor`
- `/profiles/{index}/startingDirectory`
- `/profiles/{index}/startupCommand`
- `/profiles/{index}/suppressApplicationTitle`
- `/profiles/{index}/syncCwd`
- `/profiles/{index}/syncCwd/receive`
- `/profiles/{index}/syncCwd/send`
- `/profiles/{index}/tabTitle`

### /remote

- `/remote/allowedIps/{index}`
- `/remote/allowedOrigins/{index}`
- `/remote/androidBackgroundLeaseSeconds`
- `/remote/attachmentAllowAllExtensions`
- `/remote/attachmentExtraExtensions/{index}`
- `/remote/attachmentMaxMib`
- `/remote/authToken`
- `/remote/autoMobileModeMinWidth`
- `/remote/bindAddress`
- `/remote/cloudAccessMode`
- `/remote/cloudAutoReconnect`
- `/remote/cloudEnabled`
- `/remote/cloudInstanceId`
- `/remote/cloudServerBaseUrl`
- `/remote/cloudTunnelUrl`
- `/remote/customHosts/{index}`
- `/remote/enabled`
- `/remote/heartbeatTimeoutSeconds`
- `/remote/preferredHost`
- `/remote/relayBaseUrl`
- `/remote/serveTerminalFont`
- `/remote/tailscaleOnly`
- `/remote/widgets`

### /syncCwdDefaults

- `/syncCwdDefaults/dock/receive`
- `/syncCwdDefaults/dock/send`
- `/syncCwdDefaults/workspace/receive`
- `/syncCwdDefaults/workspace/send`

### /terminal

- `/terminal/advertiseTrueColor`
- `/terminal/composerAutocomplete`
- `/terminal/composerHistoryPopup`
- `/terminal/composerHistoryScope`
- `/terminal/composerStarredEntries/{index}/label`
- `/terminal/composerStarredEntries/{index}/send`
- `/terminal/composerStarredEntries/{index}/value`
- `/terminal/copyOnSelect`
- `/terminal/fastScrollSensitivity`
- `/terminal/outputActivityBurst/threshold`
- `/terminal/outputActivityBurst/throttleMs`
- `/terminal/outputActivityBurst/volumeThresholdBytes`
- `/terminal/outputActivityBurst/volumeWindowMs`
- `/terminal/outputActivityBurst/windowMs`
- `/terminal/parserAdmission/focusedShare`
- `/terminal/parserAdmission/hiddenShare`
- `/terminal/parserAdmission/visibleShare`
- `/terminal/pathLinkActivation`
- `/terminal/pathLinkEnabled`
- `/terminal/pathLinkMaxLength`
- `/terminal/pathLinkOsOpenConfirm`
- `/terminal/pathLinkOsOpenEnabled`
- `/terminal/scrollSensitivity`
- `/terminal/showScrollToBottomButton`
- `/terminal/urlLinkActivation`

### /update

- `/update/channel`

### /usage

- `/usage/claude/colors/pace`
- `/usage/claude/colors/track`
- `/usage/claude/colors/used`
- `/usage/claude/configDirs/{index}`
- `/usage/claude/profile`
- `/usage/claude/refreshSeconds`
- `/usage/claude/visibleRows/{index}`
- `/usage/codex/colors/pace`
- `/usage/codex/colors/track`
- `/usage/codex/colors/used`
- `/usage/codex/configDirs/{index}`
- `/usage/codex/profile`
- `/usage/codex/refreshSeconds`
- `/usage/codex/visibleRows/{index}`
- `/usage/grok/colors/pace`
- `/usage/grok/colors/track`
- `/usage/grok/colors/used`
- `/usage/grok/configDirs/{index}`
- `/usage/grok/profile`
- `/usage/grok/refreshSeconds`
- `/usage/grok/visibleRows/{index}`

### /viewOrder

- `/viewOrder/{index}`

### /viewer

- `/viewer/fontFamily`
- `/viewer/fontSize`
- `/viewer/paddingBottom`
- `/viewer/paddingLeft`
- `/viewer/paddingRight`
- `/viewer/paddingTop`

### /widgets

- `/widgets/fontFamily`
- `/widgets/fontSize`
- `/widgets/overflow`
- `/widgets/statusLine/enabled`
- `/widgets/statusLine/left/{index}/id`
- `/widgets/statusLine/left/{index}/options`
- `/widgets/statusLine/left/{index}/type`
- `/widgets/statusLine/right/{index}/id`
- `/widgets/statusLine/right/{index}/options`
- `/widgets/statusLine/right/{index}/type`
- `/widgets/topBar/left/{index}/id`
- `/widgets/topBar/left/{index}/options`
- `/widgets/topBar/left/{index}/type`
- `/widgets/topBar/right/{index}/id`
- `/widgets/topBar/right/{index}/options`
- `/widgets/topBar/right/{index}/type`

### /workspaceDisplayOrder

- `/workspaceDisplayOrder/{index}`

### /workspaceSelector

- `/workspaceSelector/confirmDestructiveActions`
- `/workspaceSelector/display/activity`
- `/workspaceSelector/display/environment`
- `/workspaceSelector/display/minimap`
- `/workspaceSelector/display/path`
- `/workspaceSelector/display/result`
- `/workspaceSelector/hiddenAutoCloseSeconds`
- `/workspaceSelector/lastInputMode`
- `/workspaceSelector/pathEllipsis`
- `/workspaceSelector/sortOrder`

### /workspaces

- `/workspaces/{index}/id`
- `/workspaces/{index}/layoutId`
- `/workspaces/{index}/name`
- `/workspaces/{index}/panes/{index}/h`
- `/workspaces/{index}/panes/{index}/id`
- `/workspaces/{index}/panes/{index}/view/type`
- `/workspaces/{index}/panes/{index}/w`
- `/workspaces/{index}/panes/{index}/x`
- `/workspaces/{index}/panes/{index}/y`

