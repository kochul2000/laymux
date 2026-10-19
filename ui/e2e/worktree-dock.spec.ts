import { test, expect, type Page } from "@playwright/test";
import { TAURI_MOCK_SCRIPT } from "./tauri-mock";

async function openDock(page: Page, position = "right", size = 240, withTerminals = false) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.addInitScript(
    TAURI_MOCK_SCRIPT +
      `
    const baseInvoke = window.__TAURI_INTERNALS__.invoke;
    const root = 'D:/very-long-common-parent/repository/main';
    const entries = Array.from({length:11}, (_,i) => ({path:root+'/tree-'+i,head:'abc123',branch:'feature-'+i,isMain:i===0,bare:false,usage:[]}));
    if (${withTerminals}) entries[4].usage = [
      {terminalId:'terminal-pane-ws-other',paneId:'pane-ws-other',workspaceId:'ws-other',workspaceName:'Other',cwd:entries[4].path,kind:'live',agentType:'claude'},
      {terminalId:'terminal-pane-ws-default',paneId:'pane-ws-default',workspaceId:'ws-default',workspaceName:'Default',cwd:entries[4].path,kind:'saved',agentType:null},
      {terminalId:'background',paneId:null,workspaceId:null,workspaceName:null,cwd:entries[4].path,kind:'daemon',agentType:null},
    ];
    window.__dockWorktree = {hold:false,release:null};
    window.__TAURI_INTERNALS__.invoke = async function(cmd,args,options){
      if(cmd==='get_worktree_snapshot') {
        if(window.__dockWorktree.hold) await new Promise(resolve=>{window.__dockWorktree.release=resolve;});
        return {workingDir:root,repositoryPath:root,commonDir:root+'/.git',worktrees:entries};
      }
      if(cmd==='inspect_worktree') {
        const entry=entries.find(e=>e.path===args.path);
        return {worktree:entry,trackedChanges:entry===entries[2]?1:0,untrackedFiles:0,ignoredFiles:0,files:entry===entries[2]?[{kind:'tracked',path:'README.md'}]:[],filesTruncated:false,canRemove:entry!==entries[0]&&entry!==entries[2]&&!entry.usage.length,blockers:entry===entries[0]?['main']:entry===entries[2]?['tracked_changes']:entry.usage.length?['in_use']:[],usage:entry.usage,usageWarnings:[]};
      }
      const value=await baseInvoke(cmd,args,options);
      if(cmd==='load_settings'||cmd==='load_settings_validated') {
        const settings=cmd==='load_settings'?value:value.settings;
        settings.workspaces=['ws-default','ws-other'].map((id,i)=>({id,name:i?'Other':'Default',panes:[{id:'pane-'+id,x:0,y:0,w:1,h:1,view:{type:${JSON.stringify(withTerminals ? "TerminalView" : "EmptyView")},profile:'PowerShell'}}]}));
        settings.docks=[
          {position:'left',size:200,visible:true,activeView:'WorkspaceSelectorView',views:[],panes:[{id:'selector',x:0,y:0,w:1,h:1,view:{type:'WorkspaceSelectorView'}}]},
          {position:${JSON.stringify(position)},size:${size},visible:true,activeView:'WorktreeView',views:[],panes:[
            {id:'dock-worktrees',x:0,y:0,w:1,h:${position === "bottom" ? "1" : "1/3"},view:{type:'WorktreeView',repositoryPath:root,cwdReceive:false}},
            ${position === "bottom" ? "" : "{id:'dock-empty-1',x:0,y:1/3,w:1,h:1/3,view:{type:'EmptyView'}},{id:'dock-empty-2',x:0,y:2/3,w:1,h:1/3,view:{type:'EmptyView'}},"}
          ]},
        ];
      }
      return value;
    };
  `,
  );
  await page.goto("/", { waitUntil: "networkidle" });
  const view = page.locator('[data-testid="view-worktree"][data-pane-id="dock-worktrees"]');
  await expect(
    view.getByRole("button", { name: `정리 후보 ${withTerminals ? 8 : 9}`, exact: true }),
  ).toBeVisible();
  return view;
}

test("240px 3분할 dock에서 상세 동작과 필터를 유지하고 목록 위치로 복귀한다", async ({ page }) => {
  const view = await openDock(page);
  expect((await view.boundingBox())!.height).toBeLessThan(350);
  const row = view.locator('[data-worktree-path$="/tree-0"]');
  expect((await row.boundingBox())!.height).toBeLessThan(85);
  await expect(row).toContainText("tree-0");
  const list = view.getByTestId("worktree-list");
  await list.evaluate((e) => {
    e.scrollTop = 150;
  });
  const scroll = await list.evaluate((e) => e.scrollTop);
  await view
    .locator('[data-worktree-path$="/tree-4"]')
    .getByRole("button", { name: "상세", exact: true })
    .click();
  const detail = view.getByTestId("worktree-detail");
  await expect(detail.getByRole("button", { name: "새 터미널", exact: true })).toBeVisible();
  await expect(view.getByTestId("worktree-filters")).toBeVisible();
  await detail.getByRole("button", { name: "워크트리 제거", exact: true }).click();
  await expect(detail.getByRole("button", { name: "제거 확인", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "취소", exact: true })).toBeVisible();
  const viewBox = (await view.boundingBox())!;
  const confirmBox = (await detail
    .getByRole("button", { name: "제거 확인", exact: true })
    .boundingBox())!;
  expect(confirmBox.y + confirmBox.height).toBeLessThanOrEqual(viewBox.y + viewBox.height);
  await detail.getByRole("button", { name: "취소", exact: true }).click();
  await detail.getByRole("button", { name: "목록으로 돌아가기", exact: true }).click();
  expect(await list.evaluate((e) => e.scrollTop)).toBeCloseTo(scroll, 0);
});

test("메인은 첫 터미널로 이동하고 화살표는 별도 메뉴를 연다", async ({ page }) => {
  const view = await openDock(page, "right", 240, true);
  const row = view.locator('[data-worktree-path$="/tree-4"]');
  await row.locator("strong").click();
  await expect(view.getByTestId("worktree-detail")).toHaveCount(0);
  const move = row.getByRole("button", { name: "터미널로 이동", exact: true });
  await expect(move).toContainText("Other");
  await move.click();
  await expect(page.getByTestId("workspace-item-ws-other")).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("menu", { name: "터미널 선택" })).toHaveCount(0);
  await page.getByTestId("workspace-name-ws-default").click();
  const trigger = row.getByRole("button", { name: "터미널 3개", exact: true });
  await trigger.click();
  await expect(page.getByTestId("workspace-item-ws-default")).toHaveAttribute(
    "data-active",
    "true",
  );
  const menu = page.getByRole("menu", { name: "터미널 선택" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /백그라운드/ })).toBeDisabled();
  const menuBox = (await menu.boundingBox())!;
  const viewBox = (await view.boundingBox())!;
  expect(menuBox.x).toBeLessThan(viewBox.x);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1280);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole("menuitem", { name: /Other/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("workspace-item-ws-other")).toHaveAttribute("data-active", "true");
  await expect(view.getByTestId("worktree-detail")).toHaveCount(0);
});

test("고정 대상 dock은 workspace 전환과 갱신 중 상세 선택을 유지한다", async ({ page }) => {
  const view = await openDock(page);
  await view
    .locator('[data-worktree-path$="/tree-2"]')
    .getByRole("button", { name: "상세", exact: true })
    .click();
  await expect(view.getByRole("button", { name: "변경 · README.md", exact: true })).toBeVisible();
  await page.getByTestId("workspace-name-ws-other").click();
  await expect(view.getByRole("button", { name: "변경 · README.md", exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __dockWorktree: { hold: boolean } }).__dockWorktree.hold = true;
  });
  await view.getByRole("button", { name: "워크트리 새로고침", exact: true }).click();
  await expect(view.getByTestId("worktree-detail")).toBeVisible();
  await expect(view.getByRole("button", { name: /전체 11/ })).toBeVisible();
  await expect(view.getByRole("button", { name: /정리 후보.*검사 중/ })).toBeVisible();
  await expect(view.getByRole("button", { name: "워크트리 제거", exact: true })).toBeDisabled();
  await page.waitForFunction(
    () => !!(window as unknown as { __dockWorktree: { release: unknown } }).__dockWorktree.release,
  );
  await page.evaluate(() => {
    const fixture = (
      window as unknown as { __dockWorktree: { hold: boolean; release: () => void } }
    ).__dockWorktree;
    fixture.hold = false;
    fixture.release();
  });
  await expect(view.getByRole("button", { name: "변경 · README.md", exact: true })).toBeVisible();
});

test("하단 200px dock에서는 목록과 상세를 나란히 놓고 동작을 화면에 남긴다", async ({ page }) => {
  const view = await openDock(page, "bottom", 200);
  await view
    .locator('[data-worktree-path$="/tree-2"]')
    .getByRole("button", { name: "상세", exact: true })
    .click();
  const list = (await view.getByTestId("worktree-list").boundingBox())!;
  const detail = (await view.getByTestId("worktree-detail").boundingBox())!;
  expect(detail.x).toBeGreaterThanOrEqual(list.x + list.width - 1);
  const open = (await view
    .getByTestId("worktree-detail")
    .getByRole("button", { name: "새 터미널", exact: true })
    .boundingBox())!;
  const remove = (await view
    .getByRole("button", { name: "워크트리 제거", exact: true })
    .boundingBox())!;
  const bounds = (await view.boundingBox())!;
  expect(open.y).toBeGreaterThanOrEqual(bounds.y);
  expect(remove.y + remove.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  expect(await view.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
});

test("좁은 dock의 키보드 탐색은 상세와 원래 목록 행 사이에서 이어진다", async ({ page }) => {
  const view = await openDock(page);
  const row = view.locator('[data-worktree-path$="/tree-4"]');
  const detailButton = row.getByRole("button", { name: "상세", exact: true });
  await detailButton.focus();
  await page.keyboard.press("Enter");
  const close = view.getByRole("button", { name: "목록으로 돌아가기", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detailButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    view
      .locator('[data-worktree-path$="/tree-5"]')
      .getByRole("button", { name: "새 터미널", exact: true }),
  ).toBeFocused();
});
