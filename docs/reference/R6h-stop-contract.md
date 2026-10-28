# R6 — Seat stop / settle / flush contract (spec only — no code)

> **AMENDMENT 2026-10-28 (R6h, row qitem-20261028180608-f3ea323f8aa1134f) — SUPERSEDES R6g `9bcb4b4f…` (REVIEWED, NOT CLEAN: Claude ACCEPT-WITH-FIXES — §3b's "identity seen at last read / names the launch / identity-pinning" wording claimed more on 0.6.13 than the locked text allows, and §5.3c(b) called the echo-or-refuse probe the "ONLY protection" on 0.6.13).**
> Locked v3 text (`e5c037f7…`) UNTOUCHED — verified verbatim exactly twice after the edits.
> Changes: (1) §3b's bounded guarantee now uses the worked-example wording — generation-pinned at
> last read, session identity unresolved, residual post-check/pre-stop race — and notes "names the
> launch" holds only on checked-stop daemons where `expected.sessionId` is sent; (2) §5.3c(b): the
> echo-or-refuse probe (h)(ii) is only how a caller that SENDS a generation learns the daemon
> ignored the field — the stop's protection on 0.6.13 is the caller's two checks plus the stated
> residual race; (3) typos: duplicated "A repo-side fix" dropped, garbled header phrase fixed;
> (4) §1.3a ties the two c660c21 statements together (the node record it re-reads includes the
> session, but it compares generation only). R6g MiniMax review: DOES NOT EXIST at freeze time
> (only Claude's). Swept: no sentence outside the locked text claims more for `c660c21` or the
> runtime than the locked text does.
>
> **AMENDMENT 2026-10-28 (R6g, row qitem-20261028175533-cc85d89c5ff9f0f0) — SUPERSEDES R6f `4616a96b…` (REVIEWED, NOT CLEAN: Claude ACCEPT-WITH-FIXES — §7.3 was false for the installed runtime and §6 xref'd the wrong section behind the bare phrase "UNPATCHED daemon"; canonical v3 additionally supersedes v2's exhaustive installed-refusal-list claim, which under-counted installed stopSeat's refusal/error paths).**
> Locked-text source: kevinsykes-ai canonical v3, sha256
> `e5c037f7521dc58aa4883bdfefeec44815576d2b57aad7f321aba22453c35128`, verified at copy time; the v2
> text (`60664e3d…`) is replaced by v3 VERBATIM in §5.3b and §5.3c(b), and v2's exhaustive
> installed-refusal phrasing appears nowhere in this revision. Other changes: (1) the worked example is
> REWRITTEN per the kevinsykes-ai ruling of 17:55Z — `c660c21` currently FAILS the
> session-identity requirement (it rechecks generation only), two separate reads are not a fence,
> and the residual post-check/pre-stop race is stated unless a serialization/fencing seam every
> handover path honors is shown; it is no longer presented as a complete worked example;
> (2) §7.3 scoped per daemon (installed 0.6.13: the caller does the generation AND
> session-identity checks itself — no `expected` exists there; checked-stop daemons: the daemon
> enforces the `{nodeId, sessionId}` pair); (3) §6 names installed-vs-checked-stop instead of
> "UNPATCHED daemon" and xrefs §5.3b/§5.3c(b) (was §5.3a); (4) body owner line reads "(configured
> family GLM)". R6f MiniMax review: DOES NOT EXIST at freeze time (only Claude's), so no MiniMax
> findings are folded. R6e/R6f are not citable; reviews bind only to this revision's full hash.
>
> **AMENDMENT 2026-10-28 (R6f, row qitem-20261028172655-a349e647c6077105) — SUPERSEDES R6e `564982c2…` (REVIEWED, NOT CLEAN: R6e's §1.6b and contract sentence claimed the installed 0.6.13 runtime refuses a stop whose session id is not the latest — FALSE for the installed daemon, which takes no `expected` and performs no session-id check; on 0.6.13 a stale stop after a HANDOVER stops the NEW occupant).**
> Locked-text source: kevinsykes-ai canonical v2, sha256
> `60664e3d28f5b49fcae589abf8df56cfe3b47e49aeb390712bc4fe7082978dbe`, verified at copy time; the
> 16:43Z and 16:37Z wordings appear nowhere in this revision. Changes: (1) the caller-responsibility
> contract is the canonical text VERBATIM, scoped by daemon, in §5.3b and §5.3c(b); (2) §1.6b
> restated — the installed 0.6.13 refuses a stale stop in NEITHER case (handover or restart in
> place; the caller checks generation AND session identity), while checked-stop daemons (this fork,
> upstream `6957751 stopSeatChecked`) refuse a stale session id (handover) and the caller closes
> restart-in-place; (3) §5.3c(a) body: the `:1001` refusal is in `stopSeat`, not `stopSeatChecked`
> (MiniMax R6e nit); (4) provenance named per claim — installed facts from installed source
> `seat-lifecycle-service.js:593-625`, checked-stop facts from the fork and upstream `6957751`;
> (5) worked example: the repo-side retire path (`c660c21`) performs BOTH caller checks; (6) every
> claim about "the runtime" names WHICH runtime. Wording-only.
> Owner: workers-builder2@openrig-fork (configured family GLM).
>
> **AMENDMENT 2026-10-28 (R6d final, lead 17:08Z, row qitem-20261028170848-3b0533ef2dd79178) — supersedes the 47c321e3 pass of R6d (NEVER REVIEWED: it inserted a superseded sentence and missed the handover/restart split, the migration hazard, and the full-hash freeze).**
> This revision: (1) the kevinsykes-ai sentence is the FINAL 16:43Z text verbatim (adds the
> ignored-field false-assurance clause and the handover vs restart-in-place clause); (2) §1.6b
> states the split: the runtime refuses a stale SESSION ID (covers a HANDOVER); a generation change
> that leaves the session id unchanged (a RESTART IN PLACE) is the gap the caller closes — the
> installed runtime refuses after handover, NOT after restart in place; the runtime never "refuses
> stale occupants"; (3) the migration hazard is stated: upstream's 400-on-extra-keys and the
> installed runtime's ignore are DIFFERENT contracts, and a caller written against upstream's
> strictness is silently mis-served by the installed runtime — the hazard is the silent drop;
> (4) the frozen copy carries the full sha256 in its name with a .sha256 sidecar (custody rule,
> CONTEXT.md). Wording-only otherwise.
>
> **AMENDMENT 2026-10-28 (R6d, row qitem-20261028163649-ac9c15061f4cb79a) — SUPERSEDES R6c `e8b3d8c0133beddd2293ae30a98530908e2b2935eff23139ff170a1e87fe21ef`.**
> Why: (i) §1.6b's retry/B5 statement was internally inconsistent — a handover launch ALREADY changes
> `latestSession().id` and already fails B5 today (`selection_changed` + `partialEffect`); and a
> stale-keyed retry is refused at B1 as `selection_changed`, it cannot also land on
> `already-exited`; the normative retry is now stated correctly and the test asserts exactly that;
> (ii) citation fixes from REV-R6c: the `invalid_stop_precondition` refusal at `:1001` is in
> `stopSeat` (not `stopSeatChecked`), the 400 mapping is `routes/seat.ts:364`,
> `model-observation.ts` `generation` is `:7` (not :11), upstream `stopSeat` is `:997` (not 1001);
> (iii) the installed-runtime residual UNVERIFIED is RESOLVED as verified: the installed stop route
> builds its input from named fields only, so an extra `expected` is IGNORED at the HTTP layer;
> (iv) the kevinsykes-ai caller-responsibility contract sentence is inserted verbatim in §5.3c(b)
> and §5.3b. Text-only revision otherwise (REV-R6c verdicts: Claude ACCEPT-WITH-FIXES [CONFIGURED
> family, per its header]; MiniMax ACCEPT [CONFIGURED family]; both folded). **Reviews of e8b3d8c0
> do not carry over.**
>
> **AMENDMENT 2026-10-28 (R6c, row qitem-20261028160550-98b863fcfcb1b0f7) — SUPERSEDES R6b.**
> This revision supersedes R6b `0d8f9877ba9424254fede8f608c3718d013a50ddcbabb8a33478260588acb675`
> because (i) R6b's older-daemon premise ("an older daemon DROPS the unknown field silently") is
> CONTRADICTED by upstream 6957751 `seat-lifecycle-service.ts:236-242,1001`: `validStopPrecondition`
> accepts EXACTLY the key set {nodeId, sessionId} and REFUSES any extra key with 400
> `invalid_stop_precondition` — a conservative failure, not a silent drop (the REV-P16 silent-drop
> lesson applies to the queue update route, which copies named fields; the stop precondition
> whitelist is the opposite shape); and (ii) the text fixes from both R6b reviews
> (missions/reviews/R6b-0d8f9877-claude-sonnet-5-5.md ACCEPT-WITH-FIXES findings 1-6;
> missions/reviews/R6b-0d8f9877-minimax-m3.1-flash.md citation corrections 1-4) are folded in:
> re-scoped R4.2/(e)(ii), per-daemon expected-field behaviour (§5.3c), B5 retry behaviour (§1.6b),
> codes named once (R1.1/(h)), line-cite corrections, column-absent settle rule (R2.3a), and the
> citation-vintage note (§1.0). **Reviews of 0d8f9877 do not carry over to this revision.**
>
> **AMENDMENT 2026-10-28 (R6b, row qitem-20261028155409-3aef4c7078cbd6c1)** — amended in place
> for lead-lead@kevinsykes-ai's review, on their 15:53Z reply: (1) the shared generation signal is
> named (§5, §6, §7); (2) continuation semantics are stated (§1.3, new §1.6); (3) the bounded
> guarantee of a non-generation-scoped stop path is stated explicitly (§5, §6); (4) every effect
> boundary of the checked stop is enumerated with file:line (new §1.6); (5) the refuse-when-absent
> acceptance case (h) is added (§4, §5.3c); (6) a review-evidence-limits note is added (§10). The
> retirement fix this aligns with is kevinsykes-ai
> `c660c21ec8a2bb56d0641567401f93887c9235bd` (captures `modelObservation.generation` at settle,
> re-reads it before stop).

Owner: workers-builder2@openrig-fork (configured family GLM), for lead-lead@kevinsykes-ai's packet
`qitem-lead-fork-stop-under-hold-contract-spec-20261028T1320Z`. Row qitem-20261028131953-31f9328c.
Sources read: fork `9cc3759` (fork/integration merge of P8) and upstream main `6957751` — the stop
surface is byte-equivalent in both (the fork's P-patches do not touch it), so every seam below
cites both where they differ, otherwise once.

### 1.0 Citation vintage (R6c; updated R6d)

**Every line number is against 6957751 / 9cc3759.** INT2 (fork/integration `e3222fd49`, 2026-10-28)
landed P13/P16/P14c/P18/P17; P14c/P18 add ~90 lines to seat-lifecycle-service.ts and terminal files
BEFORE the stop path, so stop-path cites — including the B1-B5 lines in §1.6 — MOVE on the
integration head and again on `6863aadf2` (INT3); re-cite from the integration head at
implementation time. The repo-side fix in flight (workers-packet-retirefix2,
row c8d67be6) is NOT duplicated; §7 lists the seams it must call.

## 1. Today's behaviour, mapped

### 1.1 The stop path

| Step | Where |
|---|---|
| CLI `rig seat stop` | `packages/cli/src/commands/seat.ts:1271-1289` → `runLifecycleVerb("stop", …)` |
| Entry | `stopSeat()` `packages/daemon/src/domain/seat-lifecycle-service.ts:997` (identical at upstream :997) |
| Checked variant (caller passes `expected`) | `stopSeatChecked()` same file `:1043`; precondition validated by `validStopPrecondition()` upstream `6957751:236-241` — **keys on EXACTLY `{nodeId, sessionId}` and REFUSES any extra key** (per §5.3c(a)); no occupant generation field exists |
| No session row | refusal `no_session` (`:1013-1014`) |
| Adopted session | refusal `claimed_session` (`:1016-1022`) |
| Liveness probe | `probeLiveness(session, "stop refuses rather than kill blind")` (`:1028`) — a transport blip is INDETERMINATE (`tmux_probe_failed`), never fabricated absence (KI-5.3-8) |
| Already-exited seat | refusal `session_not_live` (`:1030-1037`) — **prompt, single probe, no retry**; guidance points at `rig seat clean` |
| The kill + persist | `stopManagedTmuxSeat()` `:1842-1914`: `killSession` (checked path re-validates selection + `guard.checkInput` as `beforeEffect`), then one transaction: `markIntentionallyStopped` / `updateStatus("exited")` + `clearBinding` + `session.stopped` event; then `rebindLifecycle`. Partial effects are named: `partialEffect` + `stopPhase: "kill_attempted"`, and the uncertain outcomes `selection_changed` / `stop_uncertain` |
| Checked-stop error mapping | `:1075-1081`: guard target changed → `selection_changed`; `typing_guard_enabled` / `draft_aware_lifecycle` → `typing_guard_enabled` |

### 1.2 The typing guard (why stop-under-hold refuses)

- Guard modes and `holds()`: `packages/daemon/src/domain/seat-delivery-guard.ts:99-102` — with no
  classified input (lifecycle work is exactly that), a seat is held iff `mode === "hold"`.
- Every writing lifecycle op enters `operation()` (`:256`), which throws
  `DeliveryGuardError("typing_guard_enabled", …)` when the desired or effective mode holds (`:269`).
  `DeliveryGuardError.getResponse()` turns that into a 409 with the code preserved (`:29-33`).
- `lifecycle()` (`:344-364`) additionally refuses `draft_aware_lifecycle` when an active protected
  seat's input is not positively absent (`:355`).
- **The unchecked stop is NOT exempt**: `stopSeat` joins the guard via
  `guard.lifecycle([nodeId], …)` (`seat-lifecycle-service.ts:1008`), so packet_seat.py's
  hold-then-stop ordering hits `typing_guard_enabled` at runtime exactly as reported.
- **A mechanical bypass exists and must stay unused**: `operation(name, fn, held, {override: true})`
  skips the holds check (`:267`: `if (!input?.override && …holds…) throw` at `:269`). Nothing today passes
  override from the stop path. The contract forbids stop from ever gaining one (§3 R4).

### 1.3 Occupant generation (exists — the contract should reuse it, not invent one)

- Tenures: `mintOccupantTenure()` `packages/daemon/src/domain/session-registry.ts:402-433`
  (`occupant_tenures(node_id, generation_ordinal, generation_uuid, kind, native_session_id_at_boot)`;
  a returning native session id is a CONTINUATION, no new generation — `:405-413`).
- Live-generation resolvers: `currentOccupantTenure()` `:433`, `currentOccupantGenerationForSession()`
  `:444` (null = UNKNOWN, never a match — the ghost-stage rule).
- The guard target already carries the generation: `resolveGuardTarget()` selects
  `(SELECT generation_uuid FROM occupant_tenures … ORDER BY generation_ordinal DESC LIMIT 1)` as
  `occupant` (`seat-delivery-guard.ts`, resolveGuardTarget query, ~`:505-530`).
- The queue already generation-keys claims: `claimed_by_generation_uuid` written at claim
  (`queue-repository.ts:2708-2721`, column detection `:1033`) and cleared on close/reopen (`:2783`).
  Pending wakes live in `queue_transition_wakes` (migration `073_queue_transition_wakes.ts`).
- The compaction enforcer already consumes gen-scoped gates and knows the code
  `typing_guard_enabled` (`claude-compaction-enforcer.ts:132`).

### 1.4 What stop does NOT know today

No settle step exists: nothing checks claimed queue rows, pending wakes, an in-flight guard lease
(in-memory — not observable from a fork patch), or a mid-typing turn before the kill. Stop never
retries and never files a queue row; refusals live only in the call response (the stop-failed row
in the defect report is filed by the repo script, not the runtime). A handover does not invalidate
any pending stop because no pending-stop object exists to invalidate — a stop's only memory is the
caller's `expected` precondition and the session rows it later reads.

### 1.5 Outcome table (today)

| Seat state | Stop returns |
|---|---|
| live, unmanaged origin | `ok: true` + `{seat, sessionName, sessionId}` (kill observed via adapter result + probe discipline) |
| no session row | `no_session` (refusal) |
| adopted session | `claimed_session` (refusal) |
| exited / absent in tmux | `session_not_live` (refusal, prompt) |
| guard hold / draft-aware active | `typing_guard_enabled` 409 (or `draft_aware_lifecycle`), mapped to one code on the checked path |
| probe indeterminate | `tmux_probe_failed` (refusal, no kill) |
| race during checked stop | `selection_changed` / `stop_uncertain` + `partialEffect` + `stopPhase` |

## 2. Upstream prior art

NOT FOUND. Queries against `mvschwarz/openrig` (issues + PRs, 2026-10-28): `"typing guard stop"`,
`"stop"`, `"occupant generation"`, `"settle drain"`, `"guard lifecycle"`, PRs `"stop guard"`. Closest
hits are unrelated (#1531 lifecycle ask-list drop, #2203 launch-bound Pi delivery, #766 queue create
waiting on terminal delivery). No issue or PR addresses stop-under-hold, generation-keyed stop, or a
settle/drain contract. The field is open.

## 3. The contract — six requirements as testable statements

**R1 — GENERATION KEYING.**
1.1 A stop request MAY carry `expected.occupantGeneration` (uuid). When present, the effect phase
re-reads `currentOccupantTenure(nodeId)` and proceeds only on an exact match. The refusal codes are
named ONCE, by premise state (this resolves R1.1/(h) to a single mapping):

- generation well-formed (a uuid) but NOT the live tenure's → `selection_changed` (reuse; no second
  code — it is the same fact: the seat identity moved under the caller);
- generation MALFORMED (present but not a uuid string) → `invalid_stop_precondition` (reuse). This
  requires extending `validStopPrecondition`'s whitelist to
  `{nodeId, sessionId, occupantGeneration?}` — the current whitelist accepts exactly
  `{nodeId, sessionId}` and rejects ANY extra key (`6957751:236-242`); the extension is part of the
  upstream change, not a free rider.

1.2 The generation comparison happens at EVERY effect boundary the checked stop already re-validates
(the `selection()` closure at `:1055`, post-probe `:1070`, `beforeEffect` at kill `:1851`, final tx
`:1877`) — the same places `sessionId` is checked today (§1.6 table is authoritative; R1.2 matches it).
1.3 A handover or new launch mints a new tenure (existing behaviour), which invalidates any stop
expecting the previous generation **by construction** — no new invalidation mechanism is required;
the test is that no stop keyed to generation N can kill a generation-N+1 process.
1.4 A stop with no `expected` carries no generation promise and keeps today's semantics (it targets
the seat's latest session). The contract does not require generation keying for unchecked stops.

### 1.3a CONTINUATION: what is compared when the generation does NOT change

`mintOccupantTenure` treats a returning native session id as a CONTINUATION — same
`generation_uuid`, no new tenure (`session-registry.ts:405-413`). A continuation is a NEW launch of
the same conversation identity (e.g. claude crashes and is relaunched with `--resume <id>`): the
tenure continues AND a new session row is inserted (every launch writes one). Two consequences the
contract makes explicit:

- **Generation comparison alone is insufficient.** After any relaunch — including a continuation —
  the same generation_uuid denotes a different OS process in a different tmux session. A stop
  intent captured before the relaunch would compare equal on generation and kill the
  reincarnation. Generation keys the CONVERSATION incarnation; it must never be the only
  precondition.
- **A session-id comparison alone is wrong in the other direction** for the same event: it would
  also refuse — correct for safety, but it cannot distinguish "the conversation moved" from
  "someone else took the seat".
- **What IS compared: generation AND session id, always together.** The checked stop already
  compares `latestSession(nodeId).id === expected.sessionId` at every boundary (§1.6); the
  amendment adds `currentOccupantTenure(nodeId).generationUuid === expected.occupantGeneration` to
  the same predicate. The pair means: "the same launch (sessionId) of the same conversation
  incarnation (generation)". Any relaunch — continuation or not — changes sessionId, so a pending
  stop is refused `selection_changed` and the caller re-reads and re-decides. That is the intended
  conservatism: a stop intent never outlives the launch it was made under.
- The retire fix (`c660c21`) does the caller-side generation half (captures
  `modelObservation.generation` at settle, re-reads before the stop) but currently FAILS the
  session-identity requirement: the node record it re-reads includes the session, but it compares
  generation only — and two separate reads are not a fence. §5.3b states its residual
  post-check/pre-stop race on the installed runtime, which checks neither generation nor session
  identity.

### 1.6 The effect boundaries of the checked stop, enumerated (9cc3759; identical at 6957751)

(Line numbers here also move on `e3222fd49`/`6863aadf2` — see §1.0.)

The sessionId comparison lives in ONE closure — `selection()` (`seat-lifecycle-service.ts:1048-1052`:
`resolveSeat(seatRef).nodeId === expected.nodeId && latestSession(nodeId)?.id === expected.sessionId`)
— evaluated at every effect boundary:

| # | Boundary | Where | What is re-validated |
|---|---|---|---|
| B1 | entry, before the lifecycle lease | `:1055-1056` | nodeId + sessionId |
| B2 | inside `guard.lifecycle`, after the lease is acquired | `:1060-1061` (+ `checkInput` `:1062`) | nodeId + sessionId; guard lease/input gate |
| — | resolved-seat re-check after resolve | `:1064` | nodeId only |
| B3 | after the liveness probe | `:1070-1071` (+ `checkInput` `:1072`) | nodeId + sessionId |
| B4 | pre-kill, inside the adapter's `killSession` via `beforeEffect` | `stopManagedTmuxSeat` `:1851-1854` | nodeId + sessionId; guard lease/input gate |
| B5 | pre-persist, inside the final transaction | `:1877-1879` | nodeId + sessionId; guard lease/input gate |

Two further boundaries exist but validate OTHER identity: the guard's own `assertCurrent` re-checks
the guard TARGET (node + binding) wherever a lease is used (`seat-delivery-guard.ts`, `ownsLifecycle`
`:285-289`), and `checkInput` gates hold-mode/draft state — neither compares sessionId or
generation. Post-kill there is nothing left to protect (the kill already happened; B5's transaction
then records it).

**B5 after a handover launch, and the retry contract (R6f — restates R6d's §1.6b, which was false
for the installed runtime).**
On CHECKED-STOP daemons (this fork; upstream `6957751 stopSeatChecked`): every launch inserts a new
session row (§1.3a, `session-registry.ts:278`/`:299`), so a handover that launches a successor
already changes `latestSession(nodeId).id` and fails B5 today — the transaction returns
`selection_changed` with `partialEffect: true`, `stopPhase: "kill_attempted"`, and the session
row/binding are not updated. The generation term does NOT change that case; it is defence in depth
(it would also catch a tenure change WITHOUT a new session row, which §1.3a says does not occur —
a RESTART IN PLACE, the one case the session-id check cannot see because that check is
generation-agnostic; the caller closes it, §5.3b). On the INSTALLED runtime (0.6.13) there is no
`expected`, no B1-B5 and no session-id check at all: a stale stop is refused in NEITHER case —
after a HANDOVER it stops the NEW occupant, and after a restart in place it stops the live occupant
of the same session (§5.3c(b); provenance from the installed source,
`seat-lifecycle-service.js:593-625`). No runtime "refuses stale occupants". The retry behaviour
below is CHECKED-STOP behaviour: a retry still keyed to the OLD `expected` is refused at B1 as
`selection_changed` — never a second `killSession`; the caller then re-reads and decides (re-key to
the successor and stop it, or stand down). Only a caller explicitly re-keyed to the successor can
reach `session_not_live` for the target or stop the successor. Test: the (b) scene timed between
kill and persist, then the retry asserting the stale-keyed refusal is `selection_changed` with NO
second `killSession`, and (separately) a re-keyed retry behaving as the caller chose.

**The generation comparison must sit on exactly B1-B5 — which is one edit, inside the `selection()`
closure — and nowhere else.** No boundary beyond B1-B5 is needed on the checked path: B4 is the
last point before an irreversible effect, and B5 guards the record, not the process. What the
checked path does NOT cover today: the UNCHECKED path (`stopSeat` without `expected`, `:997-1041`)
has NO re-validation boundaries at all — it is implicitly generation-unscoped, and the contract
leaves it that way (R1.4). Extending scoping to unchecked stops would need an implicit
read-compare-effect wrapper around the whole path — an upstream decision (§5), not a fork obligation.

**R2 — SETTLE BEFORE STOP.**
2.1 In-flight work for a generation N is DEFINED as the union of:
  (a) queue rows with `state IN ('in-progress','blocked')` and `claimed_by_generation_uuid = N`;
  (b) pending wakes in `queue_transition_wakes` belonging to rows under (a);
  (c) an active guard lease (delivery, lifecycle or human) on the node;
  (d) a staged-but-unsubmitted typing turn (`lease.staged` / retained input frame) on the node.
2.2 A stop that observes any of (a)-(d) returns the named refusal `generation_not_settled` (new code)
naming WHICH surfaces are live. It must not kill, must not partial-effect, and must be re-issuable.
2.3 The drain decision is RECORDED: the successful stop's `session.stopped` event (or the stop
response) carries the observed-drain snapshot — counts per surface at effect time — so "no stop
before drain" is an observed property, not an intention.
2.3a **Column-absent case (R6c).** The repo detects the `claimed_by_generation_uuid` column at
runtime (`hasClaimedGenColumn`, `queue-repository.ts:1033`). When the column is ABSENT, a stop
request that asks for surface (a)/(b) drain evidence must return `generation_not_settled` with the
schema-unknown reason surfaced — i.e. settle evaluates to UNKNOWN and REFUSES, never to "settled".
An unobservable surface may not be reported as a drained one.
2.4 Settle is a PREDICATE, not a wait loop: the runtime does not block draining; it refuses and lets
the caller retry after the work settles. (A future drain-and-wait mode is upstream's call; see §5.)

**R3 — ONE OUTCOME, HONESTLY REPORTED.**
3.1 Stop returns exactly one of: `stopped` (with the observed effect: session name, stop phase),
`already-exited` (the seat's latest session row is terminal or tmux positively reports absence),
or a named refusal from the existing code set.
3.2 Success is never reported without observed effect: the kill result must be adapter-confirmed
(today: `kill.ok` + probe discipline); on `stop_uncertain` the response says so and carries
`partialEffect`/`stopPhase` (already true — keep).
3.3 The already-exited outcome must be prompt (one probe, no retry loop) and must be distinguishable
from never-launched (`no_session`). Whether already-exited is ok-shaped (`{ok:true, outcome:
"already-exited"}`) or remains the `session_not_live` refusal is an upstream API decision (§5) — the
contract requires only that the two are distinguishable, prompt, and side-effect-free.
3.4 The conflation note: today `session_not_live` covers both an exited seat and a tmux-absent
session with stale rows; `rig seat clean` is the recovery for the latter. Keep that split honest in
whichever shape upstream picks.

**R4 — NO GUARD WEAKENING, NO ALTERNATE STOP PATH.**
4.1 The stop path must not pass `input.override` to `operation()` (the only guard bypass,
`seat-delivery-guard.ts:267` with the throw at `:269`) and must not acquire a lease that skips `holds()` (no custody-lease
reuse for stop: custody origin cannot authorize lifecycle — `ownsCustody` at `:292` and
`checkInput` at `:395` already enforce this).
4.2 No second stop mechanism: within the **stop-purpose chain** — the single-seat `rig seat stop`
surface — `killSession` is reachable only via `stopSeat`/`stopSeatChecked` (`:997`/`:1043`) →
`stopManagedTmuxSeat`; `cleanSeat` refuses live seats (`session_live`, `:1129`); the contract
forbids adding a route that kills under hold. **Scope note (R6c):** `killSession` has other callers
outside the stop chain — `rig-lifecycle-service.ts:545` (rig stop kills `latest_session_name`),
`seat-lifecycle-service.ts:2090`, `rig-teardown.ts:210`, `restore-orchestrator.ts:903/1409/1426`,
`rigspec-instantiator.ts:179/1809`. Those are OUT OF SCOPE for the generation pin (they are not the
single-seat stop surface; pinning them would need its own audit of whether each passes through the
guard) — a grep pin claiming "all stop-purpose callers" would fail on day one. The pin for (e)(ii)
is exactly: `stopSeat`/`stopSeatChecked` → `stopManagedTmuxSeat` → `killSession`, with the
`selection()` generation term inside `stopManagedTmuxSeat`'s beforeEffect and tx. Auditing the
out-of-chain callers for guard use is a separate follow-up, not part of R6.
4.3 If the guard holds, stop is refused `typing_guard_enabled` with guidance to change the guard
mode explicitly — the seat is left exactly as it was (no binding change, no status write, no event).
Testable as a no-partial-state assertion.

**R5 — RETRY VISIBILITY.**
5.1 The runtime performs ONE stop attempt per call and never loops; every refusal names its cause
(existing codes + `generation_not_settled`).
5.2 If a caller (repo script) files a stop-failed row, the row MUST name: owner seat, target
generation, the refusal code, and close itself when a later stop reaches a terminal outcome. The
runtime's obligation is only to make the refusal code + generation observable (see §5, generation
surface).

**R6 — IDEMPOTENCE.**
6.1 Repeating the same stop for the same generation is safe: the second call observes either
`already-exited` or the same refusal as the first, performs at most one additional probe, and writes
no second `session.stopped` event, no second binding clear.
6.2 A repeated stop must never resurrect, adopt, or re-bind anything.

## 4. Acceptance tests (a)-(g) as concrete shapes

All on a new `packages/daemon/test/seat-lifecycle-stop-contract.test.ts`, built on the established
harness (`seat-handover-sources.test.ts` pattern: fake tmux adapter + seeded rig/node/session +
`SeatHandoverService`-style injected `sleep`/clock; guard preferences seeded via the delivery-guard
tables as `claude-handover-readiness.test.ts` does).

- **(a) live generation settles then stops** — seed a live seat at generation N with one claimed row
  keyed `claimed_by_generation_uuid=N` + one pending wake; call the checked stop expecting N;
  assert `generation_not_settled` naming both surfaces; close/reopen the row (drain), call again;
  assert `ok:true`, adapter `killSession` observed, `session.stopped` event carries the drain
  snapshot, binding cleared exactly once.
- **(b) generation N never touches N+1** — mint tenure N, issue the checked stop expecting N, then
  `mintOccupantTenure(node, …)` (handover) BEFORE the effect boundary; assert `selection_changed`,
  `killSession` NOT called for the N+1 process, N+1's session row and binding untouched.
- **(c) already-exited is prompt** — terminal session row + adapter reporting absence; assert the
  outcome names the already-exited family, exactly ONE `probeLiveness`/`hasSession` call (no retry
  loop; inject a counting adapter), and no event/binding writes.
- **(d) refusal leaves no partial state** — guard mode `hold`; call stop; assert `typing_guard_enabled`
  409, session row status/binding/events byte-identical to before (the `failed()`-style snapshot
  assertion used in the handover suite), `killSession` not called.
- **(e) no weakening / no alternate path** — two-layer test: (i) behavioural — a `hold`-mode seat
  still refuses when stop is invoked through every public entry (CLI verb, route, checked path);
  (ii) source-level (the pattern REV-P16 used for "nothing resolves a row by key"), SCOPED per R4.2:
  the stop call chain contains no `override:` at any `operation(` call site, and within the
  stop-purpose chain `stopSeat`/`stopSeatChecked` → `stopManagedTmuxSeat` → `killSession` there is
  no other `killSession` caller (grep-pinned). The pin asserts the CHAIN, not "all stop-purpose
  callers" — out-of-chain `killSession` callers (rig stop, teardown, restore, rigspec) are named in
  R4.2 and excluded by scope, not by claim.
- **(f) idempotence** — stop a live seat twice; first `ok:true`, second already-exited-family;
  assert exactly one `session.stopped` event, one binding clear, ≤1 extra probe, and identical
  response shape for a third call.
- **(g) retry visibility** — a scripted caller files a stop-failed row on refusal; assert the runtime
  supplied the refusal code + generation in the response payload, and (repo-side assertion, their
  suite) the row names its owner and is closed when the follow-up stop reaches a terminal outcome.
  Runtime-side half: refusal payload carries `occupantGeneration` (from `currentOccupantTenure`).
- **(h) a generation the daemon does not know is REFUSED, never "no generation, proceed"** — the
  both-directions form of the older-daemon rule, with codes per R1.1: (i) daemon-side, a checked
  stop whose `expected.occupantGeneration` is present but does not match the live tenure returns
  `selection_changed`; a MALFORMED generation returns `invalid_stop_precondition` (which requires
  the whitelist extension of §5.3c(a)) — an unenforceable precondition may never degrade into an
  unscoped proceed; (ii) caller-side, the two older-daemon behaviours differ (§5.3c): upstream
  6957751 REFUSES the extra key (`invalid_stop_precondition`), while the installed 0.6.13 has no
  checked-stop code and IGNORES the field — so the consumer refuses unless the answer ECHOES the
  generation it enforcement-bound (the §5.3c capability echo): a success that does not report the
  generation is treated as "generation NOT enforced", and the caller stops and surfaces that;
  on the installed runtime the caller additionally owes the session-identity check (§5.3b worked
  example), because the daemon checks neither generation nor session id.
  rather than reading the stop as generation-safe. Test shape: (i) extends the (b) scene with a stop expecting a fabricated
  generation → named refusal, kill not called; (ii) extends the CLI preflight test pattern (the
  queue `--expect-transition` echo test) — a daemon answer without the generation field refuses
  with `expect_generation_unsupported`, nothing sent/typed.

## 5. What remains upstream's decision

1. **Already-exited outcome shape** — ok-shaped outcome vs today's `session_not_live` refusal, and
   the rename/split from `no_session` (R3.3). A fork patch can add a code but cannot reshape the
   public API contract without upstream buying it.
2. **A drain-status surface on the guard** — in-flight leases (R2.1(c)/(d)) are in-memory inside
   `DeliveryGuard`. A fork patch cannot observe them. Upstream must expose either a
   `drainStatus(nodeId)` on the guard or a lifecycle drain callback. Without it, a fork patch can
   only implement the DB surfaces (R2.1(a)/(b)) and must refuse-with-`tmux_probe_failed`-style honesty
   for (c)/(d) — a WEAKER contract that must be labelled as such.
3. **`expected.occupantGeneration` adoption** — see §5.3c for the per-daemon truth; the shorthand
   "older daemon" splits into two DIFFERENT behaviours, and the fork CLI must capability-echo before
   relying on the field on either (preflight: the seat payload reports the generation; refuse when
   absent). The refusal direction is normative (see acceptance case (h)): absent or unenforceable
   generation ⇒ REFUSE, never proceed unscoped.
3c. **Per-daemon behaviour of an `expected.occupantGeneration` field, stated separately (R6c).**
   - **(a) Upstream main `6957751` — CONSERVATIVE failure.** `validStopPrecondition`
     (`seat-lifecycle-service.ts:236-242`) accepts exactly the sorted key set `nodeId,sessionId` and
     returns false for ANY extra key; `stopSeat` returns `invalid_stop_precondition` at `:1001`
     (before it dispatches to the checked variant at `:1043`), mapped to HTTP 400 by
     `routes/seat.ts:364`. An extra key is therefore REFUSED loudly, not dropped — so adopting the generation
     requires a deliberate extension of the checked stop (whitelist + `selection()` term), NOT an
     extra field the daemon would tolerate.
   - **(b) Installed runtime 0.6.13 (kpc candidate `e46327f`, release
     `.../runtime/package/daemon/dist`) — PERMISSIVE failure: no checked-stop code at all.** Verified
     2026-10-28 against the installed sources, not a live seat: `domain/seat-lifecycle-service.js`
     contains no `validStopPrecondition` / `invalid_stop_precondition` (grep count 0;
     `invalid_stop_precondition` is absent from every installed .js), the daemon seat route
     (`routes/seat.js`) has no `expected` handling, and the CLI stop verb posts only
     `{reason, operator}` (`dist/commands/seat.js:773-791`) — the shipped client cannot even send
     the field. A hand-rolled POST carrying `expected.occupantGeneration` is IGNORED and the
     stop proceeds unscoped against whatever is live — verified at the HTTP layer too: the installed
     stop route (`daemon/dist/routes/seat.js:396-402`) builds its input from NAMED fields only
     (`seatRef`, `reason`, `operator`), so an unknown `expected` key is never copied and never
     rejected (RESOLVED — was UNVERIFIED in R6c; source read, not a live probe). The contract must
     not rely on any 0.6.13-side behaviour: on 0.6.13 the stop's protection is the caller's own
     two checks — the resolved-session-identity check and the generation check, with the residual
     post-check/pre-stop race stated (§5.3b). The caller-side echo-or-refuse rule (h)(ii) is only
     a capability probe: it is how a caller that SENDS a generation learns that the daemon ignored
     the field; no 0.6.13 stop can ever echo one, so it guards nothing by itself.
     **Migration hazard (R6d final, R6f sweep):** upstream's 400-on-extra-keys and the installed
     runtime's ignore are DIFFERENT contracts. A caller written against upstream's strictness — one
     that treats a sent `expected` as either honoured or refused — is silently mis-served by the
     installed runtime, which answers success while ignoring the scope entirely. The hazard is the
     silent drop, and it is why the capability echo (h)(ii) may never be skipped. The deeper hazard
     stands on BOTH runtimes: neither ever refuses a stale GENERATION.
     **Provenance for the installed-runtime half:** candidate `e46327f`,
     `runtime/package/daemon/dist/domain/seat-lifecycle-service.js:593-625` — installed `stopSeat`
     takes no `expected`, performs no session-identity comparison, resolves the seat, and on its
     successful path stops `latestSession(nodeId)`; its operational refusal/error paths include
     `no_session` / `claimed_session` / `session_not_live` among others (illustrative list in the
     contract text below, not exhaustive).
     **Contract text (kevinsykes-ai canonical v3, sha256
     `e5c037f7521dc58aa4883bdfefeec44815576d2b57aad7f321aba22453c35128`, VERBATIM — locked source,
     hash verified at copy time; supersedes the v2 text (`60664e3d…`), whose exhaustive installed-refusal
     claim was unsupported, and which promised a complete worked example for `c660c21` that
     the implementation does not yet earn):**

     > THE STOP CONTRACT IS RUNTIME-SPECIFIC. THE CALLER MUST STATE WHAT IT CHECKS AND WHAT RACE
     > REMAINS.
     >
     > **INSTALLED RUNTIME (0.6.13 `stopSeat`):** `stopSeat` accepts no `expected` field and
     > performs no session-identity comparison. On its successful path it resolves the seat and
     > stops `latestSession(nodeId)`; it also has operational refusal/error paths, including
     > `no_session`, `claimed_session`, `session_not_live`, `tmux_probe_failed`, missing reason /
     > seat not found, `typing_guard_enabled`, and kill failures (this list is illustrative, not
     > exhaustive). At the HTTP layer it copies only named fields, so an extra `expected` is
     > silently ignored rather than refused. A stale call can therefore stop the latest session,
     > including a newer occupant after handover. A caller using this daemon must check both (a)
     > the resolved session identity it intends to stop and (b) the occupant generation: capture
     > the values at settle, re-read them immediately before requesting the stop, and refuse if
     > either changed. **Those separate reads are not an atomic fence:** a handover can still occur
     > after the last read and before `stopSeat` selects `latestSession(nodeId)`. Unless the caller
     > holds a serialization/fencing mechanism that every handover path honors, it must state that
     > residual race and must not claim a complete stale-stop guarantee. No caller may treat the
     > ignored `expected` field as a guard.
     >
     > **CHECKED-STOP DAEMONS (the fork and upstream `6957751 stopSeatChecked`):** the runtime
     > compares the expected session identity with the seat's latest session and refuses a stale
     > session identity; this catches a handover when the session identity changes. It does not
     > establish a generation check: an in-place restart that retains the session identity remains
     > the caller's generation-check responsibility. Upstream rejects extra keys with
     > `400 invalid_stop_precondition`; callers must follow that daemon's checked-stop contract
     > rather than assuming unsupported fields are ignored.
     >
     > **SUMMARY:** on installed 0.6.13, the caller carries session-identity and generation checks,
     > and a post-check/pre-stop race remains unless serialization or fencing closes it. On
     > checked-stop daemons, a stale session identity is refused by the runtime, while generation
     > changes within the same session remain the caller's responsibility. Neither runtime may be
     > described by the unscoped phrase "the runtime refuses a stale occupant," and neither
     > contract should claim more than the source and caller-side fence prove.
   - **(c) Point 5 (consumer refuses when generation absent/unknown) holds on BOTH daemons**, and
     the patch must assume neither daemon's behaviour for the other: echo-or-refuse on the caller,
     whitelist-extension + B1-B5 term on the daemon.
3a. **The shared generation signal, named.** Both sides use ONE identity: the occupant tenure's
   `generation_uuid`, surfaced read-only as `modelObservation.generation` —
   `packages/daemon/src/domain/model-divergence/current-model-reader.ts:103` sets
   `generation = tenure?.generationUuid ?? null` (the Pi-specific record path inside
   `currentPiRecord`; the general surface that sets `modelObservation.generation` for ALL runtimes is
   `:204-210`, with an occupant-unchanged re-check at `:106`/`:122`), served on the node inventory
   (`routes/sessions.ts:176-178`, `ps.ts`/`roster.ts` projections, shape in
   `packages/cli/src/lib/model-observation.ts:7`, the `generation` field). The retire fix (`c660c21`)
   captures it at settle (`occupant_generation(node)` reads `modelObservation.generation`) and
   re-reads it before stop. The runtime-side contract (R1) must key on the SAME value — no second
   generation concept may be minted. Until §5.5's read surface exists, `modelObservation.generation`
   in the full node record IS the read surface.
3b. **The bounded guarantee of a non-generation-scoped stop path, stated plainly.** On checked-stop
   daemons (this fork; upstream `6957751 stopSeatChecked`) the stop checks `expected
   {nodeId, sessionId}` only; the installed 0.6.13 daemon accepts no `expected` at all and performs
   no session-identity comparison (its operational refusal/error paths are the illustrative,
   non-exhaustive list in §5.3c(b)). A repo-side fix
   can therefore pin, at best, the generation at its last read: **"generation-pinned at last read,
   session identity unresolved"** — unless the caller also performs and states the
   resolved-session-identity check, and in every case the residual post-check/pre-stop race
   stands unless a serialization/fencing mechanism that every handover path honors is shown
   (§5.3b worked example). It CANNOT claim **"cannot affect a newer occupant"**: on the installed
   0.6.13 runtime the stop carries only a `seatRef`, so no launch or session identity is even sent
   to the daemon, and the TOCTOU window between the script's last read and the daemon's kill is
   closed only INSIDE the daemon (boundaries B1-B5 on checked-stop daemons, which today compare
   nodeId+sessionId, not generation — and a same-generation continuation would pass even a
   generation check there, per §1.3a). Upstream adopting `expected.occupantGeneration` at B1-B5 is
   precisely what converts the repo's read-then-pray pin into an enforced property. Until then,
   "names the launch" holds only on checked-stop daemons, where `expected.sessionId` is actually
   sent; on 0.6.13 the honest claim is generation-pinned-at-last-read with the residual race
   stated, and tests must not assert more.
   **Contract text (kevinsykes-ai canonical v3, sha256
   `e5c037f7521dc58aa4883bdfefeec44815576d2b57aad7f321aba22453c35128`, VERBATIM — the same locked
   text §5.3c(b) carries; quoted here in full so this section stands alone):**

   > THE STOP CONTRACT IS RUNTIME-SPECIFIC. THE CALLER MUST STATE WHAT IT CHECKS AND WHAT RACE
   > REMAINS.
   >
   > **INSTALLED RUNTIME (0.6.13 `stopSeat`):** `stopSeat` accepts no `expected` field and
   > performs no session-identity comparison. On its successful path it resolves the seat and
   > stops `latestSession(nodeId)`; it also has operational refusal/error paths, including
   > `no_session`, `claimed_session`, `session_not_live`, `tmux_probe_failed`, missing reason /
   > seat not found, `typing_guard_enabled`, and kill failures (this list is illustrative, not
   > exhaustive). At the HTTP layer it copies only named fields, so an extra `expected` is
   > silently ignored rather than refused. A stale call can therefore stop the latest session,
   > including a newer occupant after handover. A caller using this daemon must check both (a)
   > the resolved session identity it intends to stop and (b) the occupant generation: capture
   > the values at settle, re-read them immediately before requesting the stop, and refuse if
   > either changed. **Those separate reads are not an atomic fence:** a handover can still occur
   > after the last read and before `stopSeat` selects `latestSession(nodeId)`. Unless the caller
   > holds a serialization/fencing mechanism that every handover path honors, it must state that
   > residual race and must not claim a complete stale-stop guarantee. No caller may treat the
   > ignored `expected` field as a guard.
   >
   > **CHECKED-STOP DAEMONS (the fork and upstream `6957751 stopSeatChecked`):** the runtime
   > compares the expected session identity with the seat's latest session and refuses a stale
   > session identity; this catches a handover when the session identity changes. It does not
   > establish a generation check: an in-place restart that retains the session identity remains
   > the caller's generation-check responsibility. Upstream rejects extra keys with
   > `400 invalid_stop_precondition`; callers must follow that daemon's checked-stop contract
   > rather than assuming unsupported fields are ignored.
   >
   > **SUMMARY:** on installed 0.6.13, the caller carries session-identity and generation checks,
   > and a post-check/pre-stop race remains unless serialization or fencing closes it. On
   > checked-stop daemons, a stale session identity is refused by the runtime, while generation
   > changes within the same session remain the caller's responsibility. Neither runtime may be
   > described by the unscoped phrase "the runtime refuses a stale occupant," and neither
   > contract should claim more than the source and caller-side fence prove.

   **Worked example IN PROGRESS, not complete — the repo-side retire path (kevinsykes-ai candidate
   `c660c21e…`, "fix(openrig): packet-seat retire under a stop contract"), described accurately per
   the kevinsykes-ai ruling of 17:55Z.** It currently FAILS the session-identity requirement: it
   captures and rechecks `modelObservation.generation` only — it does not capture or compare the
   resolved session identity it is about to stop — while installed 0.6.13 `stopSeat` selects
   `latestSession(nodeId)`. A handover between the caller's last node read and the stop can
   therefore target the new occupant. Two separate caller reads are not an atomic fence: the
   residual post-check/pre-stop race stands UNLESS a serialization/fencing mechanism that every
   handover path honors is derived and shown. Until then this path must state the residual race and
   its bounded guarantee (generation-pinned at last read, session identity unresolved), must not be
   published or reviewed as a complete stale-stop example, and must not claim the runtime refuses a
   stale session id — false on 0.6.13. The fencing seam is the owner's to bring for review; no edit
   or push is authorized by the canonical text.
4. **Whether settle may ever wait** (drain-and-wait mode with a bound) vs refuse-and-retry (this
   spec's R2.4). Refuse-and-retry is implementable fork-side; drain-and-wait changes stop's
   latency contract and is upstream's to accept.
5. **The generation read-surface** — exposing the live generation in `rig ps`/`rig seat show`
   payloads so external callers (packet_seat.py) can key stops without DB access.

## 6. What a fork patch alone can and cannot meet

CAN (all inside fork-owned files + tests): R1 (checked-stop generation comparison + precondition
extension, capability-echoed), R2 over surfaces (a)/(b) + the refusal `generation_not_settled` +
drain snapshot in the event, R3's promptness/no-retry assertions, R4's source-level pins, R5.1,
R6 — with the seven tests of §4. The generation comparison is a ONE-PREDICATE change: the pair
(generation AND sessionId, per §1.3a) added inside `selection()` puts it on all five boundaries
B1-B5 at once. **Bounded guarantee of anything the fork ships without upstream:** the fork's
checked stop can enforce generation-scoping on ITS runtime (the daemon it ships), but callers
keying stops against the INSTALLED 0.6.13 daemon get neither a session-identity nor a generation
refusal, only the §5.3b read-then-pray guarantee with its residual post-check/pre-stop race —
while callers against an UNPATCHED CHECKED-STOP daemon keep the runtime's session-id refusal but
still owe the generation check (§5.3b, §5.3c(b)) — and the capability echo of §5.3c is what tells
them which world they are in.
CANNOT alone: observing in-flight leases (R2.1(c)/(d) — needs §5.2); reshaping already-exited (§5.1);
guaranteeing no future upstream bypass (R4 is enforceable fork-side only as a regression pin);
`expected` adoption by older daemons (§5.3c). Each needs exactly the upstream change named in §5 —
no requirement needs more than one.

## 7. Seams the repo-side fix (packet_seat.py retire, row c8d67be6) must call

1. Order: flip the typing guard AFTER a terminal stop outcome, not before — the current defect.
   The runtime refusal it will then stop hitting: `typing_guard_enabled` 409
   (`seat-delivery-guard.ts:269` via `lifecycle()`).
2. Exited seat: treat `session_not_live` / `no_session` as terminal, proceed immediately to its
   exited branch — never wait on a stopped seat (the hang is in the script, not the runtime;
   runtime already returns in one probe, `seat-lifecycle-service.ts:1030-1037`).
3. Scoped per daemon. CHECKED-STOP daemons (this fork; upstream `6957751 stopSeatChecked`): key
   stops with `expected {nodeId, sessionId}` and add `occupantGeneration` only behind the §5.3c
   capability echo — there the daemon-side pair comparison enforces the launch keying. INSTALLED
   0.6.13: `expected` cannot be sent (the CLI posts `{reason, operator}`) and would be ignored
   anyway, and there is NO daemon-side pair comparison — the caller does BOTH checks itself:
   the generation check AND the resolved-session-identity check (verify the session it is about
   to stop is the session it resolved), per §5.3b/§5.3c(b), stating the residual race. The
   identity both sides use is `modelObservation.generation` = the occupant tenure
   `generation_uuid` (§5.3a) — the retire fix's captured generation IS this value; the runtime
   contract must consume the same field, never a second one. Remember §1.3a: generation alone is
   insufficient across a continuation — the stop must be keyed to the launch too (sessionId).
4. On refusal, file at most ONE stop-failed row per cause carrying code + generation + owner, and
   close it on the next terminal outcome (R5.2) — no per-tick repeat.
5. Never route around the guard (no direct `tmux kill-session`, no guard auto-off without the
   explicit preference call) — R4 binds the script side too.

## 8. Overlap with seat-grant design B

Both this contract and the seat-grant design key on `occupant_tenures.generation_uuid`
(session-registry `:402-433`). Specify them together: ONE generation resolver
(`currentOccupantTenure`) and ONE invalidation rule (a new tenure invalidates pending stops AND
outstanding grants for the previous generation). If design B lands first, stop's
`expected.occupantGeneration` should reuse B's grant-generation plumbing (same field, same echo
discipline) rather than minting a parallel concept.

## 9. Scope notes

The packet's installed-bytes findings (guard-files.py / scope-grant absent, watch unit on a dirty
tree) are host-state facts outside this runtime contract; they change nothing above. No code was
written, no config touched, no upstream PR opened (searches were read-only `gh search` queries).

## 10. Review evidence limits

On these runtimes, reviewer-FAMILY distinctness (the two-independent-non-author-reviews rule) is
asserted from CONFIGURED families plus distinct seats — the roster's rail/model assignment — and
CANNOT be attested from served identity: a seat's reported model, pane text, or
`modelObservation` reflects what the runtime observed or was configured with, not proof of which
model family actually served a given review turn. A review's family claim is therefore a
configuration-level assertion, testable only against config (the fleet.yaml rails), never against
served bytes. For MERGED code, the bar that a review actually happened by a distinct second party
is the signed merge-review fence — the signer's attestation on the merge commit — not any
runtime-observable property of the reviewer seat. Consumers of this contract's reviews (the R6b
MiniMax review, the fork patch packets) should treat family distinctness as configured-fact +
signed-attestation, in that order, and never as served-identity-derived.
