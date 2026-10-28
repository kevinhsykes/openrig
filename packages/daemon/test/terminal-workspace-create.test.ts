import { describe, expect, it } from "vitest";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import { HerdrResponseError, unwrapHerdrResponse, type HerdrResult, type HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { ComposedView } from "../src/domain/terminal/provider.js";

// A reply that never arrives, or arrives unreadable, may still have created the workspace in herdr. Creating
// again would leave a second, duplicate workspace. Only herdr's own refusal (an error reply) proves nothing
// was created, so only it may lead to the numbered-label and bare fallbacks.
const pane = { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false };
const view: ComposedView = { id: "v", opened: [pane], absent: [], degraded: [], pages: [[pane]] };
const CREATED = { type: "workspace_created", workspace: { workspace_id: "wG" }, tab: { tab_id: "wG:t0" } };

type Respond = (method: string, params: Record<string, unknown>, nth: number) => HerdrResult | Promise<HerdrResult>;
function open(respond: Respond) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport: HerdrTransport = {
    probe: async () => ({ alive: true, version: "0.9.5", protocol: 14 }),
    request: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      const nth = calls.filter((c) => c.method === method).length;
      return respond(method, params as Record<string, unknown>, nth);
    },
  };
  const adapter = new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "t" });
  return { adapter, calls, creates: () => calls.filter((c) => c.method === "workspace.create") };
}

describe("workspace.create after a reply that may have created the workspace", () => {
  it.each(["timeout", "connection closed", "malformed reply"])("does not create again after %s", async (kind) => {
    const f = open((method) => {
      if (method !== "workspace.create") return method === "workspace.list" ? { type: "workspace_list", workspaces: [] } : { type: "ok" };
      if (kind === "malformed reply") return { type: "ok" };
      throw new Error(kind);
    });
    const res = await f.adapter.openView(view);
    expect(res).toMatchObject({ ok: false, opened: [], pages: 0, code: "herdr_workspace_failed" });
    expect(f.creates()).toHaveLength(1);
    expect(f.calls.some((c) => c.method === "layout.apply")).toBe(false);
    expect(res.degraded).toEqual([expect.objectContaining({ seat: "a@r", host: "herdr" })]);
    expect(res.error).toContain("unconfirmed");
    expect(res.error).toContain("Inspect");
    expect(res.degraded[0]!.reason).toBe(res.error);
  });

  it("a lost reply to the numbered-label retry stops there: no bare create", async () => {
    const f = open((method, params, nth) => {
      if (method === "workspace.list") return { type: "workspace_list", workspaces: [{ label: "v" }] };
      if (method !== "workspace.create") return { type: "ok" };
      if (nth === 1) throw new HerdrResponseError("unknown param: label");
      throw new Error("timeout");
    });
    const res = await f.adapter.openView(view);
    expect(res).toMatchObject({ ok: false, code: "herdr_workspace_failed" });
    expect(f.creates()).toHaveLength(2);
    expect(res.error).toContain("unconfirmed");
  });

  it("a lost reply to the bare create ends there too", async () => {
    const f = open((method, params, nth) => {
      if (method === "workspace.list") return { type: "workspace_list", workspaces: [] };
      if (method !== "workspace.create") return { type: "ok" };
      if (nth === 1) throw new HerdrResponseError("unknown param: label");
      throw new Error("connection closed");
    });
    const res = await f.adapter.openView(view);
    expect(res).toMatchObject({ ok: false, code: "herdr_workspace_failed" });
    expect(f.creates()).toHaveLength(2);
    expect(res.error).toContain("unconfirmed");
  });

  it("herdr's own refusal of the labeled create still falls back once to a bare create", async () => {
    const f = open((method, params) => {
      if (method === "workspace.list") return { type: "workspace_list", workspaces: [] };
      if (method === "workspace.create") {
        if (params["label"] != null) throw new HerdrResponseError("unknown param: label");
        return CREATED;
      }
      return { type: "layout_apply", layout: { workspace_id: "wG", tab_id: "wG:t1" } };
    });
    const res = await f.adapter.openView(view);
    expect(f.creates()).toHaveLength(2);
    expect(f.creates()[1]!.params["label"]).toBeUndefined();
    expect(res.notes?.join(" ")).toContain('refused the workspace name "v"');
  });

  it("herdr's refusal of every create degrades with its message, after the fallbacks", async () => {
    const f = open((method) => {
      if (method === "workspace.list") return { type: "workspace_list", workspaces: [] };
      if (method === "workspace.create") throw new HerdrResponseError("boom");
      return { type: "ok" };
    });
    const res = await f.adapter.openView(view);
    expect(res).toMatchObject({ ok: false, code: "herdr_workspace_failed" });
    expect(f.creates()).toHaveLength(2);
    expect(res.error).toContain("workspace.create failed: boom");
  });
});

describe("what the transport calls a refusal", () => {
  it("an error envelope is a HerdrResponseError; a shapeless or unrecognized reply is not", () => {
    expect(() => unwrapHerdrResponse({ id: "1", error: "no such param" })).toThrow(HerdrResponseError);
    expect(() => unwrapHerdrResponse({ error: { code: 3 } })).toThrow(HerdrResponseError);
    let lost: unknown;
    try { unwrapHerdrResponse("garbage"); } catch (e) { lost = e; }
    expect(lost).toBeInstanceOf(Error);
    expect(lost).not.toBeInstanceOf(HerdrResponseError);
  });
});
