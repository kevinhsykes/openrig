# Native Pi terminal lifecycle

RPC remains the default Pi interface. The explicit `OPENRIG_PI_INTERFACE=tui` selection applies at launch. Native TUI resume retains its recorded interface and exact session file. Invalid selections refuse. This source path is not yet ready for team rollout: automatic message and startup-text delivery refuse until the typed SDK input path is connected. They never fall back to a terminal paste.

The runner starts Pi's real terminal UI with inherited terminal streams and an explicit lifecycle extension. The extension reads identity from Pi's public session context. Readiness requires a native TUI context, the current launch attempt, and the requested session boundary. It posts activity through the existing OpenRig activity endpoint. It records no physical model identity or independent acceptance.

Each native launch writes a separate lifecycle file. The shared runner state selects one launch; readers ignore files from other attempts. A retiring UI can finish its own file without replacing the next launch's pending state or cursor. Native idle heartbeats require Pi's positive typed idle state. Shutdown and child exit clear readiness. An unavailable activity endpoint does not become a model or quality receipt.

The native path retains the existing provider environment allowlist and managed agent/session directories. It does not copy credentials or choose another provider. Native usage-fact and OpenRouter-charge capture are not implemented; requesting them with this interface refuses before launch.

Validation includes unchanged RPC cases, current/stale launch selection, exact native resume, typed lifecycle and idle events, and refusal before automatic paste or Enter. A real Pi 1.4 CLI canary runs through the compiled runner in an isolated network namespace. It verifies native UI mode, canonical policy context, exact seeded history and launch-scoped readiness. A planted wrong-session selection must never become ready, even when the CLI exits successfully. These fixtures make no model calls and do not establish live team acceptance.
