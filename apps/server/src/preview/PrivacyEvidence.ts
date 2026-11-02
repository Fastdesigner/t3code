// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Browser callbacks run outside Effect.
import * as NodeCrypto from "node:crypto";
import type { Page, Request } from "playwright-core";
import type { PreviewAutomationPrivacyResult } from "@t3tools/contracts";

const MAX_REQUESTS = 1000;
const MAX_BYTES = 48_000;

/** Bounded, value-free evidence from one fresh shared-browser context. */
export class PrivacyEvidence {
  private readonly captureId = NodeCrypto.randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly requests: Array<PreviewAutomationPrivacyResult["requests"][number]> = [];
  private overflow = false;
  private popupSeen = false;
  private requestBytes = 0;
  private readonly frameOrigins = new Set<string>();

  private readonly page: Page;

  private constructor(page: Page) {
    this.page = page;
    const observe = (request: Request) => {
      if (this.requests.length >= MAX_REQUESTS) {
        this.overflow = true;
        return;
      }
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return;
      // Consent evidence needs destinations, never query secrets or credentials.
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      const entry = {
        url: url.href,
        method: request.method(),
        resourceType: request.resourceType(),
        timestamp: new Date().toISOString(),
      };
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (url.href.length > 2048 || bytes > 4096 || this.requestBytes + bytes > MAX_BYTES / 2) {
        this.overflow = true;
        return;
      }
      this.requestBytes += bytes;
      this.requests.push(entry);
    };
    page.context().on("request", observe);
    const popup = () => {
      this.popupSeen = true;
    };
    page.context().on("page", popup);
    const origin = (frame: import("playwright-core").Frame) => {
      if (/^https?:/.test(frame.url())) this.frameOrigins.add(new URL(frame.url()).origin);
    };
    page.on("framenavigated", origin);
    page.once("close", () => {
      page.context().off("request", observe);
      page.context().off("page", popup);
      page.off("framenavigated", origin);
    });
  }

  static async start(page: Page, isolated: boolean) {
    if (
      !isolated ||
      page.url() !== "about:blank" ||
      page.context().pages().length !== 1 ||
      (await page.context().cookies()).length
    ) {
      throw new Error(
        "Privacy capture requires a fresh incognito tab at about:blank. Existing browser state is never cleared.",
      );
    }
    return new PrivacyEvidence(page);
  }

  async read(): Promise<PreviewAutomationPrivacyResult> {
    const limitations: string[] = [];
    if (this.popupSeen)
      limitations.push(
        "An additional context page was opened; its storage is outside this capture.",
      );
    if (this.overflow) limitations.push("Request limit reached; this capture is incomplete.");
    const storage: Array<PreviewAutomationPrivacyResult["storage"][number]> = [];
    const currentOrigins = new Set<string>();
    for (const frame of this.page.frames()) {
      if (!/^https?:/.test(frame.url())) continue;
      try {
        const entry = await frame.evaluate(() => {
          const local = Object.keys(localStorage),
            session = Object.keys(sessionStorage);
          const truncated =
            local.length > 100 ||
            session.length > 100 ||
            [...local, ...session].some((key) => key.length > 256);
          return {
            local: local.slice(0, 100).map((key) => key.slice(0, 256)),
            session: session.slice(0, 100).map((key) => key.slice(0, 256)),
            truncated,
          };
        });
        if (entry.truncated) limitations.push("Storage key limit reached.");
        const { truncated: _, ...record } = entry;
        const origin = new URL(frame.url()).origin;
        currentOrigins.add(origin);
        storage.push({ origin, ...record });
      } catch {
        limitations.push("Storage could not be read in a rendered frame.");
      }
    }
    if ([...this.frameOrigins].some((origin) => !currentOrigins.has(origin)))
      limitations.push(
        "A previously visited frame origin is no longer present; its session storage is unavailable.",
      );
    const cookies = (await this.page.context().cookies()).map(
      ({ name, domain, path, httpOnly, secure, sameSite, expires }) => ({
        name,
        domain,
        path,
        httpOnly,
        secure,
        sameSite,
        expires,
      }),
    );
    let budget = MAX_BYTES - this.requestBytes - 2048;
    const bounded = <T>(entries: T[]) =>
      entries.filter((entry) => {
        const bytes = Buffer.byteLength(JSON.stringify(entry));
        if (bytes > budget) {
          if (!limitations.includes("Evidence byte limit reached."))
            limitations.push("Evidence byte limit reached.");
          return false;
        }
        budget -= bytes;
        return true;
      });
    const cookieEvidence = bounded(cookies),
      storageEvidence = bounded(storage);
    return {
      captureId: this.captureId,
      startedAt: this.startedAt,
      capturedAt: new Date().toISOString(),
      isolated: true,
      complete: limitations.length === 0,
      limitations: [...new Set(limitations)],
      cookies: cookieEvidence,
      requests: [...this.requests],
      storage: storageEvidence,
    };
  }
}
