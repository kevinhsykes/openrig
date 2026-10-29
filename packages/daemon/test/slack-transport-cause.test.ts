// P41: a Slack transport failure records WHY (the fetch cause), and a post whose connect failed is repeated once.
import { describe, it, expect, vi } from "vitest";
import { callWebApi, describeTransportError, postChatMessage, type FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

/** What Node's fetch throws: a TypeError "fetch failed" whose cause carries the real reason. */
const fetchFailed = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });
const withCode = (code: string, message: string) => Object.assign(new Error(message), { code });
const rejecting = (errors: unknown[]) => {
  let i = 0;
  return { fetchImpl: (async () => { const e = errors[Math.min(i, errors.length - 1)]; i += 1; if (e instanceof Response) return e; throw e; }) as FetchImpl, calls: () => i };
};
const posted = () => Response.json({ ok: true, ts: "1728400000.000100" }, { status: 200 });

describe("describeTransportError (P41)", () => {
  it.each([
    ["a connect timeout", fetchFailed(withCode("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")), "fetch failed (cause: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)", "UND_ERR_CONNECT_TIMEOUT", true],
    ["a DNS failure", fetchFailed(withCode("EAI_AGAIN", "getaddrinfo EAI_AGAIN slack.com")), "fetch failed (cause: EAI_AGAIN: getaddrinfo EAI_AGAIN slack.com)", "EAI_AGAIN", true],
    ["a TLS failure", fetchFailed(withCode("CERT_HAS_EXPIRED", "certificate has expired")), "fetch failed (cause: CERT_HAS_EXPIRED: certificate has expired)", "CERT_HAS_EXPIRED", false],
    ["a reset while waiting for the answer", fetchFailed(withCode("ECONNRESET", "read ECONNRESET")), "fetch failed (cause: ECONNRESET: read ECONNRESET)", "ECONNRESET", false],
  ])("%s keeps its cause and says whether the request could have been sent", (_n, error, message, code, preSend) => {
    expect(describeTransportError(error)).toEqual({ message, code, preSend });
  });

  it("a plain error without a cause is just its message, and never counts as pre-send", () => {
    expect(describeTransportError(new Error("timeout after 15000ms"))).toEqual({ message: "timeout after 15000ms", code: null, preSend: false });
    expect(describeTransportError("boom")).toEqual({ message: "boom", code: null, preSend: false });
  });

  it("walks a nested cause and an AggregateError's members, bounded to three deep", () => {
    const aggregate = Object.assign(new Error("connect failed"), { errors: [withCode("ETIMEDOUT", "a"), withCode("ENETUNREACH", "b")] });
    const nested = fetchFailed(Object.assign(new Error("outer"), { code: "EOUTER", cause: Object.assign(new Error("inner"), { code: "EINNER", cause: Object.assign(new Error("deepest"), { code: "EDEEP", cause: withCode("TOOFAR", "never shown") }) }) }));
    expect(describeTransportError(fetchFailed(aggregate)).code).toBe("ETIMEDOUT");
    const text = describeTransportError(nested).message;
    expect(text).toContain("EOUTER: outer");
    expect(text).toContain("EDEEP: deepest");
    expect(text).not.toContain("TOOFAR");
  });

  it("a mixed pre-send and response-phase failure is NOT pre-send (fail safe against a double post)", () => {
    const mixed = fetchFailed(Object.assign(new Error("both"), { errors: [withCode("ECONNREFUSED", "x"), withCode("ECONNRESET", "y")] }));
    expect(describeTransportError(mixed).preSend).toBe(false);
  });

  it("strips control characters and bounds the length", () => {
    const hostile = fetchFailed(withCode("EWEIRD", "bad\u001b[31m\nline\u0007" + "x".repeat(2000)));
    const text = describeTransportError(hostile).message;
    expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(text.length).toBeLessThanOrEqual(400);
  });
});

describe("callWebApi records the cause (P41)", () => {
  it("stores code and message of the cause in the transport error, and the structured fields", async () => {
    const { fetchImpl } = rejecting([fetchFailed(withCode("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"))]);
    const r = await callWebApi("auth.test", "xoxb-fake", {}, fetchImpl, 1_000);
    expect(r).toMatchObject({ ok: false, status: 0, error: "web-api transport: fetch failed (cause: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)", transport: { code: "UND_ERR_CONNECT_TIMEOUT", preSend: true } });
  });
  it("an HTTP-level failure carries no transport field", async () => {
    const { fetchImpl } = rejecting([Response.json({ ok: false, error: "invalid_auth" }, { status: 200 })]);
    const r = await callWebApi("auth.test", "xoxb-fake", {}, fetchImpl, 1_000);
    expect(r.transport).toBeUndefined();
    expect(r.error).toBe("invalid_auth");
  });
});

describe("postChatMessage retries a failed connect once (P41)", () => {
  const post = (fetchImpl: FetchImpl, sleep = vi.fn(async () => {})) => ({ sleep, run: postChatMessage("xoxb-fake", { channel: "C1", text: "hello" }, fetchImpl, 1_000, sleep) });

  it("a transient connect failure is repeated once after a backoff and then posts", async () => {
    const { fetchImpl, calls } = rejecting([fetchFailed(withCode("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")), posted()]);
    const { sleep, run } = post(fetchImpl);
    expect(await run).toMatchObject({ ok: true, ts: "1728400000.000100" });
    expect(calls()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_500);
  });

  it("a failure that keeps failing is tried exactly twice, never looped, and keeps its cause", async () => {
    const { fetchImpl, calls } = rejecting([fetchFailed(withCode("EAI_AGAIN", "getaddrinfo EAI_AGAIN slack.com"))]);
    const { run } = post(fetchImpl);
    expect(await run).toMatchObject({ ok: false, status: 0, error: expect.stringContaining("EAI_AGAIN") });
    expect(calls()).toBe(2);
  });

  it.each([
    ["a TLS failure", fetchFailed(withCode("CERT_HAS_EXPIRED", "certificate has expired"))],
    ["a reset after the request may have been sent", fetchFailed(withCode("ECONNRESET", "read ECONNRESET"))],
    ["an unexplained failure", new TypeError("fetch failed")],
    ["our own timeout", new Error("timeout after 1000ms")],
  ])("%s is NOT retried: one attempt, no pause (it could have posted, or retrying cannot help)", async (_n, error) => {
    const { fetchImpl, calls } = rejecting([error]);
    const { sleep, run } = post(fetchImpl);
    expect(await run).toMatchObject({ ok: false, status: 0 });
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("an HTTP rejection from Slack is not retried by this rule", async () => {
    const { fetchImpl, calls } = rejecting([Response.json({ ok: false, error: "channel_not_found" }, { status: 200 })]);
    const { sleep, run } = post(fetchImpl);
    expect(await run).toMatchObject({ ok: false, error: "channel_not_found" });
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
