// @effect-diagnostics nodeBuiltinImport:off - Local browser fixture.
import * as NodeHttp from "node:http";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { PrivacyEvidence } from "./PrivacyEvidence.ts";

describe("shared-browser privacy evidence", () => {
  let browser: Browser;
  let origin: string;
  const contexts: BrowserContext[] = [];
  const server = NodeHttp.createServer((request, response) => {
    if (request.url?.startsWith("/asset")) {
      response.end("ok");
      return;
    }
    response.setHeader("Set-Cookie", "server_only=secret; HttpOnly; SameSite=Lax; Path=/");
    response.end(
      '<script>localStorage.setItem("local-key","private-value");sessionStorage.setItem("session-key","private-value");fetch("/asset?token=secret")</script>',
    );
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const page = async () => {
    const context = await browser.newContext();
    contexts.push(context);
    return context.newPage();
  };

  it("includes HttpOnly cookies and requests from before navigation, without values or query secrets", async () => {
    const tab = await page();
    const capture = await PrivacyEvidence.start(tab, true);
    await Promise.all([
      tab.waitForResponse((response) => response.url().includes("/asset")),
      tab.goto(origin),
    ]);
    const result = await capture.read();
    expect(result.complete).toBe(true);
    expect(result.cookies).toContainEqual(
      expect.objectContaining({ name: "server_only", httpOnly: true }),
    );
    expect(result.requests).toContainEqual(expect.objectContaining({ url: `${origin}/asset` }));
    expect(result.storage[0]?.local).toContain("local-key");
    expect(result.storage[0]?.session).toContain("session-key");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private-value");
  });
  it("refuses shared/used tabs and preserves independent context state", async () => {
    const first = await page();
    await expect(PrivacyEvidence.start(first, false)).rejects.toThrow("fresh incognito");
    const capture = await PrivacyEvidence.start(first, true);
    await first.goto(origin);
    await expect(PrivacyEvidence.start(first, true)).rejects.toThrow("fresh incognito");
    const second = await page();
    const clean = await (await PrivacyEvidence.start(second, true)).read();
    expect(clean.cookies).toEqual([]);
    expect(clean.requests).toEqual([]);
    expect(clean.captureId).not.toBe((await capture.read()).captureId);
  });
  it("marks a removed cross-origin frame as a storage gap", async () => {
    const tab = await page();
    const capture = await PrivacyEvidence.start(tab, true);
    await tab.goto(origin);
    const otherOrigin = origin.replace("127.0.0.1", "localhost");
    await tab.locator("body").evaluate(async (body, url) => {
      const iframe = body.ownerDocument.createElement("iframe");
      iframe.sandbox.add("allow-scripts", "allow-same-origin");
      const loaded = new Promise<void>((resolve) =>
        iframe.addEventListener("load", () => resolve(), { once: true }),
      );
      iframe.src = url;
      body.append(iframe);
      await loaded;
      iframe.remove();
    }, otherOrigin);
    const result = await capture.read();
    expect(result.complete).toBe(false);
    expect(result.limitations.join(" ")).toContain("no longer present");
  });
  it("retains a storage gap after an additional context page closes", async () => {
    const tab = await page();
    const capture = await PrivacyEvidence.start(tab, true);
    const popup = await tab.context().newPage();
    await popup.close();
    const result = await capture.read();
    expect(result.complete).toBe(false);
    expect(result.limitations.join(" ")).toContain("additional context page");
  });
  it("marks oversized storage evidence incomplete and bounds the result", async () => {
    const tab = await page();
    const capture = await PrivacyEvidence.start(tab, true);
    await tab.goto(origin);
    await tab.evaluate(() => {
      for (let i = 0; i < 150; i++) localStorage.setItem("x".repeat(300) + i, "private");
    });
    const result = await capture.read();
    expect(result.complete).toBe(false);
    expect(result.limitations).toContain("Storage key limit reached.");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(48000);
  });
});
