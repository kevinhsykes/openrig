import type Database from "better-sqlite3";

/**
 * The agent a `terminal` seat runs, for Herdr's tile hint.
 *
 * A terminal seat has no agent runtime of its own: it is a shell, and what runs in it is whatever its
 * startup types. Pi chat-screen seats are declared that way, as one `send_text` action whose command is
 * `env NAME=value… pi --no-approve …`. The persisted startup actions are therefore the declared fact.
 * Nothing here reads a pane's screen or argv, and a seat whose startup does not start pi gets no hint.
 */

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Split one line into shell words, honouring single quotes, double quotes and backslash. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/** True when the line's command word, after an optional `env` and any `NAME=value` words, is `pi`. */
function lineStartsPi(line: string): boolean {
  const words = shellWords(line);
  let i = words[0] === "env" ? 1 : 0;
  while (i < words.length && ASSIGNMENT.test(words[i]!)) i++;
  const command = words[i];
  return command !== undefined && command.slice(command.lastIndexOf("/") + 1) === "pi";
}

/** True when any typed-text startup action in the persisted record starts pi. False for anything unreadable. */
export function startupActionsLaunchPi(startupActionsJson: string | null | undefined): boolean {
  if (!startupActionsJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(startupActionsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((action) => {
    if (typeof action !== "object" || action === null) return false;
    const { type, value } = action as { type?: unknown; value?: unknown };
    return type === "send_text" && typeof value === "string" && value.split("\n").some(lineStartsPi);
  });
}

/**
 * The Herdr agent hint for a node, read from its persisted startup context. Only a `terminal` runtime is
 * asked: every other runtime says what it is, and its record is not read. Null when there is no hint, no
 * node, no record, or no table (an older database).
 */
export function terminalAgentHint(
  db: Database.Database,
  nodeId: string | null | undefined,
  runtime: string | null | undefined,
): "pi" | null {
  if (runtime !== "terminal" || !nodeId) return null;
  try {
    const row = db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as
      | { startup_actions_json: string | null } | undefined;
    return startupActionsLaunchPi(row?.startup_actions_json) ? "pi" : null;
  } catch {
    return null;
  }
}
