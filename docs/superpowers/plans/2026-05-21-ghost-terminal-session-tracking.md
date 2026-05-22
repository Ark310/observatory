# Ghost Terminal Auto-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-register external terminal sessions as ghost characters in the Observatory UI the moment they fire a `UserPromptSubmit` hook, and remove them when the session ends or goes stale.

**Architecture:** When `UserPromptSubmit` arrives from an unknown `session_id` (no `OBSERVATORY_TERMINAL_ID` env var set), `processNormalizedHook` in `hooks.ts` auto-creates a lightweight ghost terminal entry (`proc: null, ghost: true`) in the `terminals` map, generates a random name, and calls `upsertSession` — causing a character to appear in the UI. On `Stop` hook or 15-minute stale timeout, a shared `cleanupGhostTerminal` helper in `terminals.ts` removes the ghost from all maps and broadcasts the change.

**Tech Stack:** Bun (server runtime + test runner via `bun test`), TypeScript (server), vanilla JS (game UI), WebSockets for real-time push to browser.

---

## File Map

| File | Change |
|---|---|
| `server/types.ts` | Add `name?: string` to `Session`; `ghost?: boolean` to `Terminal` |
| `server/state.ts` | Add `GHOST_NAMES` array + `generateGhostName()` function |
| `server/sessions.ts` | `upsertSession` gains optional `name` param; `pruneStale` handles stale ghost terminals |
| `server/terminals.ts` | Add exported `cleanupGhostTerminal(id)` helper |
| `server/hooks.ts` | Auto-register ghost on `UserPromptSubmit`; call `cleanupGhostTerminal` on `Stop` for ghosts |
| `public/game.js` | In `syncSessions`, use `session.name` if present instead of slot-based name |
| `server/sessions.test.ts` | New: unit tests for `upsertSession` name handling + `pruneStale` ghost cleanup |
| `server/hooks.test.ts` | New: unit tests for ghost auto-registration and Stop cleanup |

---

## Task 1: Extend Types

**Files:**
- Modify: `server/types.ts`

- [ ] **Step 1: Add `name` to `Session` and `ghost` to `Terminal`**

Open `server/types.ts`. The current `Session` interface ends at `terminalId?: string`. The current `Terminal` interface has `outputBuffer: string[]`. Add one field to each:

```typescript
export interface Session {
  id: string;
  cwd: string;
  state: SessionState;
  source: AgentSource;
  lastSeen: number;
  startedAt: number;
  stateChangedAt: number;
  terminalId?: string;
  name?: string;           // ← add this
}

export interface Terminal {
  id: string;
  cwd: string;
  proc: import("bun").Subprocess;
  subscribers: Set<import("bun").ServerWebSocket<WsData>>;
  outputBuffer: string[];
  ghost?: boolean;         // ← add this
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun build server/index.ts --outdir /tmp/obs-build 2>&1 | head -20
```

Expected: no type errors (warnings about unused vars are fine).

- [ ] **Step 3: Commit**

```bash
git -C /home/abdul/observatory add server/types.ts && git -C /home/abdul/observatory commit -m "feat: add name to Session and ghost flag to Terminal types"
```

---

## Task 2: Add Ghost Name Generation

**Files:**
- Modify: `server/state.ts`
- Create: `server/sessions.test.ts` (partial — first test)

- [ ] **Step 1: Write the failing test**

Create `server/sessions.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { generateGhostName, GHOST_NAMES } from "./state";

test("generateGhostName returns a non-empty string", () => {
  const name = generateGhostName();
  expect(typeof name).toBe("string");
  expect(name.length).toBeGreaterThan(0);
});

test("generateGhostName returns a value from GHOST_NAMES", () => {
  const name = generateGhostName();
  expect(GHOST_NAMES).toContain(name);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/sessions.test.ts 2>&1
```

Expected: error — `generateGhostName` and `GHOST_NAMES` not exported from `./state`.

- [ ] **Step 3: Add GHOST_NAMES and generateGhostName to state.ts**

Open `server/state.ts`. Append at the bottom:

```typescript
export const GHOST_NAMES = [
  'Ada', 'Turing', 'Hopper', 'Ritchie', 'Lovelace', 'Shannon',
  'Dijkstra', 'McCarthy', 'Gosling', 'Guido', 'Wozniak', 'Boole',
  'Tesla', 'Euler', 'Gauss', 'Feynman', 'Babbage', 'Curie',
  'Stroustrup', 'Torvalds',
];

export function generateGhostName(): string {
  return GHOST_NAMES[Math.floor(Math.random() * GHOST_NAMES.length)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/sessions.test.ts 2>&1
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /home/abdul/observatory add server/state.ts server/sessions.test.ts && git -C /home/abdul/observatory commit -m "feat: add ghost name pool and generator to state"
```

---

## Task 3: Update upsertSession to Accept and Preserve Name

**Files:**
- Modify: `server/sessions.ts`
- Modify: `server/sessions.test.ts` (add tests)

- [ ] **Step 1: Add failing tests for name handling**

Append to `server/sessions.test.ts`:

```typescript
import { beforeEach } from "bun:test";
import { sessions, wsClients } from "./state";
import { upsertSession } from "./sessions";

beforeEach(() => {
  sessions.clear();
  wsClients.clear();   // prevents broadcast errors
});

test("upsertSession stores name on new session", () => {
  upsertSession("term-1", "/home/user/project", "thinking", "claude", "Ada");
  const session = sessions.get("term-1");
  expect(session?.name).toBe("Ada");
});

test("upsertSession preserves existing name when none provided on update", () => {
  upsertSession("term-1", "/home/user", "thinking", "claude", "Ada");
  upsertSession("term-1", "/home/user", "editing", "claude");          // no name arg
  const session = sessions.get("term-1");
  expect(session?.name).toBe("Ada");
});

test("upsertSession with no name leaves name undefined", () => {
  upsertSession("term-1", "/home/user", "thinking", "claude");
  const session = sessions.get("term-1");
  expect(session?.name).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/sessions.test.ts 2>&1
```

Expected: 3 new tests fail — `upsertSession` doesn't accept a 5th argument yet.

- [ ] **Step 3: Update upsertSession in sessions.ts**

Open `server/sessions.ts`. Replace the entire `upsertSession` function:

```typescript
export function upsertSession(
  id: string,
  cwd: string,
  state: SessionState,
  source?: AgentSource,
  name?: string
) {
  const existing = sessions.get(id);
  const now = Date.now();
  const stateChanged = existing?.state !== state;
  sessions.set(id, {
    id,
    cwd,
    state,
    source: source || existing?.source || "",
    name: name ?? existing?.name,
    lastSeen: now,
    startedAt: existing?.startedAt ?? now,
    stateChangedAt: stateChanged ? now : (existing?.stateChangedAt ?? now),
  });
  broadcastSessions();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/sessions.test.ts 2>&1
```

Expected: all 5 tests pass (2 from Task 2 + 3 new ones).

- [ ] **Step 5: Commit**

```bash
git -C /home/abdul/observatory add server/sessions.ts server/sessions.test.ts && git -C /home/abdul/observatory commit -m "feat: upsertSession accepts and preserves session name"
```

---

## Task 4: Add cleanupGhostTerminal to terminals.ts

**Files:**
- Modify: `server/terminals.ts`
- Create: `server/hooks.test.ts` (partial — setup only)

- [ ] **Step 1: Write the failing test**

Create `server/hooks.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { sessions, terminals, cliSessionToTerminal, sessionLogs, wsClients } from "./state";
import { cleanupGhostTerminal } from "./terminals";
import type { Terminal } from "./types";

function makeGhostTerminal(id: string, cwd = "/home/user"): Terminal {
  return { id, cwd, proc: null as any, ghost: true, subscribers: new Set(), outputBuffer: [] };
}

beforeEach(() => {
  sessions.clear();
  terminals.clear();
  cliSessionToTerminal.clear();
  sessionLogs.clear();
  wsClients.clear();
});

test("cleanupGhostTerminal removes ghost from terminals, sessions, sessionLogs, and cliSessionToTerminal", () => {
  const ghostId = "ghost-abc12345-1000";
  terminals.set(ghostId, makeGhostTerminal(ghostId));
  sessions.set(ghostId, { id: ghostId, cwd: "/home/user", state: "thinking", source: "claude", lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(), name: "Ada" });
  sessionLogs.set(ghostId, []);
  cliSessionToTerminal.set("cli-session-abc12345", ghostId);

  cleanupGhostTerminal(ghostId);

  expect(terminals.has(ghostId)).toBe(false);
  expect(sessions.has(ghostId)).toBe(false);
  expect(sessionLogs.has(ghostId)).toBe(false);
  expect(cliSessionToTerminal.get("cli-session-abc12345")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: error — `cleanupGhostTerminal` is not exported from `./terminals`.

- [ ] **Step 3: Add cleanupGhostTerminal to terminals.ts**

Open `server/terminals.ts`. After the `killTerminal` function at the bottom, add:

```typescript
export function cleanupGhostTerminal(id: string) {
  terminals.delete(id);
  sessions.delete(id);
  sessionLogs.delete(id);
  for (const [cid, tid] of cliSessionToTerminal) {
    if (tid === id) cliSessionToTerminal.delete(cid);
  }
  broadcastSessions();
  console.log(`[terminal] ghost ${id} removed`);
}
```

`terminals.ts` already imports `sessions`, `sessionLogs`, `cliSessionToTerminal`, and `broadcastSessions` — no new imports needed.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git -C /home/abdul/observatory add server/terminals.ts server/hooks.test.ts && git -C /home/abdul/observatory commit -m "feat: add cleanupGhostTerminal helper to terminals"
```

---

## Task 5: Update pruneStale to Evict Stale Ghost Terminals

**Files:**
- Modify: `server/sessions.ts`
- Modify: `server/sessions.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Append to `server/sessions.test.ts`:

```typescript
import { terminals, sessionLogs } from "./state";
import { pruneStale } from "./sessions";
import type { Terminal } from "./types";

test("pruneStale removes a ghost terminal whose lastSeen is older than 15 minutes", () => {
  const ghostId = "ghost-stale-123";
  const staleTime = Date.now() - 16 * 60 * 1000;  // 16 minutes ago

  terminals.set(ghostId, {
    id: ghostId, cwd: "/home/user", proc: null as any,
    ghost: true, subscribers: new Set(), outputBuffer: [],
  } as Terminal);
  sessions.set(ghostId, {
    id: ghostId, cwd: "/home/user", state: "waiting", source: "claude",
    lastSeen: staleTime, startedAt: staleTime, stateChangedAt: staleTime, name: "Turing",
  });
  sessionLogs.set(ghostId, []);

  pruneStale();

  expect(terminals.has(ghostId)).toBe(false);
  expect(sessions.has(ghostId)).toBe(false);
  expect(sessionLogs.has(ghostId)).toBe(false);
});

test("pruneStale does NOT remove a ghost terminal that was active within 15 minutes", () => {
  const ghostId = "ghost-fresh-456";
  const recentTime = Date.now() - 5 * 60 * 1000;  // 5 minutes ago

  terminals.set(ghostId, {
    id: ghostId, cwd: "/home/user", proc: null as any,
    ghost: true, subscribers: new Set(), outputBuffer: [],
  } as Terminal);
  sessions.set(ghostId, {
    id: ghostId, cwd: "/home/user", state: "thinking", source: "claude",
    lastSeen: recentTime, startedAt: recentTime, stateChangedAt: recentTime, name: "Hopper",
  });

  pruneStale();

  expect(terminals.has(ghostId)).toBe(true);
  expect(sessions.has(ghostId)).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/sessions.test.ts 2>&1
```

Expected: 2 new tests fail — ghost terminals inside the `terminals.has(id)` branch are never cleaned up by the current `pruneStale`.

- [ ] **Step 3: Update pruneStale in sessions.ts**

Open `server/sessions.ts`. Add this import at the top of the file (after the existing imports):

```typescript
import { cleanupGhostTerminal } from "./terminals";
```

Then replace the existing `pruneStale` function:

```typescript
export function pruneStale() {
  const now = Date.now();
  const cutoff = now - 15 * 60 * 1000;
  let changed = false;
  for (const [id, session] of sessions) {
    if (terminals.has(id)) {
      const term = terminals.get(id)!;
      // Ghost terminals follow the same 15-minute stale rule as sessions without terminals
      if (term.ghost && session.lastSeen < cutoff) {
        cleanupGhostTerminal(id);
        changed = true;
        continue;
      }
      // For non-ghost terminals, reset stale active states back to waiting
      if (session.state !== "waiting" && (now - session.stateChangedAt) > STATE_STALE_MS) {
        session.state = "waiting";
        session.stateChangedAt = now;
        changed = true;
      }
      continue;
    }
    if (session.lastSeen < cutoff) {
      sessions.delete(id);
      sessionLogs.delete(id);
      changed = true;
    }
  }
  if (changed) broadcastSessions();
}
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/sessions.test.ts 2>&1
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /home/abdul/observatory add server/sessions.ts server/sessions.test.ts && git -C /home/abdul/observatory commit -m "feat: pruneStale evicts ghost terminals after 15 minutes"
```

---

## Task 6: Auto-Register Ghost Terminal on UserPromptSubmit

**Files:**
- Modify: `server/hooks.ts`
- Modify: `server/hooks.test.ts` (add tests)

- [ ] **Step 1: Write failing tests**

Append to `server/hooks.test.ts`:

```typescript
import { handleHook } from "./hooks";
import { GHOST_NAMES } from "./state";

test("UserPromptSubmit from unknown session auto-registers a ghost terminal", () => {
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "external-session-abc",
    cwd: "/home/user/myproject",
  });

  expect(sessions.size).toBe(1);
  expect(terminals.size).toBe(1);

  const session = sessions.values().next().value!;
  expect(session.state).toBe("thinking");
  expect(session.source).toBe("claude");
  expect(session.cwd).toBe("/home/user/myproject");
  expect(typeof session.name).toBe("string");
  expect(GHOST_NAMES).toContain(session.name);

  const term = terminals.values().next().value!;
  expect(term.ghost).toBe(true);
  expect(term.proc).toBeNull();
});

test("subsequent hooks reuse the same ghost terminal", () => {
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "external-session-def",
    cwd: "/home/user/project",
  });

  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    session_id: "external-session-def",
    cwd: "/home/user/project",
  });

  // Still only 1 session and 1 terminal — no duplicates
  expect(sessions.size).toBe(1);
  expect(terminals.size).toBe(1);

  const session = sessions.values().next().value!;
  expect(session.state).toBe("reading");
});

test("non-UserPromptSubmit hook from unknown session is ignored", () => {
  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    session_id: "never-seen-session",
    cwd: "/home/user/project",
  });

  expect(sessions.size).toBe(0);
  expect(terminals.size).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: 3 new tests fail — auto-registration logic doesn't exist yet.

- [ ] **Step 3: Add auto-registration to hooks.ts**

Open `server/hooks.ts`. Find the existing import from `./state`:

```typescript
import { sessions, terminals, cliSessionToTerminal } from "./state";
```

Update it to include `generateGhostName`:

```typescript
import { sessions, terminals, cliSessionToTerminal, generateGhostName } from "./state";
```

Then add a helper function immediately before `processNormalizedHook`:

```typescript
function autoRegisterGhostSession(sessionId: string, cwd: string, source: string): string {
  const ghostId = `ghost-${sessionId.slice(0, 8)}-${Date.now()}`;
  const name = generateGhostName();
  terminals.set(ghostId, {
    id: ghostId,
    cwd,
    proc: null as any,
    ghost: true,
    subscribers: new Set(),
    outputBuffer: [],
  });
  cliSessionToTerminal.set(sessionId, ghostId);
  console.log(`[hook] auto-registered ghost ${ghostId} for ${source} session ${sessionId} (${name})`);
  upsertSession(ghostId, cwd, "thinking", source as import("./types").AgentSource, name);
  return ghostId;
}
```

Then in `processNormalizedHook`, replace the early-return block:

```typescript
  // Resolve terminal id: use env-injected id, or look up from prior mapping
  let terminalId = observatoryTerminalId || (sessionId ? cliSessionToTerminal.get(sessionId) : "");

  // Auto-register a ghost terminal for unknown external sessions on UserPromptSubmit
  if ((!terminalId || !terminals.has(terminalId)) && hookEvent === "UserPromptSubmit" && sessionId) {
    terminalId = autoRegisterGhostSession(sessionId, cwd, source);
  }

  if (!terminalId || !terminals.has(terminalId)) return;
```

- [ ] **Step 4: Run all hooks tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /home/abdul/observatory add server/hooks.ts server/hooks.test.ts && git -C /home/abdul/observatory commit -m "feat: auto-register ghost terminal on UserPromptSubmit from unknown session"
```

---

## Task 7: Handle Stop Hook for Ghost Terminals

**Files:**
- Modify: `server/hooks.ts`
- Modify: `server/hooks.test.ts` (add tests)

- [ ] **Step 1: Write failing tests**

Append to `server/hooks.test.ts`:

```typescript
test("Stop hook on ghost terminal removes it immediately", () => {
  // Register a ghost session first
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "ghost-stop-session",
    cwd: "/home/user/project",
  });
  expect(sessions.size).toBe(1);
  expect(terminals.size).toBe(1);

  // Fire Stop
  handleHook("claude", {
    hook_event_name: "Stop",
    session_id: "ghost-stop-session",
    cwd: "/home/user/project",
  });

  expect(sessions.size).toBe(0);
  expect(terminals.size).toBe(0);
  expect(cliSessionToTerminal.size).toBe(0);
});

test("Stop hook on real (non-ghost) terminal sets state to waiting, does not remove it", () => {
  const realId = "term-real-99";
  // Register a real terminal (ghost: undefined/false)
  terminals.set(realId, {
    id: realId, cwd: "/home/user", proc: {} as any,
    subscribers: new Set(), outputBuffer: [],
  });
  cliSessionToTerminal.set("real-cli-session", realId);
  sessions.set(realId, {
    id: realId, cwd: "/home/user", state: "thinking", source: "claude",
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });

  handleHook("claude", {
    hook_event_name: "Stop",
    session_id: "real-cli-session",
    cwd: "/home/user",
    observatory_terminal_id: realId,
  });

  expect(terminals.has(realId)).toBe(true);       // terminal stays
  expect(sessions.get(realId)?.state).toBe("waiting");  // state → waiting
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: 2 new tests fail — Stop hook doesn't yet detect ghost terminals.

- [ ] **Step 3: Add ghost Stop handling to hooks.ts**

Open `server/hooks.ts`. Add a new import at the top for `cleanupGhostTerminal` (hooks.ts does not currently import from `./terminals`, so add this as a new line):

```typescript
import { cleanupGhostTerminal } from "./terminals";
```

Then in `processNormalizedHook`, find the state mapping block and replace the `hookEvent === "Stop"` branch:

```typescript
  } else if (hookEvent === "Stop") {
    const term = terminals.get(terminalId);
    if (term?.ghost) {
      cleanupGhostTerminal(terminalId);
      return;
    }
    state = "waiting";
  }
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test 2>&1
```

Expected: all tests across both test files pass.

- [ ] **Step 5: Commit**

```bash
git -C /home/abdul/observatory add server/hooks.ts server/hooks.test.ts && git -C /home/abdul/observatory commit -m "feat: Stop hook on ghost terminal removes character immediately"
```

---

## Task 8: Display Ghost Session Name in game.js

**Files:**
- Modify: `public/game.js`

- [ ] **Step 1: Locate the character creation in syncSessions**

Open `public/game.js`. Find `function syncSessions` (around line 592). Inside the `if (!ch)` block, after these lines:

```javascript
ch = createCharacter(session.id, session.source || session.type || '', seatId, active);
characters.set(session.id, ch);
if (seatId) seatAssignments.set(seatId, session.id);
```

- [ ] **Step 2: Add name override from session**

Insert one line immediately after `characters.set(session.id, ch)`:

```javascript
if (session.name) ch.name = session.name;
```

The full block should now look like:

```javascript
ch = createCharacter(session.id, session.source || session.type || '', seatId, active);
characters.set(session.id, ch);
if (session.name) ch.name = session.name;
if (seatId) seatAssignments.set(seatId, session.id);
```

- [ ] **Step 3: Verify the server sends name in session broadcasts**

The `broadcastSessions` function in `server/broadcast.ts` sends `Array.from(sessions.values())` — so `session.name` is automatically included in the WebSocket payload. No change needed there.

- [ ] **Step 4: Commit**

```bash
git -C /home/abdul/observatory add public/game.js && git -C /home/abdul/observatory commit -m "feat: display server-assigned name for ghost sessions in UI"
```

---

## Task 9: End-to-End Verification

**Files:** none

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test 2>&1
```

Expected: all tests pass.

- [ ] **Step 2: Start Observatory**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun run dev
```

Open `http://localhost:7337` in a browser.

- [ ] **Step 3: Simulate a ghost session via curl**

In a separate terminal, simulate what the hook would send:

```bash
curl -s -X POST http://localhost:7337/hook/claude \
  -H "Content-Type: application/json" \
  -d '{"hook_event_name":"UserPromptSubmit","session_id":"test-ext-001","cwd":"/home/user/myproject"}'
```

Expected: a new character with a random name (Ada, Turing, Hopper, etc.) appears in the Observatory UI.

- [ ] **Step 4: Simulate subsequent tool use**

```bash
curl -s -X POST http://localhost:7337/hook/claude \
  -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PreToolUse","tool_name":"Read","session_id":"test-ext-001","cwd":"/home/user/myproject","tool_input":{"file_path":"/home/user/myproject/README.md"}}'
```

Expected: character state changes to the reading animation. No duplicate character appears.

- [ ] **Step 5: Simulate session end**

```bash
curl -s -X POST http://localhost:7337/hook/claude \
  -H "Content-Type: application/json" \
  -d '{"hook_event_name":"Stop","session_id":"test-ext-001","cwd":"/home/user/myproject"}'
```

Expected: character disappears from the Observatory UI immediately.

- [ ] **Step 6: Verify a real external claude session (if hooks are configured)**

Open a new terminal window (outside Observatory) and run `claude` in any directory. Type a prompt. Verify a character appears in Observatory. Complete or Ctrl-C the session. Verify the character disappears.

- [ ] **Step 7: Final commit**

```bash
git -C /home/abdul/observatory log --oneline -8
```

Verify all feature commits are present. No further changes needed.
