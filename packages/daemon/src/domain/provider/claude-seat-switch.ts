import os from "node:os";
import path from "node:path";
import { claudeConfigRootFor, memberRuntimeHome, seatRuntimeHome } from "../seat-runtime-home.js";
import type { RigRepository } from "../rig-repository.js";
import { shellQuote } from "../../adapters/shell-quote.js";
import { claudeSeatTokenFileProblem, claudeSeatTokenRefProblem, isClaudeSeatTokenFallback, type ClaudeSeatTokenRef } from "../claude-seat-token.js";
import { claudeConfigDirPresent, claudeConfigDirProblem, claudeConfigDirsShareConversation, type ClaudeConfigDirProbe } from "./claude-config-dir.js";
import type { ClaudeSwitchView, PrecheckReason, PrecheckResult } from "./provider-types.js";
import type { ClaudeCredentialPrecedence, ClaudeSeatRelaunch, ProviderPrecheckInput, ProviderSwitchInput, ProviderSwitchResult, SeatSwitchReport } from "./provider-service.js";

/** The account a Claude seat moves to when it goes back to its config dir's stored login (no token reference). */
export const STORED_LOGIN = "stored-login";

type ClaudeSeat = NonNullable<ReturnType<ClaudeSeatRelaunch["seat"]>>;
type ClaudeCheck =
  | { ok: false; verdict: Extract<PrecheckResult, { safe: false }> }
  | { ok: true; verdict: Extract<PrecheckResult, { safe: true }>; ref: ClaudeSeatTokenRef | null; instead: string | null; configDir?: string;
      inheritedConfigDir?: { effective: string; selected: string | null } };

/** What a config-dir check needs beyond the seat: the relaunch's view of the seat's dir and the login probe. */
export interface ClaudeConfigDirDeps {
  relaunch?: ClaudeSeatRelaunch;
  probe?: ClaudeConfigDirProbe;
}

/** A Claude seat's checks, before anything changes: the reference it would get, that its file would give Claude the token,
 *  that the seat is running, and that nothing Claude Code ranks above the token is set. A move back to the stored login also
 *  finds a `CLAUDE_CODE_OAUTH_TOKEN` the seat would still receive, and says it's what the seat will use. Managed settings (a
 *  file, MDM or the server) can't be read; the relaunched seat's /status covers them. */
export async function checkClaudeSeat(input: ProviderPrecheckInput, seat: ClaudeSeat, precedence: ClaudeCredentialPrecedence | undefined,
  configDeps: ClaudeConfigDirDeps = {}): Promise<ClaudeCheck> {
  const refuse = (reason: PrecheckReason, message: string, claude?: ClaudeSwitchView): ClaudeCheck =>
    ({ ok: false, verdict: { safe: false, reasons: [reason], message, ...(claude ? { claude } : {}) } });
  if (!precedence) return refuse("rebind_unsupported_for_runtime", "This daemon can't check what would outrank a Claude seat's own token, so it doesn't move Claude seats.");
  if (input.inheritConfigDir && input.configDir === undefined) return refuse("invalid_config_dir", "An inherited move requires the expected config dir. Nothing changed.");
  if (input.configDir !== undefined) return checkConfigDirMove(input, input.configDir, seat, precedence, configDeps, refuse);
  if (input.tokenFile === undefined) {
    return refuse("token_file_required", "A Claude seat moves to its own subscription token with --to-account <label> --token-file <absolute path to a 0600 "
      + "file holding the token>, or back to its config dir's stored login with --stored-login.");
  }
  const ref = input.tokenFile === null ? null : { label: input.toAccount, tokenFile: input.tokenFile };
  if (ref) {
    const problem = claudeSeatTokenRefProblem(ref);
    if (problem) return refuse("invalid_token_reference", `${problem}.`);
    const fileProblem = claudeSeatTokenFileProblem(ref);
    if (fileProblem) return refuse("token_file_unusable", `${fileProblem}, so Claude would start without it. Nothing changed.`);
  }
  if (!seat.running) {
    return refuse("seat_not_running", `${input.seat} isn't running, so there's no conversation to resume. Launch it first: rig launch ${seat.rigName} ${seat.logicalId}.`);
  }
  const found = await precedence(seat.nodeId, ref ? {} : { storedLogin: true });
  const instead = found.instead?.length
    ? `the CLAUDE_CODE_OAUTH_TOKEN from ${found.instead.map((c) => `${c.source} (${c.remedy})`).join("; ")}` : null;
  const claude: ClaudeSwitchView = { label: ref?.label ?? STORED_LOGIN, tokenFile: ref?.tokenFile ?? null, checked: found.checked, notChecked: found.notChecked,
    ...(instead ? { instead } : {}) };
  if (found.conflicts.length) {
    return refuse("credential_outranks_token", "Claude Code would use these instead, so nothing changed: "
      + `${found.conflicts.map((c) => `${c.name} (${c.source}; ${c.remedy})`).join("; ")}.`, claude);
  }
  return { ok: true, verdict: { safe: true, claude }, ref, instead };
}

/** A move to another account's config dir, checked before anything changes. The seat's own `CLAUDE_CONFIG_DIR` is what changes,
 *  so every check is about the target home: it exists, it holds a claude.ai subscription login (one bounded `claude auth status`
 *  with that dir selected), and nothing would outrank that login at the seat's next launch. A seat that holds its own token
 *  reference isn't moved: the token would keep winning, so the move would change nothing. */
async function checkConfigDirMove(input: ProviderPrecheckInput, dirInput: string, seat: ClaudeSeat, precedence: ClaudeCredentialPrecedence,
  { relaunch, probe }: ClaudeConfigDirDeps, refuse: (reason: PrecheckReason, message: string, claude?: ClaudeSwitchView) => ClaudeCheck): Promise<ClaudeCheck> {
  const problem = input.tokenFile !== undefined ? "a config-dir move can't also name a token file" : claudeConfigDirProblem(dirInput);
  if (problem) return refuse("invalid_config_dir", `${problem}.`);
  const dir = path.resolve(dirInput);
  const view = (extra: Partial<ClaudeSwitchView> = {}): ClaudeSwitchView =>
    ({ label: input.toAccount, tokenFile: null, configDir: dir, checked: [], notChecked: [], ...extra });
  if (!relaunch?.configDir || !relaunch.setConfigDir || !probe) {
    return refuse("rebind_unsupported_for_runtime", "This daemon can't set a Claude seat's config dir or read a config dir's login, so it doesn't move Claude seats between accounts.", view());
  }
  let inherited: { effective: string; selected: string | null } | undefined;
  if (input.inheritConfigDir) {
    if (!relaunch.inheritedConfigDir) return refuse("rebind_unsupported_for_runtime", "The inherited config selection is unavailable. Nothing changed.", view());
    inherited = relaunch.inheritedConfigDir(seat.nodeId);
    if (path.resolve(inherited.effective) !== dir) return refuse("invalid_config_dir", "The inherited config dir changed after this undo command was prepared. Nothing changed.", view());
  }
  if (!claudeConfigDirPresent(dir)) return refuse("config_dir_missing", `${dir} doesn't exist or isn't a directory, so there's no account there to move to. Nothing changed.`, view());
  if (!seat.running) {
    return refuse("seat_not_running", `${input.seat} isn't running, so there's no conversation to resume. Launch it first: rig launch ${seat.rigName} ${seat.logicalId}.`, view());
  }
  const current = relaunch.configDir(seat.nodeId);
  if (input.inheritConfigDir ? current.declared === null : path.resolve(current.effective) === dir) {
    return refuse("already_on_config_dir", `${input.seat} already runs on ${dir}. Nothing changed.`, view());
  }
  const own = relaunch.tokenRef(seat.nodeId);
  if (own) {
    return refuse("seat_has_token_reference", `${input.seat} holds its own token ("${own.label}"), which Claude Code uses ahead of any config dir's login, so a move to ${dir} would change nothing. `
      + `Move it back first: rig provider switch --seat ${input.seat} --stored-login. Nothing changed.`, view());
  }
  const found = await precedence(seat.nodeId, { storedLogin: true, configDir: dir });
  // The stored login is what the move gives the seat, so a token it would still receive (which Claude uses ahead of that login) is
  // a conflict here, not a note: it would leave the seat on the old account.
  const outranking = [...found.conflicts, ...(found.instead ?? [])];
  const checked = [...found.checked, `${dir}/settings.json for credential settings`];
  if (outranking.length) {
    return refuse("credential_outranks_token", "Claude Code would use these instead of the account's stored login, so nothing changed: "
      + `${outranking.map((c) => `${c.name} (${c.source}; ${c.remedy})`).join("; ")}.`, view({ checked, notChecked: found.notChecked }));
  }
  const login = await probe(dir, inherited ? { selected: inherited.selected } : undefined);
  if (login.state === "not_logged_in") {
    return refuse("config_dir_not_logged_in", `${dir} holds no Claude login (claude auth status reports none). Sign in there first (CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude auth login). Nothing changed.`, view({ checked, notChecked: found.notChecked }));
  }
  if (login.state === "unreadable") {
    return refuse("config_dir_login_unreadable", `${dir}'s login couldn't be confirmed (${login.reason}: ${login.detail}), so the seat isn't moved onto it. Nothing changed.`, view({ checked, notChecked: found.notChecked }));
  }
  return { ok: true, verdict: { safe: true, claude: view({ checked, notChecked: found.notChecked }) }, ref: null, instead: null, configDir: dir,
    ...(inherited ? { inheritedConfigDir: inherited } : {}) };
}

/** Move one Claude seat in its own pane, by restore's own resume path: under the seat's lifecycle lease, a snapshot taken
 *  now that resumes the seat, its token reference set, then only that seat relaunched from that snapshot in its pane (its
 *  process ended in place, the pane and its scrollback kept), which reruns `claude --resume <its conversation>` with the
 *  seat's token step. Only a refusal before the seat's process was touched reads as unchanged; anything after it that
 *  doesn't report a resumed conversation reads `unknown`, with the snapshot's recovery, and is never retried. */
export async function switchClaudeSeat(input: ProviderSwitchInput, relaunch: ClaudeSeatRelaunch, seat: ClaudeSeat,
  precedence: ClaudeCredentialPrecedence | undefined, probe?: ClaudeConfigDirProbe): Promise<ProviderSwitchResult> {
  let touched = false;
  try {
    return await relaunch.exclusive<ProviderSwitchResult>(seat.nodeId, async () => {
      // A switch that waited for the seat goes on with the seat as it is now.
      const current = relaunch.seat(input.seat);
      if (!current || current.nodeId !== seat.nodeId) {
        return { outcome: "failed_safely", reasons: ["seat_changed"], message: `${input.seat} changed while this switch waited for it. Nothing changed.` };
      }
      return await switchHeld(input, relaunch, current, precedence, () => { touched = true; }, probe);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!touched) {
      const code = (err as { code?: unknown }).code;
      return { outcome: "failed_safely", reasons: [typeof code === "string" ? code : "seat_unavailable"],
        message: `${input.seat} couldn't be switched (${message}). Nothing changed.` };
    }
    // Its reference was set before the error; what the seat runs isn't known.
    return { outcome: "unknown", reasons: ["relaunch_threw"],
      seat: { seat: input.seat, account: input.tokenFile === null ? STORED_LOGIN : input.toAccount, ...(input.configDir !== undefined ? { configDir: input.configDir } : {}),
        loginChanged: true, peers: [], undo: null },
      message: `${input.seat}'s relaunch stopped with an error after its process may have been ended (${message}). Check the pane with rig capture ${input.seat}. Not retried.` };
  }
}

async function switchHeld(input: ProviderSwitchInput, relaunch: ClaudeSeatRelaunch, seat: ClaudeSeat,
  precedence: ClaudeCredentialPrecedence | undefined, touching: () => void, probe?: ClaudeConfigDirProbe): Promise<ProviderSwitchResult> {
  const checked = await checkClaudeSeat(input, seat, precedence, { relaunch, probe });
  if (!checked.ok) {
    const { reasons, message } = checked.verdict;
    return { outcome: "failed_safely", reasons: reasons as [string, ...string[]], ...(message ? { message } : {}) };
  }
  const { nodeId, rigId, rigName, logicalId } = seat;
  if (!seat.pane) {
    return { outcome: "failed_safely", reasons: ["no_bound_pane"], message: `${input.seat} has no bound tmux pane to relaunch it in. Nothing changed.` };
  }
  const snapshot = relaunch.snapshot(rigId, nodeId);
  if (!snapshot.resumes) {
    return { outcome: "failed_safely", reasons: ["conversation_not_resumable"],
      message: `Snapshot ${snapshot.snapshotId} ${snapshot.why}, so relaunching ${input.seat} wouldn't resume its conversation. Nothing changed.` };
  }
  if (checked.configDir !== undefined) {
    if (!relaunch.canResumeInConfigDir?.(nodeId, checked.configDir, snapshot.conversation)) {
      return { outcome: "failed_safely", reasons: ["config_dir_conversation_unavailable"],
        message: "The target config dir does not reach the same native conversation file. The seat is still running and nothing changed." };
    }
    return moveConfigDir(input, relaunch, seat, snapshot, checked.configDir, touching, checked.inheritedConfigDir);
  }
  const before = relaunch.tokenRef(nodeId);
  const account = checked.ref?.label ?? STORED_LOGIN;
  const report: SeatSwitchReport = { seat: input.seat, account, ...(checked.ref ? { tokenFile: checked.ref.tokenFile } : {}),
    conversation: snapshot.conversation, loginChanged: false, peers: [],
    // The label's characters are limited; a path can hold any but a newline, so it's quoted.
    undo: before
      ? `rig provider switch --seat ${input.seat} --to-account ${before.label} --token-file ${shellQuote(before.tokenFile)}`
      : `rig provider switch --seat ${input.seat} --stored-login` };
  touching();
  relaunch.setTokenRef(nodeId, checked.ref);
  let relaunched: Awaited<ReturnType<ClaudeSeatRelaunch["relaunchInPane"]>>;
  try { relaunched = await relaunch.relaunchInPane(rigId, logicalId, snapshot.snapshotId); }
  catch (err) { relaunched = { ok: false, effect: "unknown", code: "relaunch_threw", message: err instanceof Error ? err.message : String(err) }; }
  if (!relaunched.ok && relaunched.effect === "none") {
    relaunch.setTokenRef(nodeId, before);
    return { outcome: "failed_safely", reasons: [`relaunch_${relaunched.code.replace(/-/g, "_")}`], seat: report,
      message: `${input.seat} wasn't relaunched (${relaunched.code}: ${relaunched.message}) and wasn't touched, so it keeps running as it was, with its token reference as it was.` };
  }
  report.loginChanged = true;
  if (!relaunched.ok) {
    const recoveryCommand = `rig launch ${rigName} ${logicalId} --snapshot-id ${snapshot.snapshotId}`;
    report.restart = { outcome: relaunched.code, message: relaunched.message, recoveryCommand,
      remainingStep: `If the pane (rig capture ${input.seat}) shows no running Claude, stop the seat first (rig seat stop ${input.seat} --reason "<why>"), `
        + `then run the recovery command; it resumes the conversation from snapshot ${snapshot.snapshotId} with the new reference. The way back works once the seat runs.` };
    return { outcome: "unknown", reasons: [relaunched.code === "relaunch_threw" ? "relaunch_threw" : `relaunch_${relaunched.code.replace(/-/g, "_")}`], seat: report,
      message: `${input.seat}'s relaunch in its pane from snapshot ${snapshot.snapshotId} didn't report a resumed conversation (${relaunched.code}: ${relaunched.message}). `
        + "Its process may have been ended. Not retried." };
  }
  const fallback = relaunched.warnings.filter(isClaudeSeatTokenFallback);
  report.warnings = relaunched.warnings;
  report.restart = { outcome: "resumed", message: `Resumed conversation ${snapshot.conversation ?? "(not recorded in the snapshot)"} in the seat's own pane.` };
  if (checked.ref) {
    report.tokenApplied = fallback.length === 0;
    report.next = report.tokenApplied
      ? `After the seat completes a turn with a tool call, its /status shows the auth method it uses: the token (CLAUDE_CODE_OAUTH_TOKEN), with no account email. "${account}" is your label for it; Claude doesn't name the account.`
      : `Fix the token file, then relaunch the seat (or switch it again); until then its /status shows the login it uses instead.`;
    return { outcome: "rebind_in_progress", seat: report, message: report.tokenApplied
      ? `Relaunched ${input.seat} in its own pane on its own token ("${account}"), resuming its conversation. Work in flight when it stopped didn't carry over.`
      : `Relaunched ${input.seat} in its own pane, resuming its conversation, and saved its token reference ("${account}"), but the token didn't take effect: ${fallback.join(" ")}` };
  }
  report.next = checked.instead
    ? `After the seat completes a turn with a tool call, its /status shows the token it uses (CLAUDE_CODE_OAUTH_TOKEN), not the stored login.`
    : `After the seat completes a turn with a tool call, its /status shows the auth method it uses: its config dir's stored login, unless its pane shell exports a token.`;
  return { outcome: "rebind_in_progress", seat: report, message: checked.instead
    ? `Relaunched ${input.seat} in its own pane without its own token, resuming its conversation. It uses ${checked.instead}, which Claude Code ranks above its config dir's stored login.`
    : `Relaunched ${input.seat} in its own pane on its config dir's stored login, resuming its conversation. Work in flight when it stopped didn't carry over.` };
}

/** The move itself, after every check passed and a snapshot that resumes the seat was taken: the seat's own `CLAUDE_CONFIG_DIR` is
 *  set to the account's dir, then the seat is relaunched in its pane from that snapshot, the same path a token move takes. */
async function moveConfigDir(input: ProviderSwitchInput, relaunch: ClaudeSeatRelaunch, seat: ClaudeSeat,
  snapshot: { snapshotId: string; conversation: string | null }, dir: string, touching: () => void,
  inherited?: { effective: string; selected: string | null }): Promise<ProviderSwitchResult> {
  const { nodeId, rigName, logicalId } = seat;
  const before = relaunch.configDir!(nodeId);
  if (input.inheritConfigDir) {
    const current = relaunch.inheritedConfigDir?.(nodeId);
    if (!inherited || !current || current.selected !== inherited.selected || path.resolve(current.effective) !== path.resolve(inherited.effective)) {
      return { outcome: "failed_safely", reasons: ["invalid_config_dir"], message: "The inherited config selection changed during precheck. Nothing changed." };
    }
  }
  const report: SeatSwitchReport = { seat: input.seat, account: input.toAccount, configDir: dir, conversation: snapshot.conversation, loginChanged: false, peers: [],
    ...(input.inheritConfigDir ? { configDirInherited: true } : {}),
    // The way back names the dir the seat ran on, declared or not, so it works for a seat that declared nothing.
    undo: `rig provider switch --seat ${input.seat} --config-dir ${shellQuote(before.effective)}${before.declared === null ? " --inherit-config-dir" : ""}` };
  // A write that fails changed nothing and the seat's process wasn't touched, so it reads as unchanged (the caller's catch).
  relaunch.setConfigDir!(nodeId, input.inheritConfigDir ? null : dir);
  touching();
  let relaunched: Awaited<ReturnType<ClaudeSeatRelaunch["relaunchInPane"]>>;
  try { relaunched = await relaunch.relaunchInPane(seat.rigId, logicalId, snapshot.snapshotId); }
  catch (err) { relaunched = { ok: false, effect: "unknown", code: "relaunch_threw", message: err instanceof Error ? err.message : String(err) }; }
  if (!relaunched.ok && relaunched.effect === "none") {
    relaunch.setConfigDir!(nodeId, before.declared);
    return { outcome: "failed_safely", reasons: [`relaunch_${relaunched.code.replace(/-/g, "_")}`], seat: report,
      message: `${input.seat} wasn't relaunched (${relaunched.code}: ${relaunched.message}) and wasn't touched, so it keeps running as it was, on its config dir as it was.` };
  }
  report.loginChanged = true;
  if (!relaunched.ok) {
    const recoveryCommand = `rig launch ${rigName} ${logicalId} --snapshot-id ${snapshot.snapshotId}`;
    report.restart = { outcome: relaunched.code, message: relaunched.message, recoveryCommand,
      remainingStep: `If the pane (rig capture ${input.seat}) shows no running Claude, stop the seat first (rig seat stop ${input.seat} --reason "<why>"), `
        + `then run the recovery command; it resumes the conversation from snapshot ${snapshot.snapshotId} on ${dir}. The way back works once the seat runs.` };
    return { outcome: "unknown", reasons: [relaunched.code === "relaunch_threw" ? "relaunch_threw" : `relaunch_${relaunched.code.replace(/-/g, "_")}`], seat: report,
      message: `${input.seat}'s relaunch in its pane from snapshot ${snapshot.snapshotId} didn't report a resumed conversation (${relaunched.code}: ${relaunched.message}). `
        + "Its process may have been ended. Not retried." };
  }
  report.warnings = relaunched.warnings;
  report.restart = { outcome: "resumed", message: `Resumed conversation ${snapshot.conversation ?? "(not recorded in the snapshot)"} in the seat's own pane.` };
  report.next = `After the seat completes a turn with a tool call, its /status shows the account it uses (the login stored in ${dir}); confirm it is "${input.toAccount}".`;
  return { outcome: "rebind_in_progress", seat: report,
    message: `Relaunched ${input.seat} in its own pane on the config dir ${dir} ("${input.toAccount}"), resuming its conversation. Work in flight when it stopped didn't carry over.` };
}

/** The seat's config-dir hooks over its stored env, as the route wires them. `declared` is the MEMBER's own `CLAUDE_CONFIG_DIR` (null
 *  when it declares none), because that is what a rollback writes back into the member's env; a dir only the rig declares is not the
 *  member's, and restoring it there would shadow the rig. `effective` is the dir the seat resolves to, wherever it is declared. */
export function claudeSeatConfigDirHooks(rigRepo: Pick<RigRepository, "db" | "setNodeEnvVar">): Pick<ClaudeSeatRelaunch, "configDir" | "setConfigDir" | "inheritedConfigDir" | "canResumeInConfigDir"> {
  return {
    configDir: (nodeId) => ({ declared: memberRuntimeHome(rigRepo.db, nodeId, "claude-code"), effective: claudeConfigRootFor(rigRepo.db, nodeId) }),
    // What the seat would use with its own (member) setting removed: the rig's, else the process's, else Claude's native default.
    // `selected` is null when nothing selects one (native unset), so an undo can restore "unset" rather than pin a path (T3 652bdcf7f).
    inheritedConfigDir: (nodeId) => {
      const home = seatRuntimeHome(rigRepo.db, nodeId, "claude-code", { ignoreMember: true });
      const selected = home.home ?? process.env.CLAUDE_CONFIG_DIR ?? null;
      return { effective: selected ?? path.join(os.homedir(), ".claude"), selected };
    },
    // A resume looks for the conversation under the TARGET dir's projects/ (verified on 2.1.312, see the commit message).
    canResumeInConfigDir: (nodeId, dir, conversation) => claudeConfigDirsShareConversation(claudeConfigRootFor(rigRepo.db, nodeId), dir, conversation),
    // The seat's own (member) env, which restore, launch and handover all read through getEffectiveSeatEnv.
    setConfigDir: (nodeId, dir) => {
      if (!rigRepo.setNodeEnvVar(nodeId, "CLAUDE_CONFIG_DIR", dir)) throw Object.assign(new Error("the seat's env couldn't be written"), { code: "seat_env_unwritable" });
    },
  };
}
