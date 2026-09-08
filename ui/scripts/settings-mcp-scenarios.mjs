import assert from "node:assert/strict";

const pcRequest =
  "터미널 공통 글자 크기는 18px, 일반 본문 16px, 밝은 GitHub 테마. 작업 중일 때만 절전 방지. 선택 자동복사를 끄고, 파일 경로 붙여넣기는 줄바꿈과 따옴표 사용. 새 워크스페이스 단축키 Ctrl+Shift+N, 다른 단축키 보존.";

export const scenarios = [
  {
    id: "pc",
    scope: "pc",
    prompt:
      pcRequest +
      " 상단바 오른쪽에 Codex 사용량 위젯을 하나 추가하되 기존 위젯은 보존해. 막대와 텍스트 둘 다, 막대 너비72·사용량 높이6·경과 높이2. 메뉴 글자 크기도16으로 가능한지 확인하되 미지원이면 대체 설정은 바꾸지 마.",
    check(pc, remote, originalPc, originalRemote) {
      checkPc(pc, originalPc);
      assert.deepEqual(
        remote.settings,
        originalRemote.settings,
        "PC 요청은 Remote 기기를 바꾸지 않아야 합니다.",
      );
      const before = originalPc.widgets.topBar.right;
      const added = pc.widgets.topBar.right.filter(
        (item) => !before.some((old) => old.id === item.id),
      );
      assert.equal(added.length, 1);
      assert.equal(added[0].type, "codexUsage");
      assert.deepEqual(added[0].options, {
        display: "both",
        barWidth: 72,
        barHeight: 6,
        elapsedHeight: 2,
      });
      for (const widget of before)
        assert(
          pc.widgets.topBar.right.some((item) => JSON.stringify(item) === JSON.stringify(widget)),
        );
      assert.deepEqual(pc.remote, originalPc.remote);
    },
  },
  {
    id: "remote",
    scope: "remoteDevice",
    prompt:
      "터미널 글자20, 입력창18, 메뉴16으로. 한 손가락 스크롤은 현재 두 배, 휠2·빠른휠6·두 손가락7로. 입력창 모드로 바꾸고 자동완성은 끄고 Tab 과거입력은 켜고 기록 공유는 워크스페이스별로. 원래 에이전트 입력은 숨기고 숨길 줄은 Claude5·Codex6·Grok3. 입력창 비활성/포커스/입력 중 불투명도는40/70/90%. 위젯바와 양방향 패널 스와이프는 꺼줘. 다음 출력 가져오기 예산16KiB. 넓은 화면 탐색 고정은 켜고 너비320·최소 화면너비640으로. 플로팅은 켜고 커서 방향패드와 pane/알림패드도 모두 켜줘. 방향패드는80px·50%·가로90%세로80% 위치, 탐색패드는72px·70%·가로10%세로80%. 메뉴 액션 플로팅 버튼을 하나 추가해(64px·100%·가로85%세로30%). 기존 버튼은 보존해. 사용자 특수키도 하나 추가해: 라벨은 확인, Tab 문자 전송. 새 키와 키보드 액션을 입력바 기본행 왼쪽 끝으로 옮기고 다른 액션의 상대 순서는 보존해. 순회 탐색의 pane·워크스페이스 제외 목록은 비워줘.",
    check(pc, remote, originalPc, originalRemote) {
      const { settings } = remote;
      for (const [key, value] of Object.entries({
        terminalFontSize: 20,
        composerFontSize: 18,
        menuFontSize: 16,
        touchScrollSensitivity: originalRemote.settings.touchScrollSensitivity * 2,
        scrollSensitivity: 2,
        fastScrollSensitivity: 6,
        twoFingerScrollSensitivity: 7,
        inputMode: "composer",
        composerAutocomplete: false,
        composerHistoryPopup: true,
        composerHistoryScope: "workspace",
        composerHideAgentInput: true,
        composerHiddenClaudeLines: 5,
        composerHiddenCodexLines: 6,
        composerHiddenGrokLines: 3,
        composerIdleOpacity: 40,
        composerFocusedOpacity: 70,
        composerActiveOpacity: 90,
        widgetStrip: false,
        edgeSwipeDrawers: false,
        swipeCloseDrawers: false,
        snapshotMaxKib: 16,
        navigationPinned: true,
        navigationWidth: 320,
        navigationPinCutoff: 640,
        floatingEnabled: true,
        floatingDpadEnabled: true,
        floatingNavPadEnabled: true,
        floatingDpadSize: 80,
        floatingDpadOpacity: 0.5,
        floatingDpadX: 0.9,
        floatingDpadY: 0.8,
        floatingNavPadSize: 72,
        floatingNavPadOpacity: 0.7,
        floatingNavPadX: 0.1,
        floatingNavPadY: 0.8,
      }))
        assert.equal(settings[key], value, key);
      assert.deepEqual(settings.spatialExcludedPaneIds, []);
      assert.deepEqual(settings.spatialExcludedWorkspaceIds, []);
      const addedKeys = settings.inputBarUserKeys.filter(
        (key) => !originalRemote.settings.inputBarUserKeys.some((old) => old.id === key.id),
      );
      assert.equal(addedKeys.length, 1);
      assert.equal(addedKeys[0].label, "확인");
      assert.equal(addedKeys[0].seq, "\t");
      assert.deepEqual(
        new Set(settings.inputBarZones.main.left.slice(0, 2)),
        new Set(["keyboard", `soft:${addedKeys[0].id}`]),
      );
      for (const [row, segments] of Object.entries(originalRemote.settings.inputBarZones))
        for (const [segment, ids] of Object.entries(segments)) {
          assert.deepEqual(
            settings.inputBarZones[row][segment].filter(
              (id) => !["keyboard", `soft:${addedKeys[0].id}`].includes(id),
            ),
            ids.filter((id) => id !== "keyboard"),
          );
        }
      const buttons = settings.floatingButtons.filter(
        (button) => !originalRemote.settings.floatingButtons.some((old) => old.id === button.id),
      );
      assert.equal(buttons.length, 1);
      assert.deepEqual(
        { ...buttons[0], id: null },
        { id: null, actionId: "menu", enabled: true, size: 64, opacity: 1, x: 0.85, y: 0.3 },
      );
      for (const key of [
        "profileDefaults",
        "appearance",
        "power",
        "terminal",
        "paste",
        "keybindings",
        "widgets",
        "remote",
      ])
        assert.deepEqual(pc[key], originalPc[key], `Remote 요청은 PC ${key}를 보존해야 합니다.`);
    },
  },
  {
    id: "mixed",
    scope: "remoteDevice",
    prompt:
      "PC 설정은 다음과 같이 바꿔줘: " +
      pcRequest +
      " 지금 보는 화면에서는 터미널22·메뉴17로 하고 플로팅 전체를 꺼줘. 개별 플로팅 구성은 보존해. 그리고 호스트의 Remote 연결 끊김 유예는60초, 첨부 상한5MiB, 위젯 공개는 꺼줘. 기기의 위젯바 선호 자체는 그대로 두고 PC 연결 정책만 바꾸는 거야.",
    check(pc, remote, originalPc, originalRemote) {
      checkPc(pc, originalPc);
      assert.equal(pc.remote.heartbeatTimeoutSeconds, 60);
      assert.equal(pc.remote.attachmentMaxMib, 5);
      assert.equal(pc.remote.widgets, false);
      assert.deepEqual(remote.settings, {
        ...originalRemote.settings,
        terminalFontSize: 22,
        menuFontSize: 17,
        floatingEnabled: false,
      });
    },
  },
];

function checkPc(pc, original) {
  assert.equal(pc.profileDefaults.font.size, 18);
  assert.equal(pc.appearance.font.size, 16);
  assert.equal(pc.appearance.themeId, "github-light");
  assert.equal(pc.appearance.uiFontFamily, original.appearance.uiFontFamily);
  assert.equal(pc.power.keepAwake, false);
  assert.equal(pc.power.keepAwakeWhenBusy, true);
  assert.equal(pc.terminal.copyOnSelect, false);
  assert.equal(pc.paste.pathSeparator, "newline");
  assert.equal(pc.paste.pathQuote, true);
  assert(
    pc.keybindings.some((item) => item.command === "workspace.new" && item.keys === "Ctrl+Shift+N"),
  );
  for (const binding of original.keybindings.filter((item) => item.command !== "workspace.new"))
    assert(pc.keybindings.some((item) => JSON.stringify(item) === JSON.stringify(binding)));
}
