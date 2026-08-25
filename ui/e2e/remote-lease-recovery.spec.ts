import { expect, test, type Page } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

/**
 * Lease recovery on the Remote page (ADR-0204).
 *
 * The FileViewer capability is issued per lease and the host drops it on every
 * owner transition, so a lease that died while this tab was away turns every
 * file request into a 403 the page used to render as a file-level error. These
 * specs pin the two halves of the fix: a control-grounds failure re-validates
 * ownership, and a returning tab probes the lease it kept instead of waiting for
 * the heartbeat interval.
 */

const navigation = {
  activeWorkspace: null,
  workspaces: [],
  docks: [],
  terminals: [],
  workspaceSelector: { display: {}, pathEllipsis: "start" },
  notifications: [],
  unreadNotificationCount: 0,
};

const CAPABILITY_ERROR = "remote file viewer capability is required or invalid";

type MockOptions = {
  /** Answer `/file-viewer/list` with the host's capability rejection. */
  listRejectsWithCapabilityError?: boolean;
};

type MockState = {
  claims: number;
  heartbeats: number;
  statusProbes: number;
  /** Set once the host has forgotten the lease this tab holds. */
  leaseDead: boolean;
};

async function installMocks(page: Page, options: MockOptions = {}) {
  const state: MockState = { claims: 0, heartbeats: 0, statusProbes: 0, leaseDead: false };

  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      state.claims += 1;
      // A successful claim always mints a fresh capability, so a reclaim is what
      // makes the file surface usable again.
      state.leaseDead = false;
      return route.fulfill({
        json: {
          active: true,
          leaseId: `lease-${state.claims}`,
          resumeToken: `resume-${state.claims}`,
          fileViewerToken: `viewer-${state.claims}`,
          heartbeatTimeoutSeconds: 45,
        },
      });
    }
    if (url.pathname === "/remote/v1/session/status") {
      state.statusProbes += 1;
      return route.fulfill({
        json: state.leaseDead
          ? { active: false, leaseId: null }
          : { active: true, leaseId: `lease-${state.claims}` },
      });
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      state.heartbeats += 1;
      if (state.leaseDead) {
        return route.fulfill({
          status: 409,
          json: { error: "remote controller lease is not active" },
        });
      }
      return route.fulfill({ json: { active: true } });
    }
    if (url.pathname === "/remote/v1/navigation") {
      return route.fulfill({ json: navigation });
    }
    if (url.pathname === "/remote/v1/file-viewer/list") {
      if (options.listRejectsWithCapabilityError) {
        // The host forgets the lease at the same moment it rejects the read —
        // exactly what an owner transition does.
        state.leaseDead = true;
        return route.fulfill({ status: 403, json: { error: CAPABILITY_ERROR } });
      }
      return route.fulfill({
        json: { path: "/home/user", parent: null, entries: [], truncated: false },
      });
    }
    return route.fulfill({ json: {} });
  });

  return state;
}

async function connect(page: Page) {
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#exit")).toBeEnabled();
  await expect(page.locator("#fileExplorerHeader")).toBeVisible();
}

test("a capability rejection re-validates the lease instead of reading as a file error", async ({
  page,
}) => {
  const state = await installMocks(page, { listRejectsWithCapabilityError: true });
  await connect(page);
  expect(state.claims).toBe(1);

  await page.locator("#fileExplorerHeader").click();

  // The rejection is answered by asking who owns the lease, and the dead lease
  // enters the ordinary reclaim path: a second claim, a fresh capability.
  await expect.poll(() => state.statusProbes).toBeGreaterThan(0);
  await expect.poll(() => state.claims).toBe(2);

  // The overlay belongs to the loss path now, so the raw host message never
  // becomes the user's explanation.
  await expect(page.locator("#fileViewerMessage")).not.toContainText(CAPABILITY_ERROR);
  await expect(page.locator("#fileExplorerHeader")).toBeVisible();
});

test("a returning tab probes the lease it kept without waiting for the heartbeat interval", async ({
  page,
}) => {
  const state = await installMocks(page);
  await connect(page);
  const heartbeatsAfterConnect = state.heartbeats;

  // The host forgot this lease while the tab was frozen. Nothing has told the
  // page yet — no heartbeat could run.
  state.leaseDead = true;

  // Timers stay stopped for the rest of the spec, so any heartbeat that arrives
  // can only have come from the visibility resume, never from the 5s interval.
  await page.clock.install();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect.poll(() => state.heartbeats).toBeGreaterThan(heartbeatsAfterConnect);
  // The 409 is a lease answer: control is dropped and re-claimed, which is what
  // makes the file surface work again.
  await expect.poll(() => state.claims).toBe(2);
});
