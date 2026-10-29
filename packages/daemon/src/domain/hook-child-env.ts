// The environment an operator-configured helper command (the destination check hook, the model resolver) is started with.
//
// The daemon's own environment can hold keyring-derived variables, provider tokens and OpenRig identity. A helper is configured by
// an operator and is not a trust-boundary break, but it is exactly where secrets-adjacent tooling gets hung, so it receives an
// allowlist, never `process.env`. Names are matched exactly; a value that is not a string is dropped.

/** What a helper may see: how to find programs and a scratch directory, the locale and zone, and the OpenRig home (a path, not a
 *  credential) because the fleet checkers locate their state from it. No OPENRIG_URL, OPENRIG_PORT, identity, token or key. */
export const HOOK_CHILD_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "OPENRIG_HOME"];

export function hookChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of HOOK_CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}
