// #2030: the runtime directory a seat gets on Linux, and which of a seat's own values win over it.
import { describe, expect, it } from "vitest";
import { NO_SESSION_BUS, addSeatRuntimeDir, addSeatSessionBus, daemonSessionBusAddress, seatRuntimeDir } from "../src/domain/seat-runtime-dir.js";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";

describe("seatRuntimeDir", () => {
  it.each([
    ["linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, "/run/user/1000"],
    ["linux", {}, undefined],
    ["linux", { XDG_RUNTIME_DIR: "" }, undefined],
    ["linux", { XDG_RUNTIME_DIR: "run/user/1000" }, undefined],
    ["darwin", { XDG_RUNTIME_DIR: "/run/user/1000" }, undefined],
  ] as const)("on %s with %j hands seats %s", (platform, env, expected) => {
    expect(seatRuntimeDir(env, platform)).toBe(expected);
  });
});

describe("addSeatRuntimeDir", () => {
  it.each([
    ["nothing of its own", {}, { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS }],
    ["its own runtime directory", { XDG_RUNTIME_DIR: "/seat" }, { XDG_RUNTIME_DIR: "/seat" }],
    ["its own empty runtime directory", { XDG_RUNTIME_DIR: "" }, { XDG_RUNTIME_DIR: "" }],
    // libdbus reads an empty address as unset, so it would find the bus in the added directory.
    ["an empty bus address", { DBUS_SESSION_BUS_ADDRESS: "" }, { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS }],
    ["its own bus address", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" },
      { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" }],
    ["both of its own", { XDG_RUNTIME_DIR: "/seat", DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" },
      { XDG_RUNTIME_DIR: "/seat", DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" }],
  ] as const)("a seat with %s keeps it", (_label, seat, expected) => {
    const env: Record<string, string | undefined> = { PATH: "/bin", ...seat };
    addSeatRuntimeDir(env, "/run/user/1000");
    expect(env).toEqual({ PATH: "/bin", ...expected });
  });

  it("adds nothing when there's no runtime directory to hand on", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin" };
    addSeatRuntimeDir(env, undefined);
    expect(env).toEqual({ PATH: "/bin" });
  });
});

// P39: terminal.seat_session_bus = inherit hands a seat the daemon's own bus; the default is upstream's address that cannot connect.
describe("daemonSessionBusAddress", () => {
  it.each([
    [{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, "unix:path=/run/user/1000/bus"],
    [{}, undefined],
    [{ DBUS_SESSION_BUS_ADDRESS: "" }, undefined],
    [{ DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS }, undefined],            // OpenRig's own "no bus" is not a bus to hand on
    [{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/a\nunix:path=/b" }, undefined],  // a line break would split an export
    [{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/a\u0000b" }, undefined],
  ] as const)("%j -> %s", (env, expected) => {
    expect(daemonSessionBusAddress(env)).toBe(expected);
  });
});

describe("addSeatSessionBus", () => {
  const bus = "unix:path=/run/user/1000/bus";
  it("gives a seat with nothing of its own the daemon's runtime directory and bus", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin" };
    expect(addSeatSessionBus(env, "/run/user/1000", bus)).toBe(true);
    expect(env).toEqual({ PATH: "/bin", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: bus });
  });
  it("keeps a value the seat already has", () => {
    const env: Record<string, string | undefined> = { XDG_RUNTIME_DIR: "/seat", DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" };
    expect(addSeatSessionBus(env, "/run/user/1000", bus)).toBe(true);
    expect(env).toEqual({ XDG_RUNTIME_DIR: "/seat", DBUS_SESSION_BUS_ADDRESS: "unix:path=/seat/bus" });
  });
  it.each([["no runtime directory", undefined, bus], ["no bus address", "/run/user/1000", undefined]] as const)("changes nothing and says so with %s", (_l, dir, address) => {
    const env: Record<string, string | undefined> = { PATH: "/bin" };
    expect(addSeatSessionBus(env, dir, address)).toBe(false);
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("the seat launch environment under terminal.seat_session_bus (P39)", () => {
  const bus = "unix:path=/run/user/1000/bus";
  async function launch(policy: { sessionBus?: "inherit" | "disabled"; busAddress?: string; runtimeDir?: string }) {
    const writes: string[] = [];
    const fileOps: TmuxFileOps = { writeFile: async (_p, content) => { writes.push(content); }, unlink: async () => {}, tmpName: () => "/tmp/p39-env", bufferName: () => "b" };
    const argvExec = async (argv: string[]) => {
      const text = argv.join(" ");
      if (text.includes("default-shell")) return "/bin/sh\n";
      if (text.includes("default-command")) return "\n";
      if (text.includes("update-environment")) return "\n";
      if (text.includes("new-session")) return "%1\n";
      return "";
    };
    const tmux = new TmuxAdapter(async () => { throw new Error("argv only"); }, fileOps, argvExec);
    tmux.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: { PATH: "/bin" }, runtimeDir: "/run/user/1000", ...policy });
    const result = await tmux.createSession("seat", "/w", { OPENRIG_NODE_ID: "n1" });
    const script = writes.find((w) => w.includes('exec "$@"')) ?? "";
    return { result, script };
  }

  it("inherit: the seat gets the daemon's runtime directory and the real bus address", async () => {
    const { script } = await launch({ sessionBus: "inherit", busAddress: bus });
    expect(script).toContain("export XDG_RUNTIME_DIR='/run/user/1000'");
    expect(script).toContain(`export DBUS_SESSION_BUS_ADDRESS='${bus}'`);
    expect(script).not.toContain(NO_SESSION_BUS);
  });
  it("disabled (the default): the address that cannot connect, as upstream", async () => {
    const { script } = await launch({ sessionBus: "disabled", busAddress: bus });
    expect(script).toContain(`export DBUS_SESSION_BUS_ADDRESS='${NO_SESSION_BUS}'`);
    expect(script).not.toContain(bus);
  });
  it("unset policy behaves as disabled", async () => {
    const { script } = await launch({ busAddress: bus });
    expect(script).toContain(NO_SESSION_BUS);
  });
  it("inherit without a daemon bus address falls back to the default and warns, and the seat still starts", async () => {
    const { result, script } = await launch({ sessionBus: "inherit" });
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("terminal.seat_session_bus is inherit")] });
    expect(script).toContain(`export DBUS_SESSION_BUS_ADDRESS='${NO_SESSION_BUS}'`);
  });
});
