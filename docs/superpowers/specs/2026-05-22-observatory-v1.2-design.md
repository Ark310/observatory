# Observatory v1.2 — Design Spec

**Date:** 2026-05-22
**Status:** Approved
**Version:** 1.2.0

---

## Problem

Three gaps in the current implementation:

1. **Sub-agents are invisible.** When a ghost session (external terminal, no `OBSERVATORY_TERMINAL_ID`) spawns a sub-agent via the `Agent` tool, the sub-agent either registers as a ghost and is immediately destroyed on `Stop` (flashes in and out), or never registers at all if its hooks don't fire.

2. **Ghost agents vanish too quickly.** `Stop` on a ghost terminal calls `cleanupGhostTerminal` immediately — the character disappears the instant the session ends, with no visual cooldown.

3. **No pickup of sessions already running when Observatory starts.** If a Claude/Cursor session was active before Observatory launched, its character only appears the next time a hook fires (which may be minutes later, or never if the session is idle between prompts).

---

## Goals

- Sub-agents from external terminal sessions appear as their own ghost characters and stay visible throughout their execution.
- Ghost agents linger for 60 seconds after their session ends: 0–20 s sitting on the sofa, 20–60 s wandering the lounge, then removal.
- On startup, already-running sessions appear immediately (best-effort via process scan).
- All changes are backwards-compatible: real Observatory terminal sessions are unaffected.
- Version bumped to `1.2.0` in `package.json`.

---

## Architecture

### Feature 1: Ghost Loitering (server)

**Current behavior:** `Stop` hook on a ghost → `cleanupGhostTerminal(id)` → session removed, character disappears.

**New behavior:** `Stop` hook on a ghost →
```
session.state          = "waiting"
session.ghost          = true          // signals client to run loiter animation
session.loiteringUntil = Date.now() + 60_000
```
`cleanupGhostTerminal` is NOT called from the `Stop` handler.

`pruneStale` (runs every 30 s) handles actual removal:
```
if ghost terminal && session.loiteringUntil && now >= session.loiteringUntil
  → cleanupGhostTerminal(id)
```

If `loiteringUntil` is unset (old 15-minute stale rule), the existing logic still applies — long-running ghost sessions that never receive `Stop` still prune after 15 minutes.

### Feature 2: Sub-agent Detection (server)

Two complementary paths, ranked by reliability:

**Path A — Sub-agent fires its own hooks (primary)**

Sub-agents spawned from ghost sessions have no `OBSERVATORY_TERMINAL_ID` in their environment and a fresh `session_id`. The existing `autoRegisterGhostSession` path in `processNormalizedHook` already handles `UserPromptSubmit` from unknown sessions. With the loitering fix in place these ghosts now stay visible for 60 s after `Stop`.

No new code needed for Path A — it already works once Feature 1 is in place.

**Path B — Agent PreToolUse proxy (fallback)**

When the parent fires `PreToolUse` with `toolName === "agent"` on a known terminal, a *proxy ghost* is created for the sub-agent:

```
proxyId = "agentghost-<parentId[:8]>-<Date.now()>"
terminals.set(proxyId, { ghost: true, ... })
cliSessionToTerminal.set("proxy:" + proxyId, proxyId)   // sentinel — not a real sessionId
upsertSession(proxyId, cwd, "thinking", source, generateGhostName())
```

When the parent fires `PostToolUse` for `"agent"` on the same terminal, the proxy enters loitering (same `loiteringUntil` logic as Feature 1).

**Deduplication (A + B coexist):** If a `UserPromptSubmit` arrives for an unknown `sessionId` and a proxy ghost exists with a matching `cwd`, adopt it:
```
cliSessionToTerminal.set(realSessionId, proxyId)
// remove sentinel key
cliSessionToTerminal.delete("proxy:" + proxyId)
```
This prevents two characters from appearing for the same sub-agent.

The parent terminal stores the active proxy ghost ID in `Terminal.activeSubagentGhostId?: string` to match PreToolUse/PostToolUse pairs. Nested sub-agents are out of scope for v1.2.

### Feature 3: Startup Session Pickup (server)

New file: `server/startup-scan.ts`

Called once from `server/index.ts` after the server starts listening.

Algorithm:
1. Run `ps aux`, find processes whose command contains `claude`, `cursor`, `copilot`, or `gemini` — excluding `observatory`, `hook`, and `grep` noise.
2. For each matching PID, read `/proc/<pid>/cwd` (Linux) via `readlink`.
3. Skip duplicates (same cwd already has a ghost or real terminal).
4. Register a `startup-<pid>` ghost session: state `"waiting"`, name from `generateGhostName()`.

**Adoption:** In `autoRegisterGhostSession`, before creating a new ghost, check for a `startup-*` ghost with matching `cwd`. If found, adopt it (`cliSessionToTerminal.set(sessionId, startupGhostId)`, update state to `"thinking"`). This prevents duplicate characters.

Startup ghosts that never receive hooks prune after 15 minutes under the existing stale rule.

Limitations: startup scan is Linux-only (`/proc`); macOS falls back silently with no startup ghosts. Only the first running process per `cwd` is registered (acceptable for v1.2).

### Feature 4: Ghost Loitering Animation (client)

**Session data change:** Server now broadcasts `ghost: boolean` on Session objects. Client reads this into the character:
```js
if (session.ghost) ch.ghost = true;
```

**New constant:**
```js
const SOFA_SIT_SPOTS = [
  { col: 14, row: 12, dir: DIR.DOWN },
  { col: 15, row: 12, dir: DIR.DOWN },
];
```

These are the two walkable tiles in front of `SOFA_FRONT` (col 14–15, row 13).

**State machine change in `updateCharacter` IDLE branch:**

```
if ch.ghost && !ch.isActive:
  elapsed = (Date.now() - ch.stateChangedAt) / 1000

  if elapsed < 20:
    // Phase 1: walk to sofa and sit
    if not already at a SOFA_SIT_SPOT:
      pick one SOFA_SIT_SPOT (by palette index)
      walkTo(ch, spot.col, spot.row, spot.dir)
    else:
      ch.dir = spot.dir   // stay facing forward
      ch.state = STATE.IDLE
  else:
    // Phase 2: normal lounge wander (existing buildLoungeTiles logic)
    [existing wander code, unchanged]
```

**`applySessionState` change:** When ghost becomes inactive (`wasActive && !ch.isActive && ch.ghost`), immediately trigger the walk-to-sofa path by setting `ch.wanderTimer = 0` — same as the existing inactive transition, but the IDLE update loop will use the sofa logic.

Ghost characters retain their desk seat assignment during the active phase; the sofa behavior only applies during loitering.

---

## Data Model Changes

### `server/types.ts`

```ts
interface Session {
  // existing fields ...
  ghost?: boolean;          // true for ghost and proxy sessions (set at creation, never cleared)
  loiteringUntil?: number;  // ms timestamp after which the ghost is pruned
}

interface Terminal {
  // existing fields ...
  activeSubagentGhostId?: string;  // proxy ghost ID created by Agent PreToolUse
}
```

### `server/sessions.ts` — `upsertSession`

`upsertSession` currently rebuilds the session object from scratch, which would clobber `ghost` and `loiteringUntil`. It must be updated to preserve both fields from the existing session:

```ts
sessions.set(id, {
  // ... existing fields ...
  ghost: existing?.ghost,              // preserve — never cleared once set
  loiteringUntil: existing?.loiteringUntil,  // preserve — pruneStale clears via deletion
});
```

`ghost` is set to `true` in `autoRegisterGhostSession` and `upsertSession` for proxy ghosts at creation time — not deferred to the `Stop` handler. This way the client always knows a session is a ghost from first broadcast.

The Stop handler sets `loiteringUntil` by directly mutating the session object (not via `upsertSession`) to avoid a second `broadcastSessions` call and to set `loiteringUntil` atomically with the state change:

```ts
// Stop handler for ghost terminal
const session = sessions.get(terminalId)!;
session.state          = "waiting";
session.loiteringUntil = Date.now() + 60_000;
session.stateChangedAt = Date.now();
session.lastSeen       = Date.now();
broadcastSessions();
```

---

## What Does NOT Change

- `observatory-hook.js` — no changes
- `MAX_AGENTS = 4` client cap — ghost sessions obey the same limit
- Real Observatory terminal sessions (non-ghost) — Stop still transitions to `"waiting"` without loitering
- 15-minute stale prune for ghost sessions without `loiteringUntil` — unchanged
- Character animations during the active phase — unchanged

---

## Testing

### `server/hooks.test.ts` additions
- Stop on ghost → session state = "waiting", `loiteringUntil` set, terminal still in `terminals`
- PreToolUse `agent` on known terminal → proxy ghost created in `terminals` and `sessions`
- PostToolUse `agent` → proxy ghost enters loitering (not deleted)
- UserPromptSubmit (unknown session) with matching cwd proxy → proxy adopted, no duplicate ghost

### `server/sessions.test.ts` additions
- `pruneStale`: ghost with `loiteringUntil` in the past → removed
- `pruneStale`: ghost with `loiteringUntil` in the future → kept
- `pruneStale`: ghost with no `loiteringUntil` and `lastSeen` > 15 min → removed (existing rule still works)

---

## Out of Scope (v1.2)

- Nested sub-agents (sub-agent spawning its own sub-agent)
- macOS startup scan (no `/proc`)
- Deduplication of startup ghosts when multiple sessions share the same CWD
- Per-ghost name persistence across server restarts
- Embedded terminal pane for ghost/proxy sessions
