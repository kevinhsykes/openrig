// The refusals a Claude seat's move to another account's config dir adds to `PrecheckReason`. Kept apart so the locked provider
// types take one spliced line, and nothing else, for them (additive evolution only).
export type ClaudeConfigDirPrecheckReason =
  | "invalid_config_dir" // the config dir isn't an absolute one-line path, or came with a token file
  | "config_dir_missing" // the target account's config dir doesn't exist (or isn't a directory)
  | "config_dir_not_logged_in" // `claude auth status` for the target config dir reports no login
  | "config_dir_login_unreadable" // the target's login couldn't be read, or isn't a claude.ai subscription login
  | "already_on_config_dir" // the seat already runs on that config dir
  | "config_dir_conversation_unavailable" // target does not reach the same native transcript
  | "seat_has_token_reference"; // the seat's own token would outrank the target dir's login: move it back to the stored login first
