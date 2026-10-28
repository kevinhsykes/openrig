import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { isShellForeground } from "../src/domain/shell-classifier.js";

// The documented interactive-Pi example, run against a stand-in `pi` that records how it was started (no Pi, no model).
const EXAMPLE = resolve(__dirname, "../../../docs/reference/community-harness-examples/pi-tui");
const NAME = "openrig-team-worker-0123abcd";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seatFolders(dir: string) {
  const home = join(dir, "home");
  const state = join(home, "state", "pi-tui", "node-1");
  return { home, state, sessions: join(state, "sessions") };
}

// A session file as Pi 1.4.0 writes one: <time>_<id>.jsonl, whose first line is the session header.
function addSession(sessions: string, id: string, fileId = id, stamp = "2026-10-27T14-13-00-123Z") {
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, `${stamp}_${fileId}.jsonl`);
  writeFileSync(file, `{"type":"session","version":3,"id":"${id}","timestamp":"2026-10-27T14:13:00.123Z","cwd":"/work"}\n`);
  return file;
}

// Another conversation's header that carries the requested id only nested inside it: Pi would open that other conversation.
function addNestedIdSession(sessions: string, id: string) {
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `2026-10-27T14-13-00-123Z_${id}.jsonl`),
    `{"type":"session","version":3,"id":"openrig-other-0000ffff","meta":{"type":"session","id":"${id}"},"cwd":"/work"}\n`);
}

// `setup` prepares the seat's folders and returns the launch's variables.
function run(setup: (dir: string) => Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tui-example-")); dirs.push(dir);
  const { home, state, sessions } = seatFolders(dir);
  // The installed openrig-core plugin's queue-handoff skill, with an executable helper.
  const skill = join(home, "plugins", "openrig-core", "skills", "queue-handoff");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: queue-handoff\n---\n");
  writeFileSync(join(skill, "helper.sh"), "#!/bin/sh\n", { mode: 0o755 });
  const fake = join(dir, "pi");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\0' "$@" > "${dir}/args"\nprintf '%s' "$PI_CODING_AGENT_DIR" > "${dir}/agent-dir"\n`);
  chmodSync(fake, 0o755);
  const env = setup(dir);
  const result = spawnSync(join(EXAMPLE, "openrig-pi-tui-launch"), [], { cwd: dir, encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env["PATH"]!, OPENRIG_PI: fake, OPENRIG_HOME: home, OPENRIG_NODE_ID: "node-1", OPENRIG_PI_RELAUNCH: "0", ...env } });
  const read = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null;
  return { args: read("args")?.split("\0").slice(0, -1) ?? null, agentDir: read("agent-dir"), exit: result.status, stderr: result.stderr,
    dir, state, sessions };
}

describe("the documented interactive-Pi launcher and preset", () => {
  it("starts Pi on the name OpenRig gave, in the seat's own folders, with the first input as one exact prompt", () => {
    const text = "identity\n'quoted' $literal -x\n";
    const { args, agentDir, state, sessions } = run(dir => {
      const file = join(dir, "first.txt"); writeFileSync(file, text, { mode: 0o600 });
      return { OPENRIG_CONVERSATION: NAME, OPENRIG_FIRST_INPUT: file };
    });
    expect(args).toEqual(["--session-dir", sessions, "--session-id", NAME, "--no-approve", "--", text]);
    expect(agentDir).toBe(join(state, "agent"));
    // The released skill is copied whole, its helper still executable.
    expect(readFileSync(join(state, "agent", "skills", "queue-handoff", "SKILL.md"), "utf8")).toContain("name: queue-handoff");
    expect(statSync(join(state, "agent", "skills", "queue-handoff", "helper.sh")).mode & 0o111).not.toBe(0);
  });

  it("passes no prompt when there's no first input", () => {
    const { args, sessions } = run(() => ({ OPENRIG_CONVERSATION: NAME }));
    expect(args).toEqual(["--session-dir", sessions, "--session-id", NAME, "--no-approve"]);
  });

  it("reopens the one session file whose header has that id, not one whose file name only ends with it", () => {
    let file = "";
    const { args, sessions } = run(dir => {
      const { sessions } = seatFolders(dir);
      file = addSession(sessions, NAME);
      addSession(sessions, `x_${NAME}`);
      return { OPENRIG_RESUME_REF: NAME };
    });
    expect(args).toEqual(["--session-dir", sessions, "--session", file, "--no-approve"]);
  });

  it.each([
    ["missing", (_: string) => {}],
    ["never written to (empty)", (sessions: string) => { mkdirSync(sessions, { recursive: true }); writeFileSync(join(sessions, `2026-10-27T14-13-00-123Z_${NAME}.jsonl`), ""); }],
    ["held by another id's header", (sessions: string) => { addSession(sessions, "openrig-other-0000ffff", NAME); }],
    ["held by another id's header that nests this id", (sessions: string) => { addNestedIdSession(sessions, NAME); }],
    ["ambiguous (two files)", (sessions: string) => { addSession(sessions, NAME); addSession(sessions, NAME, NAME, "2026-10-27T15-00-00-000Z"); }],
  ])("starts nothing when the session is %s", (_label, prepare) => {
    const { args, exit, stderr } = run(dir => { prepare(seatFolders(dir).sessions); return { OPENRIG_RESUME_REF: NAME }; });
    expect(args).toBeNull();
    expect(exit).toBe(1);
    expect(stderr).toContain("starting nothing");
  });

  it.each(["-dash-first", "has space", "ends-with-dash-", ""])("refuses a name Pi can't take as a session id (%j)", (name) => {
    const { args, exit } = run(() => ({ OPENRIG_CONVERSATION: name }));
    expect(args).toBeNull();
    expect(exit).toBe(2);
  });

  it("uses an agent folder the seat already set, and copies the skills there", () => {
    let own = "";
    const { agentDir } = run(dir => { own = join(dir, "own-agent"); return { OPENRIG_CONVERSATION: NAME, PI_CODING_AGENT_DIR: own }; });
    expect(agentDir).toBe(own);
    expect(existsSync(join(own, "skills", "queue-handoff", "SKILL.md"))).toBe(true);
  });

  it("expands a leading ~ in that folder as Pi does, so the skills land where Pi looks", () => {
    let dirOf = "";
    const { agentDir } = run(dir => { dirOf = dir; return { OPENRIG_CONVERSATION: NAME, HOME: dir, PI_CODING_AGENT_DIR: "~/own-agent" }; });
    expect(agentDir).toBe(join(dirOf, "own-agent"));
    expect(existsSync(join(dirOf, "own-agent", "skills", "queue-handoff", "SKILL.md"))).toBe(true);
  });

  it("declares a named conversation and first input, and no resume until a real Pi has checked it", () => {
    expect(loadCommunityHarnessPreset("pi-tui", EXAMPLE)).toMatchObject({ ok: true,
      preset: { command: "openrig-pi-tui-launch", namesConversation: true, launchResult: false, firstInput: true, resume: false, startupAssisted: false } });
  });
});

// P17: Pi's own chat screen, kept up. The launcher passes the seat's model and thinking level, never stops at Pi's
// "trust this folder?" dialog, and starts Pi again, on the same session, when it exits: a bounded loop with a back-off
// that gives up loudly. A recording stand-in `pi` takes each start's exit status and run time from a script.
describe("the interactive-Pi launcher: model, thinking, no-approve and relaunch", () => {
  const LAUNCHER = join(EXAMPLE, "openrig-pi-tui-launch");

  // `script[n]` is "<seconds to run> <exit status>" for the n-th start (from 1); later starts exit 1 at once.
  function launch(opts: { env?: Record<string, string>; script?: string[]; writeSession?: boolean; firstInput?: string; setup?: (sessions: string) => void } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "pi-tui-loop-")); dirs.push(dir);
    const { home, sessions } = seatFolders(dir);
    mkdirSync(join(dir, "calls"), { recursive: true });
    writeFileSync(join(dir, "script"), (opts.script ?? []).join("\n") + "\n");
    opts.setup?.(sessions);
    if (opts.firstInput !== undefined) writeFileSync(join(dir, "first.txt"), opts.firstInput, { mode: 0o600 });
    const fake = join(dir, "pi");
    writeFileSync(fake, `#!/bin/sh
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/count"
printf '%s\\0' "$@" > "${dir}/calls/$n"
${opts.writeSession ? `mkdir -p "${sessions}"; printf '{"type":"session","version":3,"id":"${NAME}"}\\n' > "${sessions}/2026-10-27T14-13-00-123Z_${NAME}.jsonl"` : ":"}
line=$(sed -n "$n p" "${dir}/script"); [ -n "$line" ] || line="0 1"
set -- $line
[ "$1" = 0 ] || sleep "$1"
exit "$2"
`, { mode: 0o755 });
    const recorder = join(dir, "record-sleep");
    writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${dir}/sleeps"\n`, { mode: 0o755 });
    const result = spawnSync(LAUNCHER, [], { cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env["PATH"]!, OPENRIG_PI: fake, OPENRIG_HOME: home, OPENRIG_NODE_ID: "node-1", OPENRIG_PI_SLEEP: recorder,
        OPENRIG_CONVERSATION: NAME, ...(opts.firstInput !== undefined ? { OPENRIG_FIRST_INPUT: join(dir, "first.txt") } : {}), ...opts.env } });
    const count = existsSync(join(dir, "count")) ? Number(readFileSync(join(dir, "count"), "utf8")) : 0;
    const calls = Array.from({ length: count }, (_, i) => readFileSync(join(dir, "calls", String(i + 1)), "utf8").split("\0").slice(0, -1));
    const sleeps = existsSync(join(dir, "sleeps")) ? readFileSync(join(dir, "sleeps"), "utf8").split("\n").filter(Boolean) : [];
    return { calls, sleeps, exit: result.status, stderr: result.stderr, sessions, dir };
  }
  const flags = (args: string[]) => args.filter(a => a.startsWith("--"));

  describe("model and thinking", () => {
    it("passes OPENRIG_MODEL as --model, ahead of --no-approve", () => {
      const { calls, sessions } = launch({ env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_MODEL: "minimax/MiniMax-M3.1-Flash" } });
      expect(calls[0]).toEqual(["--session-dir", sessions, "--session-id", NAME, "--model", "minimax/MiniMax-M3.1-Flash", "--no-approve"]);
    });

    it("passes no --model when the seat has none", () => {
      expect(flags(launch({ env: { OPENRIG_PI_RELAUNCH: "0" } }).calls[0]!)).not.toContain("--model");
    });

    it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])("maps the seat's effort %s to Pi's --thinking %s", (level) => {
      const { calls } = launch({ env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_EFFORT: level } });
      expect(calls[0]!.slice(calls[0]!.indexOf("--thinking"), calls[0]!.indexOf("--thinking") + 2)).toEqual(["--thinking", level]);
    });

    it("names an effort Pi has no level for, and starts Pi without --thinking rather than guessing", () => {
      const { calls, stderr, exit } = launch({ env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_EFFORT: "ludicrous" } });
      expect(flags(calls[0]!)).not.toContain("--thinking");
      expect(stderr).toContain("ludicrous");
      expect(exit).toBe(1); // Pi's own status; the stand-in exits 1
    });

    it.each(["--no-approve", "-x"])("refuses a model that would read as a Pi flag (%j) and starts nothing", (model) => {
      const { calls, exit, stderr } = launch({ env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_MODEL: model } });
      expect(calls).toEqual([]);
      expect(exit).toBe(2);
      expect(stderr).toContain("OPENRIG_MODEL");
    });

    it("carries the same model, thinking level and --no-approve into every relaunch", () => {
      const { calls } = launch({ env: { OPENRIG_PI_MAX_RESTARTS: "2", OPENRIG_MODEL: "p/m", OPENRIG_EFFORT: "high" } });
      expect(calls).toHaveLength(3);
      for (const call of calls) expect(call).toEqual(expect.arrayContaining(["--model", "p/m", "--thinking", "high", "--no-approve"]));
    });
  });

  // P17b: a seat's role and its "run rig whoami" note must survive compaction and resume, so they ride Pi's system prompt
  // (--append-system-prompt), on EVERY start, and not only in the first input.
  describe("persistent system prompt (OPENRIG_PI_APPEND_SYSTEM_PROMPT)", () => {
    function roleFile(name = "role.md", text = "ROLE TEXT\n") {
      const dir = mkdtempSync(join(tmpdir(), "pi-tui-role-")); dirs.push(dir);
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    }
    const at = (call: string[], flag: string) => call.slice(call.indexOf(flag), call.indexOf(flag) + 2);

    it("passes the file to Pi's --append-system-prompt, ahead of --no-approve", () => {
      const role = roleFile();
      const { calls, sessions } = launch({ env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_PI_APPEND_SYSTEM_PROMPT: role } });
      expect(calls[0]).toEqual(["--session-dir", sessions, "--session-id", NAME, "--append-system-prompt", role, "--no-approve"]);
    });

    it("passes it on every relaunch, not only the first start", () => {
      const role = roleFile();
      const { calls } = launch({ env: { OPENRIG_PI_MAX_RESTARTS: "2", OPENRIG_PI_APPEND_SYSTEM_PROMPT: role } });
      expect(calls).toHaveLength(3);
      for (const call of calls) expect(at(call, "--append-system-prompt")).toEqual(["--append-system-prompt", role]);
    });

    it("passes it when the seat resumes a conversation too", () => {
      const role = roleFile();
      const { calls } = launch({ setup: (sessions) => addSession(sessions, NAME),
        env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_RESUME_REF: NAME, OPENRIG_PI_APPEND_SYSTEM_PROMPT: role } });
      expect(calls[0]).toContain("--session");
      expect(at(calls[0]!, "--append-system-prompt")).toEqual(["--append-system-prompt", role]);
    });

    it("keeps the first input as the last, exact argument, and the role path as one argument when it has a space", () => {
      const role = roleFile("my role.md");
      const { calls } = launch({ firstInput: "FIRST TURN", env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_PI_APPEND_SYSTEM_PROMPT: role } });
      expect(at(calls[0]!, "--append-system-prompt")).toEqual(["--append-system-prompt", role]);
      expect(calls[0]!.slice(-2)).toEqual(["--", "FIRST TURN"]);
    });

    it.each([undefined, ""])("passes no --append-system-prompt when the variable is %j", (value) => {
      const { calls } = launch({ env: { OPENRIG_PI_RELAUNCH: "0", ...(value === undefined ? {} : { OPENRIG_PI_APPEND_SYSTEM_PROMPT: value }) } });
      expect(flags(calls[0]!)).not.toContain("--append-system-prompt");
    });

    // Pi reads the value as text when it is not a file, so a path that is not a file would silently become the prompt.
    it.each([
      ["a missing file", () => join(tmpdir(), "pi-tui-no-such-role.md"), "isn't a file"],
      ["a directory", () => roleFile() && join(roleFile(), ".."), "isn't a file"],
      ["a relative path", () => "role.md", "absolute"],
      ["a path that reads as a Pi flag", () => "-role.md", "Pi flag"],
    ])("refuses %s by name and starts nothing", (_label, make, why) => {
      const { calls, exit, stderr } = launch({ env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_PI_APPEND_SYSTEM_PROMPT: make() } });
      expect(calls).toEqual([]);
      expect(exit).toBe(2);
      expect(stderr).toContain("OPENRIG_PI_APPEND_SYSTEM_PROMPT");
      expect(stderr).toContain(why);
    });

    it("refuses an unreadable role file by name and starts nothing", () => {
      const role = roleFile();
      chmodSync(role, 0o000);
      try {
        const { calls, exit, stderr } = launch({ env: { OPENRIG_PI_RELAUNCH: "0", OPENRIG_PI_APPEND_SYSTEM_PROMPT: role } });
        expect(calls).toEqual([]);
        expect(exit).toBe(2);
        expect(stderr).toContain("readable");
      } finally { chmodSync(role, 0o600); }
    });
  });

  describe("relaunch", () => {
    it("starts Pi again when it exits, up to the bound, then gives up loudly with a non-zero status", () => {
      const { calls, exit, stderr } = launch({ env: { OPENRIG_PI_MAX_RESTARTS: "3" } });
      expect(calls).toHaveLength(4); // the first start and 3 relaunches
      expect(exit).toBe(1);
      expect(stderr).toContain("giving up");
      expect(stderr).toContain("4");
    });

    it("backs off between relaunches, doubling from 2 s and capped at 60 s", () => {
      expect(launch({ env: { OPENRIG_PI_MAX_RESTARTS: "3" } }).sleeps).toEqual(["2", "4", "8"]);
      expect(launch({ env: { OPENRIG_PI_MAX_RESTARTS: "8" } }).sleeps).toEqual(["2", "4", "8", "16", "32", "60", "60", "60"]);
    });

    it("relaunches on the same session: the file the first start wrote, by its header", () => {
      const { calls, sessions } = launch({ env: { OPENRIG_PI_MAX_RESTARTS: "1" }, writeSession: true });
      expect(calls[0]).toEqual(["--session-dir", sessions, "--session-id", NAME, "--no-approve"]);
      expect(calls[1]).toEqual(["--session-dir", sessions, "--session", join(sessions, `2026-10-27T14-13-00-123Z_${NAME}.jsonl`), "--no-approve"]);
    });

    it("relaunches on the same name when the first start never wrote a session (Pi writes one with the first message)", () => {
      const { calls, sessions } = launch({ env: { OPENRIG_PI_MAX_RESTARTS: "1" } });
      expect(calls[1]).toEqual(["--session-dir", sessions, "--session-id", NAME, "--no-approve"]);
    });

    it("gives up, rather than guess, when two session files claim the name", () => {
      const { calls, exit, stderr } = launch({ env: { OPENRIG_PI_MAX_RESTARTS: "3" }, writeSession: true,
        setup: (sessions) => { addSession(sessions, NAME, NAME, "2026-10-27T15-00-00-000Z"); } });
      expect(calls).toHaveLength(1);
      expect(exit).toBe(1);
      expect(stderr).toContain("giving up");
    });

    it("types the first input into the first start only", () => {
      const { calls } = launch({ env: { OPENRIG_PI_MAX_RESTARTS: "2" }, firstInput: "identity turn\n" });
      expect(calls).toHaveLength(3);
      expect(calls[0]!.slice(-2)).toEqual(["--", "identity turn\n"]);
      for (const call of calls.slice(1)) expect(call).not.toContain("--");
    });

    it("counts only quick exits: a start that ran for the stable time resets the count", () => {
      // MAX 1: quick (1), slow (reset to 0), quick (1), quick (2 > 1: give up) = 4 starts. Without the reset the slow start
      // would already be the second failure and the launcher would stop after 2.
      const { calls } = launch({ env: { OPENRIG_PI_MAX_RESTARTS: "1", OPENRIG_PI_STABLE_SECS: "2" }, script: ["0 1", "2.2 1", "0 1", "0 1"] });
      expect(calls).toHaveLength(4);
    });

    it("OPENRIG_PI_RELAUNCH=0 runs Pi once and returns its status", () => {
      const { calls, exit, sleeps } = launch({ env: { OPENRIG_PI_RELAUNCH: "0" }, script: ["0 7"] });
      expect(calls).toHaveLength(1);
      expect(exit).toBe(7);
      expect(sleeps).toEqual([]);
    });
  });

  // `checkReady` and the handover gate read the pane's foreground command. A launcher that loops must not read as a shell
  // while Pi runs: a plain loop shows `sh` (measured), so Pi would count as down. Job control puts Pi in the foreground.
  describe.skipIf(spawnSync("tmux", ["-V"]).status !== 0)("in a real tmux pane", () => {
    it("reads as Pi's process, not a shell, while the loop runs it, and stops with the pane", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pit-")); dirs.push(dir);
      const sock = join(dir, "s");
      const { home } = seatFolders(dir);
      const log = join(dir, "starts");
      const fake = join(dir, "pi");
      writeFileSync(fake, `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(log)}, "start\\n");\nsetTimeout(() => {}, 20000);\n`, { mode: 0o755 });
      const env = { PATH: process.env["PATH"]!, HOME: dir, OPENRIG_PI: fake, OPENRIG_HOME: home, OPENRIG_NODE_ID: "node-1", OPENRIG_CONVERSATION: NAME };
      const tmux = (...args: string[]) => spawnSync("tmux", ["-S", sock, ...args], { encoding: "utf8", env });
      try {
        expect(tmux("-f", "/dev/null", "new-session", "-d", "-s", "t", "-x", "80", "-y", "24", `exec ${LAUNCHER}`).status).toBe(0);
        let command = "";
        for (let i = 0; i < 40 && command !== "node"; i++) {
          await new Promise(r => setTimeout(r, 100));
          command = tmux("display-message", "-p", "-t", "t", "#{pane_current_command}").stdout.trim();
        }
        expect(command).toBe("node");
        expect(isShellForeground(command)).toBe(false);
      } finally {
        tmux("kill-server");
      }
      // The pane is gone: nothing relaunches Pi into it and nothing is left running.
      await new Promise(r => setTimeout(r, 3500));
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
      const left = spawnSync("sh", ["-c", `ps -eo args --no-headers | grep -c '^node ${fake}'`], { encoding: "utf8" }).stdout.trim();
      expect(left).toBe("0");
    }, 20_000);
  });
});
