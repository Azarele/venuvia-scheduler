// Browser test of the whole UI: `npm run test:ui`.
// Starts its own dev server on a separate database (venuvia_uitest) with the scripted
// stand-in instead of a real AI (no key, deterministic), then clicks through:
// create → approve → change → approve → cancel → approve → Undo button → Retry after an
// AI error → reload (chat survives) → phone width (no sideways scrolling).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { resetDatabase, useIsolatedDatabase } from "../scripts/isolated-db.ts";

const PORT = Number(process.env.UI_TEST_PORT ?? 3199);
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  await useIsolatedDatabase("uitest");
  const { pool } = await import("../src/lib/db.ts");
  await resetDatabase(pool);
  await pool.end();

  server = spawn("node_modules/.bin/next", ["dev", "-p", String(PORT)], {
    env: { ...process.env, AI_PROVIDER: "scripted", NEXT_DIST_DIR: ".next-uitest", AI_USAGE_LOG: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so the whole server is stopped afterwards
  });
  let log = "";
  server.stdout!.on("data", (d) => (log += d));
  server.stderr!.on("data", (d) => (log += d));

  const deadline = Date.now() + 120_000;
  for (;;) {
    const ok = await fetch(`${BASE}/api/info`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`Dev server didn't start:\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 820 } });
  page.on("pageerror", (e) => assert.fail(`Browser error: ${e.message}`));
});

after(async () => {
  await browser?.close();
  if (server?.pid) process.kill(-server.pid, "SIGTERM");
});

const messages = () => page.locator(".msg").count();
async function waitForReply(before: number, atLeast: number) {
  await page.waitForFunction(([b, n]) => document.querySelectorAll(".msg").length >= b + n && !document.querySelector(".typing"), [before, atLeast], { timeout: 60_000 });
}
async function send(text: string) {
  const before = await messages();
  await page.fill(".composer textarea", text);
  await page.press(".composer textarea", "Enter");
  await waitForReply(before, 2);
}
async function clickAndWait(selector: string) {
  const before = await messages();
  await page.click(selector);
  await waitForReply(before, 1);
}
/** The side panel refreshes just after the chat reply, so wait for it (up to 10s). */
async function eventually(what: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for: ${what}`);
    await page.waitForTimeout(100);
  }
}
const lastAssistantText = () => page.locator(".msg.assistant .bubble").last().innerText();
const scheduleRows = () => page.locator(".booking").allInnerTexts();

test("create → change → cancel → undo → retry → reload, all through the UI", { timeout: 300_000 }, async () => {
  await page.goto(BASE, { timeout: 120_000 });
  await page.waitForSelector(".booking", { timeout: 60_000 });
  assert.equal((await scheduleRows()).length, 3, "demo data: Anna, Marta, Julia");

  // Create → approval card → Approve.
  await send("Create a booking for 2pm tomorrow under a random name");
  assert.equal(await page.locator(".approval.open .approval-title").innerText(), "New booking");
  assert.ok(await page.locator(".composer textarea").isDisabled(), "input is locked while a change waits");
  await clickAndWait(".approval.open .approval-actions button:first-child");
  assert.match(await lastAssistantText(), /^Done — booked \w+, .*14:00–15:00 \(booking #5\)/);
  await eventually("4 bookings in the schedule", async () => (await scheduleRows()).length === 4);

  // Change it to 4pm.
  await send("Change it to 4pm");
  assert.equal(await page.locator(".approval.open .approval-title").innerText(), "Change booking #5");
  await clickAndWait(".approval.open .approval-actions button:first-child");
  await eventually("booking #5 at 16:00", async () => (await scheduleRows()).some((r) => r.startsWith("16:00")));

  // Cancel Julia (red button), shown struck through as cancelled.
  await send("Cancel Julia's booking");
  assert.equal(await page.locator(".approval.open .approval-actions button:first-child").innerText(), "Approve cancellation");
  await clickAndWait(".approval.open .approval-actions button:first-child");
  await eventually("Julia shown as cancelled", async () => (await scheduleRows()).some((r) => r.includes("Julia") && /cancelled/i.test(r)));

  // Activity tab: three logged changes; the Undo button restores Julia.
  await page.click('.tabs button:has-text("Activity")');
  await eventually("3 activity entries", async () => (await page.locator(".activity li").count()) === 3);
  await clickAndWait('button:has-text("Undo last change")');
  assert.match(await page.locator(".approval.open .approval-title").innerText(), /^Undo last change to booking #3/);
  await clickAndWait(".approval.open .approval-actions button:first-child");
  assert.match(await lastAssistantText(), /booking #3 is restored/);
  await eventually("4 activity entries", async () => (await page.locator(".activity li").count()) === 4);
  await page.click('.tabs button:has-text("Schedule")');
  await eventually("Julia back to confirmed", async () => !(await scheduleRows()).some((r) => r.includes("Julia") && /cancelled/i.test(r)));

  // An AI error shows a Retry button; retrying replaces the failed attempt.
  await send("Get all bookings (simulate a timeout)");
  assert.equal(await page.locator(".msg.error").count(), 1);
  await page.click("button.retry");
  // Retry replaces the failed attempt rather than adding a message, so wait for the answer itself.
  await page.waitForFunction(() => !document.querySelector(".typing") && !document.querySelector(".msg.error") && /Here are your bookings/.test(document.querySelector(".messages")!.textContent ?? ""), null, { timeout: 60_000 });
  assert.equal(await page.locator(".msg.error").count(), 0, "error replaced by the retried answer");
  assert.match(await lastAssistantText(), /Here are your bookings/);

  // The chat survives a reload (stored in Postgres).
  const count = await messages();
  await page.reload();
  await page.waitForSelector(".booking");
  await page.waitForFunction((n) => document.querySelectorAll(".msg").length >= n, count);
  assert.equal(await messages(), count);

  // Phone width: everything fits without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px on a phone`);
});
