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
  /** Forget the lease on the first `/file-viewer/list`, the way an owner
   *  transition does, so that read is rejected on capability grounds. */
  leaseDiesOnFirstList?: boolean;
  /** Never answer the first heartbeat, standing in for the request that was in
   *  flight when the tab froze and whose connection no longer exists. */
  firstHeartbeatHangs?: boolean;
};

type MockState = {
  claims: number;
  heartbeats: number;
  statusProbes: number;
  /** Set once the host has forgotten the lease this tab holds. */
  leaseDead: boolean;
  /** Directory reads the host actually served. */
  listings: number;
};

async function installMocks(page: Page, options: MockOptions = {}) {
  const state: MockState = {
    claims: 0,
    heartbeats: 0,
    statusProbes: 0,
    leaseDead: false,
    listings: 0,
  };

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
      if (options.firstHeartbeatHangs && state.heartbeats === 1) {
        return new Promise<void>(() => {});
      }
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
      if (options.leaseDiesOnFirstList && !state.leaseDead && state.claims === 1) {
        // The owner transition that forgets the lease is the same event that
        // revokes the capability, so this read is the one that discovers it.
        state.leaseDead = true;
      }
      // The host binds the capability to the current lease: a stale one fails
      // closed, and only a fresh claim can mint a usable pair.
      const capability = await route.request().headerValue("x-laymux-remote-file-viewer");
      if (state.leaseDead || capability !== `viewer-${state.claims}`) {
        return route.fulfill({ status: 403, json: { error: CAPABILITY_ERROR } });
      }
      state.listings += 1;
      return route.fulfill({
        json: { path: "/home/user", parent: null, entries: [], truncated: false },
      });
    }
    return route.fulfill({ json: {} });
  });

  return state;
}

/** The cadence `startHeartbeat` picks: `min(5s, max(1s, timeout / 3))`. */
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Connect with the periodic heartbeat suppressed.
 *
 * Both specs are about *what discovers a dead lease*. Left running, the ordinary
 * heartbeat interval discovers it on its own within 5s and every assertion below
 * would also hold on the unfixed client — the specs would pass while testing
 * nothing. Dropping just that one interval leaves every other timer real, so a
 * heartbeat that arrives afterwards can only come from an explicit probe.
 */
async function connect(page: Page) {
  await page.addInitScript((intervalMs) => {
    const original = window.setInterval;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
      timeout === intervalMs
        ? 0
        : original(handler, timeout, ...rest)) as typeof window.setInterval;
  }, HEARTBEAT_INTERVAL_MS);
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#exit")).toBeEnabled();
  await expect(page.locator("#fileExplorerHeader")).toBeVisible();
}

test("a capability rejection re-validates the lease instead of reading as a file error", async ({
  page,
}) => {
  const state = await installMocks(page, { leaseDiesOnFirstList: true });
  await connect(page);
  expect(state.claims).toBe(1);
  const probesAfterConnect = state.statusProbes;
  const heartbeatsAfterConnect = state.heartbeats;

  // With the interval suppressed, only the failing read itself can start the
  // recovery.
  await page.locator("#fileExplorerHeader").click();

  // The rejection is answered by asking who owns the lease, and the dead lease
  // enters the ordinary reclaim path: a second claim, a fresh capability.
  await expect.poll(() => state.statusProbes).toBeGreaterThan(probesAfterConnect);
  await expect.poll(() => state.claims).toBe(2);
  expect(state.listings).toBe(0);
  expect(state.heartbeats).toBe(heartbeatsAfterConnect);

  // The overlay belongs to the loss path, so the raw host message never becomes
  // the user's explanation and the closed overlay is not left over it.
  await expect(page.locator("#fileViewerMessage")).not.toContainText(CAPABILITY_ERROR);
  await expect(page.locator("#fileViewerOverlay")).toBeHidden();

  // What recovery has to be worth: the same gesture works on the reclaimed
  // lease, with the capability that claim minted.
  await expect(page.locator("#fileExplorerHeader")).toBeVisible();
  await page.locator("#fileExplorerHeader").click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user");
  expect(state.listings).toBe(1);
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

  // With the interval suppressed, a heartbeat can only come from the visibility
  // resume.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect.poll(() => state.heartbeats).toBeGreaterThan(heartbeatsAfterConnect);
  // The 409 is a lease answer: control is dropped and re-claimed, which is what
  // makes the file surface work again.
  await expect.poll(() => state.claims).toBe(2);
});

test("a resume retires a heartbeat that is still in flight", async ({ page }) => {
  const state = await installMocks(page, { firstHeartbeatHangs: true });
  await connect(page);
  expect(state.heartbeats).toBe(0);

  // The first probe reaches the host and is never answered: this is the stalled
  // flight a frozen tab leaves behind.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => state.heartbeats).toBe(1);

  state.leaseDead = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  // `heartbeat()` de-duplicates itself, so without retiring the stalled flight
  // this probe never leaves the page: recovery then waits out that request's own
  // abort timeout (4s) plus the retry delay (1s). The budget here is what makes
  // this spec about retiring the flight rather than about recovering eventually.
  await expect.poll(() => state.heartbeats, { timeout: 1500 }).toBe(2);
  await expect.poll(() => state.claims).toBe(2);
});
