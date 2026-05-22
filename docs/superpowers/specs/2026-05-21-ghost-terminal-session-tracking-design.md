# Ghost Terminal Auto-Registration — Design Spec

**Date:** 2026-05-21  
**Status:** Approved

---

## Problem

Observatory currently only shows characters for sessions started via its own built-in terminal UI. When a user runs `claude` (or another CLI) in an external terminal emulator (Kitty, Alacritty, etc.), the hook fires but is silently dropped in `server/hooks.ts:239`:

```ts
if (!terminalId || !terminals.has(terminalId)) return;
```

No `OBSERVATORY_TERMINAL_ID` env var is set in external terminals, so `observatoryTerminalId` is empty and there is no `cliSessionToTerminal` mapping yet — the event is discarded and no character appears.

---

## Goal

When an external terminal session fires a `UserPromptSubmit` hook, a character with a randomly generated fun name appears in the Observatory UI and animates through all the normal states (thinking, reading, editing, etc.). When the session ends (Stop hook) or goes stagnant (15-min timeout), the character is removed.

---

## Approach: Ghost Terminal Auto-Registration

Auto-create a lightweight "ghost" terminal entry (`proc: null`, `ghost: true`) in the `terminals` map the moment a `UserPromptSubmit` arrives from an unknown session. This reuses the existing external terminal pattern (`/api/terminal/register` already creates `proc: null` entries). All subsequent hooks for the same `session_id` flow through the existing state machine unchanged.

---

## Data Flow

```
External terminal: user runs `claude` and types a prompt
  → Claude Code fires UserPromptSubmit hook
  → observatory-hook.js reads stdin, no OBSERVATORY_TERMINAL_ID → sends POST /hook/claude

server/hooks.ts: processNormalizedHook
  → hookEvent === "UserPromptSubmit", no terminalId resolved
  → NEW: auto-register path
      ghostId = "ghost-<sessionId[:8]>-<Date.now()>"
      name    = generateGhostName()   // e.g. "Hopper"
      terminals.set(ghostId, { id: ghostId, cwd, proc: null, ghost: true, subscribers: new Set(), outputBuffer: [] })
      cliSessionToTerminal.set(sessionId, ghostId)
      upsertSession(ghostId, cwd, "thinking", source, name)
      → broadcastSessions()
      → character "Hopper" appears in UI

Subsequent PreToolUse / PostToolUse hooks
  → cliSessionToTerminal.get(sessionId) → ghostId ✓
  → state updates flow normally

Stop hook fires
  → hookEvent === "Stop", term.ghost === true
  → cleanupGhostTerminal(ghostId): delete from terminals, sessions, sessionLogs, cliSessionToTerminal, broadcast
  → character disappears immediately

OR — no Stop hook (crash / SIGKILL / shell exit)
  → pruneStale (runs every 30s)
  → ghost terminal with session.lastSeen > 15min → same cleanup path
  → character disappears
```

---

## Components

### `server/types.ts`
- Add `name?: string` to `Session`
- Add `ghost?: boolean` to `Terminal`

### `server/state.ts`
- Add `GHOST_NAMES` array (20 names): `Ada, Turing, Hopper, Ritchie, Lovelace, Shannon, Dijkstra, McCarthy, Gosling, Guido, Wozniak, Boole, Tesla, Euler, Gauss, Feynman, Babbage, Curie, Stroustrup, Torvalds`
- Add `generateGhostName()`: picks randomly from the list

### `server/sessions.ts`
- `upsertSession` gains optional `name` param; preserves existing name across state updates
- `pruneStale`: in the `if (terminals.has(id))` branch, add: if `term.ghost && session.lastSeen < cutoff`, call `cleanupGhostTerminal(id)` and mark `changed = true`

### `server/terminals.ts`
- Add exported `cleanupGhostTerminal(id)` helper: removes from `terminals`, `sessions`, `sessionLogs`, reverse-scans `cliSessionToTerminal` to delete the mapping, calls `broadcastSessions`. Lives alongside the existing private `cleanupTerminal` to avoid circular imports (`hooks.ts` → `sessions.ts` already; putting this in `terminals.ts` keeps the dep graph acyclic).

### `server/hooks.ts`
- `processNormalizedHook`: when `hookEvent === "UserPromptSubmit"` and no `terminalId` resolves, run auto-registration (create ghost terminal, generate name, map session → ghost, call upsertSession)
- When `hookEvent === "Stop"` and the resolved terminal is a ghost (`term.ghost`), call `cleanupGhostTerminal` instead of setting state to `"waiting"`

### `public/game.js`
- In `syncSessions`: after `ch = createCharacter(...)`, if `session.name` exists, set `ch.name = session.name`. This overrides the slot-based `CHAR_NAMES[slot]` fallback with the server-assigned name.

---

## What Does NOT Change

- `observatory-hook.js` — no changes needed; hooks already fire from external terminals
- The game engine, seat assignment, lounge logic, character animations
- `MAX_AGENTS = 4` cap — ghost sessions obey the same limit
- Observatory-spawned sessions (real PTY, `ghost: false`) — unaffected

---

## Out of Scope

- Showing an embedded terminal pane for ghost sessions (no PTY to attach to)
- Deduplication of ghost names across concurrent sessions (rare, acceptable)
- Per-user configuration of the stale timeout
