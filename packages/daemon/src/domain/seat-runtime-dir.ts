import path from "node:path";

/** A session bus address that can't connect. On Linux a seat gets the daemon's XDG_RUNTIME_DIR, so tools that keep their
 *  socket there (an MCP server's daemon, gpg-agent, rootless Podman) work in seats without per-tool setup. sd-bus, GDBus
 *  and libdbus look for the session bus at $XDG_RUNTIME_DIR/bus, or autolaunch one, only when DBUS_SESSION_BUS_ADDRESS
 *  is unset, so this address comes with it: a seat doesn't find the person's session bus (the keyring, notifications)
 *  on its own. It's default hygiene, not isolation. A seat that sets an address still reaches that bus, and
 *  `systemctl --user` reaches the service manager through its own socket in the runtime directory, like any tool there.
 *  An unknown transport, so all three refuse it before opening a socket (an empty value is unset to libdbus). */
export const NO_SESSION_BUS = "disabled:";

/** The runtime directory OpenRig hands seats: the daemon's own, on Linux only, when it's an absolute path. macOS
 *  usually has none, and a daemon started without one hands none. */
export function seatRuntimeDir(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string | undefined {
  const dir = env.XDG_RUNTIME_DIR;
  return platform === "linux" && dir && path.isAbsolute(dir) ? dir : undefined;
}

/** The daemon's own session bus address, when it can be handed to a seat as it is: a non-empty single line that is not
 *  the address OpenRig itself uses to say "no bus". */
export function daemonSessionBusAddress(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const address = env.DBUS_SESSION_BUS_ADDRESS;
  return address && address !== NO_SESSION_BUS && !/[\x00-\x1f\x7f]/.test(address) ? address : undefined;
}

/** P39 (terminal.seat_session_bus = inherit): give a seat the daemon's own runtime directory AND session bus address, so
 *  tools that need the person's session bus (the keyring behind a key helper, notifications) work in a seat without a
 *  hand-set tmux option. A value the seat already has wins, as for addSeatRuntimeDir. Returns false, changing nothing, when
 *  the daemon has no runtime directory or no usable bus address: the caller then falls back to the default and says so. */
export function addSeatSessionBus(env: Record<string, string | undefined>, runtimeDir: string | undefined, busAddress: string | undefined): boolean {
  if (!runtimeDir || !busAddress) return false;
  if (env.XDG_RUNTIME_DIR === undefined) env.XDG_RUNTIME_DIR = runtimeDir;
  if (!env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = busAddress;
  return true;
}

/** Lay the runtime directory and the bus address that can't connect under a seat's launch environment, in place. A
 *  value the seat already has wins. Its own XDG_RUNTIME_DIR leaves both names as they are, so a seat that chose its
 *  runtime directory keeps finding its bus there as before; its own DBUS_SESSION_BUS_ADDRESS is kept beside the added
 *  directory. An empty address isn't one: libdbus reads it as unset and would find the bus in the added directory. */
export function addSeatRuntimeDir(env: Record<string, string | undefined>, runtimeDir: string | undefined): void {
  if (!runtimeDir || env.XDG_RUNTIME_DIR !== undefined) return;
  env.XDG_RUNTIME_DIR = runtimeDir;
  if (!env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = NO_SESSION_BUS;
}
