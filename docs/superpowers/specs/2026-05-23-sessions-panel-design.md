# Sessions Panel — Design Spec

**Date:** 2026-05-23
**Status:** Approved

---

## Problems

1. **Ghost loitering overshoots 60 s.** `pruneStale` runs every 30 s, so a ghost can linger up to 90 s after `Stop` fires.

2. **No session management UI.** There is no way to view or kill sessions without restarting the server.

---

## Goals

- Ghost sessions are removed within ~100 ms of their 60-second loitering window expiring.
- A "Sessions" button opens a modal popup listing all active sessions grouped by project (CWD).
- Each session row shows: name, ghost pill, state badge, duration.
- Each session has a ✕ kill button; each project group has a "Kill all" button.
- The modal closes when clicking outside it or the ✕ close button.
- The modal auto-refreshes from the existing WebSocket session feed.

---

## Architecture

### Fix: Loitering precision (`server/hooks.ts`)

In the `Stop` handler, after setting `session.loiteringUntil = now + 60_000`, schedule a `setTimeout` for 60 100 ms that checks whether `loiteringUntil` still matches (guards against a kill racing in), then calls `cleanupGhostTerminal(terminalId)` + `broadcastSessions()`. This ensures removal happens at most ~100 ms after the window expires regardless of when `pruneStale` next runs.

### Server: DELETE endpoint (`server/index.ts`)

New route: `DELETE /api/sessions/:id`

- Ghost terminal → `cleanupGhostTerminal(id)` + `broadcastSessions()`
- Non-ghost session → `sessions.delete(id)` + `broadcastSessions()` (leaves the terminal running)
- Returns `{}` with 200

### Client: Sessions button (`public/index.html` + `public/styles.css`)

`#sessions-btn` — fixed-position icon button at `top: 54px; right: 12px` (8 px below the existing `#search-btn`). Identical styling to `#search-btn`.

### Client: Sessions modal (`public/index.html` + `public/styles.css`)

`#sessions-backdrop` — full-screen semi-transparent overlay (`z-index: 50`), clicking it closes the modal.

`#sessions-modal` — centered popup (`z-index: 51`), `480px` wide, max `calc(100vh - 64px)` tall, scrollable body. Header has title "Sessions" and a ✕ close button. Body renders session groups.

### Client: Modal logic (`public/game.js`)

`renderSessionsModal()` — called on open and on every WebSocket `sessions` message while modal is open. Groups `allSessions` by `cwd`, sorts each group (non-ghost first, then by `startedAt`). Renders groups with kill buttons wired inline. `formatDur(ms)` formats duration as `Xs` / `Xm` / `XhYm`.

`killSession(id)` — `fetch('/api/sessions/:id', { method: 'DELETE' })`.

---

## Data Flow

```
WebSocket 'sessions' message
  → allSessions updated
  → syncSessions() (canvas)
  → renderSessionsModal() if modal open

Sessions modal kill button click
  → DELETE /api/sessions/:id
  → server removes session + broadcasts
  → WebSocket 'sessions' message arrives
  → renderSessionsModal() re-renders (row disappears)
```

---

## Files

| File | Change |
|---|---|
| `server/hooks.ts` | Add `setTimeout` loitering cleanup in Stop handler |
| `server/index.ts` | Add `DELETE /api/sessions/:id` route; import `cleanupGhostTerminal` |
| `public/index.html` | Add `#sessions-btn`, `#sessions-backdrop`, `#sessions-modal` markup |
| `public/styles.css` | Add styles for button, backdrop, modal, groups, rows, badges |
| `public/game.js` | Add modal open/close/render logic; call `renderSessionsModal()` on WS update |

---

## What Does NOT Change

- Canvas characters, seat assignments, existing WebSocket protocol
- `pruneStale` 30-second interval (still runs as belt-and-suspenders)
- Terminal panel, command palette, FAB button
