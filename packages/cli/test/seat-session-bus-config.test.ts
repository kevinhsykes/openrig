import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";

// P39: terminal.seat_session_bus, daemon store and CLI twin. Default "disabled" (upstream behaviour); "inherit" is opt-in.
const withStores = (fn: (cli: ConfigStore, daemon: SettingsStore, file: string) => void) => {
  const home = mkdtempSync(join(tmpdir(), "seat-bus-setting-")), file = join(home, "config.json");
  try { fn(new ConfigStore(file), new SettingsStore(file), file); } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
};

it("defaults to disabled in both twins, and file and env set inherit with the same precedence", () => withStores((cli, daemon, file) => {
  vi.stubEnv("OPENRIG_TERMINAL_SEAT_SESSION_BUS", undefined);
  expect(cli.resolveWithSource("terminal.seat_session_bus")).toMatchObject({ value: "disabled", source: "default" });
  expect(daemon.resolveOne("terminal.seat_session_bus")).toMatchObject({ value: "disabled", source: "default" });
  writeFileSync(file, JSON.stringify({ terminal: { seatSessionBus: "inherit" } }));
  expect(cli.resolveWithSource("terminal.seat_session_bus")).toMatchObject({ value: "inherit", source: "file" });
  expect(daemon.resolveOne("terminal.seat_session_bus")).toMatchObject({ value: "inherit", source: "file" });
  vi.stubEnv("OPENRIG_TERMINAL_SEAT_SESSION_BUS", "disabled");
  expect(cli.resolveWithSource("terminal.seat_session_bus")).toMatchObject({ value: "disabled", source: "env" });
  expect(daemon.resolveOne("terminal.seat_session_bus")).toMatchObject({ value: "disabled", source: "env" });
}));

it("accepts only inherit or disabled, in both twins", () => withStores((cli, daemon) => {
  for (const good of ["inherit", "disabled"]) {
    expect(() => cli.set("terminal.seat_session_bus", good)).not.toThrow();
    expect(() => daemon.set("terminal.seat_session_bus", good)).not.toThrow();
  }
  for (const bad of ["", "yes", "true", "INHERIT", "unix:path=/x"]) {
    expect(() => cli.set("terminal.seat_session_bus", bad), `cli ${bad}`).toThrow(/must be "inherit" or "disabled"/);
    expect(() => daemon.set("terminal.seat_session_bus", bad), `daemon ${bad}`).toThrow(/must be "inherit" or "disabled"/);
  }
}));
