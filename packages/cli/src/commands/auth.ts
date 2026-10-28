// OPR.0.4.1.29 — `rig auth <verb> [--runtime codex]`: CLI-LOCAL / daemon-free auth-profile management.
// Capability-grouped with runtime as an orthogonal flag (NOT `rig codex-auth`, NOT a `rig codex` noun)
// per conventions/cli-read-command-grammar. Every line printed here is built ONLY from the structured,
// non-secret result fields of the secret-safe lib — a token value can never reach stdout/stderr.
import { Command } from "commander";
import {
  resolveCodexHome,
  authStatus,
  authList,
  authSave,
  authSwitch,
  authValidate,
  authSeatSet,
  authSeatsList,
  authSeatShow,
  authSeatsReport,
  SEAT_REGISTRY_DISCLAIMER,
  type CodexAuthPaths,
} from "../lib/codex-auth.js";
import {
  claudeConfigDirPresent,
  readClaudeAccountsFile,
  realClaudeConfigDirProbe,
  type ClaudeAccount,
  type ClaudeConfigDirLogin,
  type ClaudeConfigDirProbe,
} from "@openrig/daemon/claude-config-dir";
import { localSelfHostId, originFor, runOnSshHost, type RunOnHostDeps } from "../lib/run-on-host.js";
import { realDeps } from "./daemon.js";

export interface AuthCommandDeps {
  /** env source (default process.env) — tests point CODEX_HOME at a fixture. */
  env?: NodeJS.ProcessEnv;
  /** login-state probe (default: real `codex login status`, exit-code-only). Injectable for tests. */
  loginStatus?: (codexHome: string) => "logged_in" | "not_logged_in" | "unavailable";
  /** clock for seats set updated_ts (default new Date().toISOString()). */
  now?: () => string;
  /** `--host`: the host registry and the SSH runner (tests inject both). */
  host?: RunOnHostDeps;
  /** `--runtime claude`: one config dir's login state (default: real `claude auth status --json` with that dir selected). */
  claudeProbe?: ClaudeConfigDirProbe;
}

/** Names the file that declares the Claude accounts (config-dir homes); `--accounts-file` wins over this variable. */
export const CLAUDE_ACCOUNTS_FILE_ENV = "OPENRIG_CLAUDE_ACCOUNTS_FILE";

function fail(reason: string): void {
  console.error(`rig auth: ${reason}`);
  process.exitCode = 1;
}

// MVP supports --runtime codex. Other runtimes are the SAME surface with a different flag (future); reject them
// with a clear message rather than silently treating them as codex. `--runtime claude` is the first of them, and
// only for `status` and `list` (read-only: the declared accounts and each one's login state); a Claude seat moves
// between accounts with `rig provider switch`, so the verbs that save, switch or validate a profile keep refusing.
function ensureRuntime(runtime: string, readOnlyOk = false): boolean {
  if (runtime !== "codex" && !(readOnlyOk && runtime === "claude")) {
    fail(`unsupported_runtime ${runtime} (MVP supports: codex)`);
    return false;
  }
  return true;
}

export function authCommand(depsOverride?: AuthCommandDeps): Command {
  const env = depsOverride?.env ?? process.env;
  const paths = (codexHome?: string): CodexAuthPaths => resolveCodexHome(codexHome ? { ...env, CODEX_HOME: codexHome } : env);
  const withRuntime = (c: Command): Command => c.option("--runtime <runtime>", "Runtime axis (MVP: codex)", "codex");
  // status and list also take claude: its accounts are config-dir homes declared in a file, not profiles in a home.
  const withReadRuntime = (c: Command): Command => c
    .option("--runtime <runtime>", "Runtime axis (codex; claude for status and list)", "codex")
    .option("--accounts-file <path>", `Claude: the file declaring the account config dirs (default: $${CLAUDE_ACCOUNTS_FILE_ENV})`);
  type ClaudeOpts = { runtime: string; accountsFile?: string; host?: string };
  const claudeAccounts = (opts: ClaudeOpts): ClaudeAccount[] | null => {
    if (opts.host) { fail("--host isn't supported with --runtime claude: run it on that machine"); return null; }
    const file = opts.accountsFile ?? env[CLAUDE_ACCOUNTS_FILE_ENV];
    if (!file) { fail(`name the accounts file: --accounts-file <path> or ${CLAUDE_ACCOUNTS_FILE_ENV}`); return null; }
    const read = readClaudeAccountsFile(file);
    if (!read.ok) { fail(read.reason); return null; }
    return read.accounts;
  };
  const probe = depsOverride?.claudeProbe ?? realClaudeConfigDirProbe({ launchPath: env.PATH, ...(env.HOME ? { home: env.HOME } : {}) });
  // Per account: whether its dir exists, and, only when it does, its login state from ONE bounded `claude auth status`. A key's
  // `has_credentials` or a file's presence in the dir is never read as login state (BR-3). Probes run together; each is bounded.
  const claudeRows = (accounts: ClaudeAccount[]) => Promise.all(accounts.map(async (a) => {
    const present = claudeConfigDirPresent(a.dir);
    const login: ClaudeConfigDirLogin | null = present ? await probe(a.dir).catch((): ClaudeConfigDirLogin => ({ state: "unreadable", reason: "spawn_failed", detail: "the probe failed" })) : null;
    const state = login === null ? "n/a (config dir missing)" : login.state === "unreadable" ? `unavailable (${login.reason})` : login.state;
    return { account: a, present, state };
  }));
  // Slice 18: the commands that move a Codex home act on a named home, here or on another registered machine.
  const withHome = (c: Command): Command => c
    .option("--codex-home <dir>", "The Codex home to act on (default: CODEX_HOME, else ~/.codex)")
    .option("--host <id>", "Run it on this registered machine instead, over its SSH entry, as this seat");
  type HomeOpts = { runtime: string; codexHome?: string; host?: string };
  const onHost = async (verb: string, args: string[], opts: HomeOpts) => {
    const seat = (env.OPENRIG_SESSION_NAME ?? env.RIGGED_SESSION_NAME)?.trim() || undefined;
    const origin = await originFor(seat, depsOverride?.host?.selfHostId ?? (() => localSelfHostId(realDeps())));
    const home = opts.codexHome ? ["--codex-home", opts.codexHome] : [];
    await runOnSshHost(opts.host!, `auth ${verb}`, ["auth", verb, ...args, "--runtime", opts.runtime, ...home], {
      origin,
      // A switch changes that home; status and list only read.
      ...(verb === "switch" ? { changes: { check: `rig auth status --host ${opts.host} --codex-home ${opts.codexHome} (a switch copies the same saved profile again if repeated)` } } : {}),
    }, depsOverride?.host);
  };

  const auth = new Command("auth").description(
    "Manage agent auth profiles (CLI-local; runtime via --runtime). Tokens are never printed, logged, or stored.",
  );

  withHome(withReadRuntime(auth.command("status")))
    .description("Auth-file presence + login state (no secrets). --runtime claude: each declared account's config dir and login state.")
    .action(async (opts: HomeOpts & ClaudeOpts) => {
      if (!ensureRuntime(opts.runtime, true)) return;
      if (opts.runtime === "claude") {
        const accounts = claudeAccounts(opts);
        if (!accounts) return;
        for (const r of await claudeRows(accounts)) {
          console.log(`account: ${r.account.key}`);
          console.log(`label: ${r.account.label}`);
          console.log(`config_dir: ${r.account.dir}`);
          console.log(`config_dir_present: ${r.present ? "yes" : "no"}`);
          console.log(`login_state: ${r.state}`);
        }
        return;
      }
      if (opts.host) return onHost("status", [], opts);
      const r = authStatus(paths(opts.codexHome), { loginStatus: depsOverride?.loginStatus });
      console.log(`codex_home: ${r.codexHome}`);
      console.log(`codex_home_present: ${r.codexHomePresent ? "yes" : "no"}`);
      console.log(`active_auth_present: ${r.activeAuthPresent ? "yes" : "no"}`);
      console.log(`active_auth_mode: ${r.activeAuthMode ?? "n/a"}`);
      console.log(`active_auth_mode_safe: ${r.activeAuthModeSafe}`);
      console.log(`saved_profiles: ${r.profileCount}`);
      console.log(`login_status: ${r.loginStatus}`);
    });

  withHome(withReadRuntime(auth.command("list")))
    .description("List saved profiles by name. --runtime claude: the declared accounts, one per line (key, label, config dir, present, login state).")
    .action(async (opts: HomeOpts & ClaudeOpts) => {
      if (!ensureRuntime(opts.runtime, true)) return;
      if (opts.runtime === "claude") {
        const accounts = claudeAccounts(opts);
        if (!accounts) return;
        for (const r of await claudeRows(accounts)) console.log([r.account.key, r.account.label, r.account.dir, r.present ? "yes" : "no", r.state].join("\t"));
        return;
      }
      if (opts.host) return onHost("list", [], opts);
      for (const name of authList(paths(opts.codexHome))) console.log(name);
    });

  withRuntime(auth.command("save <profile>"))
    .description("Snapshot the active auth state into a named profile (file copy; contents never echoed).")
    .action((profile: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSave(paths(), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`saved_profile: ${r.name}`);
      console.log(`profile_path: ${r.path}`);
      console.log(`profile_mode: ${r.mode}`);
    });

  withHome(withRuntime(auth.command("switch <profile>")))
    .description("Restore saved credential bytes (sign-in is unverified).")
    .addHelpText("after", `
With --host, the switch runs on that machine, over its SSH entry, and copies a profile already saved there; name the
home with --codex-home (rig auth status --host <id> shows the home it would use). Only the command and its output
cross the connection.`)
    .action(async (profile: string, opts: HomeOpts) => {
      if (!ensureRuntime(opts.runtime)) return;
      if (opts.host && !opts.codexHome) {
        return fail(`switch --host needs --codex-home: name the home on ${opts.host} (rig auth status --host ${opts.host} shows the home it would use)`);
      }
      if (opts.host) return onHost("switch", [profile], opts);
      const r = authSwitch(paths(opts.codexHome), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`activated_profile: ${r.name}`);
      console.log(`active_auth: ${r.activePath}`);
      console.log(`active_mode: ${r.mode}`);
      console.log("note: Restored saved credential bytes only; sign-in is unverified. Saved credentials may expire, be revoked, or be superseded by refresh elsewhere. Restart the affected seat and use the existing account verification; fresh sign-in may be required.");
      console.log(`note: ${r.note}`);
    });

  withRuntime(auth.command("validate <profile>"))
    .description("Check a profile's file mode + JSON parseability (NOT live-auth).")
    .action((profile: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authValidate(paths(), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`profile_valid: ${r.name}`);
      console.log(`profile_path: ${r.path}`);
      console.log(`profile_mode: ${r.mode}`);
      console.log("note: checks file mode + JSON parseability only, NOT live account state.");
    });

  const seats = auth.command("seats").description("Seat -> profile registry (metadata only; not proof of a live account).");

  withRuntime(seats.command("list"))
    .description("List seat -> profile mappings.")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      for (const row of authSeatsList(paths())) console.log(`${row.seat}\t${row.authProfile}\t${row.updatedTs}`);
      console.log(`# ${SEAT_REGISTRY_DISCLAIMER}`);
    });

  withRuntime(seats.command("show <seat>"))
    .description("Show the registry row for one seat.")
    .action((seat: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatShow(paths(), seat);
      if (!r.ok) return fail(r.reason);
      console.log(`seat: ${r.row.seat}`);
      console.log(`rig: ${r.row.rig}`);
      console.log(`runtime: ${r.row.runtime}`);
      console.log(`cwd: ${r.row.cwd}`);
      console.log(`auth_profile: ${r.row.authProfile}`);
      console.log(`updated_ts: ${r.row.updatedTs}`);
      console.log(`note: ${SEAT_REGISTRY_DISCLAIMER}`);
    });

  withRuntime(seats.command("set"))
    .description("Upsert a seat -> profile metadata row.")
    .requiredOption("--seat <seat>", "Seat session name")
    .requiredOption("--rig <rig>", "Rig name")
    .option("--cwd <cwd>", "Working dir (metadata)")
    .option("--profile <profile>", "Auth profile label (or omit for unknown)")
    .action((opts: { runtime: string; seat?: string; rig?: string; cwd?: string; profile?: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatSet(
        paths(),
        { seat: opts.seat ?? "", rig: opts.rig ?? "", runtime: "codex", cwd: opts.cwd, authProfile: opts.profile },
        depsOverride?.now,
      );
      if (!r.ok) return fail(r.reason);
      console.log(`seat_upserted: ${r.seat}`);
      console.log(`registry_path: ${r.registryPath}`);
      console.log(`registry_mode: ${r.mode}`);
      console.log(`note: ${r.disclaimer}`);
    });

  withRuntime(seats.command("report"))
    .description("Counts: total / known / unknown / malformed.")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatsReport(paths());
      console.log(`registry_present: ${r.registryPresent ? "yes" : "no"}`);
      console.log(`registry_mode: ${r.registryMode ?? "n/a"}`);
      console.log(`registry_mode_safe: ${r.registryModeSafe}`);
      console.log(`total_seats: ${r.total}`);
      console.log(`known_profiles: ${r.known}`);
      console.log(`unknown_profiles: ${r.unknown}`);
      console.log(`malformed_rows: ${r.malformed}`);
      console.log(`# ${SEAT_REGISTRY_DISCLAIMER}`);
    });

  return auth;
}
