# Observatory v1.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ghost agent loitering (60-second couch-then-wander animation before removal), sub-agent ghost detection via Agent tool PreToolUse, startup session pickup by scanning running processes, and bump the version to 1.2.0.

**Architecture:** Server-side: ghost sessions no longer clean up immediately on `Stop`; instead they enter a 60-second loitering window tracked by `session.loiteringUntil`, with `pruneStale` handling actual removal. Sub-agents are detected both via their own `UserPromptSubmit` hooks (existing path, already works) and via a new proxy-ghost created when the parent fires `PreToolUse` with `tool_name: "agent"`. A new `startup-scan.ts` module scans running agent processes at boot and registers ghost sessions for them. Client-side: `game.js` reads `session.ghost` and runs a two-phase idle animation (sofa 0–20 s, wander 20–60 s) instead of the standard lounge wander.

**Tech Stack:** Bun runtime, TypeScript (server), vanilla JS (client game engine), bun:test for tests.

---

## File Map

| File | Change |
|---|---|
| `server/types.ts` | Add `ghost?`, `loiteringUntil?` to `Session`; add `activeSubagentGhostId?` to `Terminal` |
| `server/sessions.ts` | `upsertSession` preserves `ghost`/`loiteringUntil`; `pruneStale` checks `loiteringUntil` |
| `server/hooks.ts` | Stop → loitering; Agent PreToolUse → proxy ghost; Agent PostToolUse → proxy loitering; `autoRegisterGhostSession` adopts startup/proxy ghosts |
| `server/startup-scan.ts` | New: `parseAgentPids(psOutput)` + `scanRunningSessions()` |
| `server/index.ts` | Call `scanRunningSessions()` after server starts |
| `public/game.js` | `ghost` flag on characters; `SOFA_SIT_SPOTS` constant; sofa-sitting phase in `updateCharacter` IDLE; walk-to-sofa on inactive transition for ghosts |
| `server/sessions.test.ts` | New tests: `upsertSession` field preservation; `pruneStale` loitering |
| `server/hooks.test.ts` | Updated test: Stop → loitering; new tests: Agent PreToolUse/PostToolUse; adoption |
| `server/startup-scan.test.ts` | New: unit tests for `parseAgentPids` |
| `package.json` | Version `0.1.0` → `1.2.0` |

---

## Task 1: Update TypeScript Types

**Files:**
- Modify: `server/types.ts`

- [ ] **Step 1: Add fields to Session and Terminal interfaces**

Open `server/types.ts` and add the two new optional fields:

```ts
export interface Session {
  id: string;
  cwd: string;
  state: SessionState;
  source: AgentSource;
  lastSeen: number;
  startedAt: number;
  stateChangedAt: number;
  terminalId?: string;
  name?: string;
  ghost?: boolean;          // true for ghost and proxy sessions; never cleared once set
  loiteringUntil?: number;  // ms timestamp; pruneStale removes ghost when now >= this
}

export interface Terminal {
  id: string;
  cwd: string;
  proc: import("bun").Subprocess | null;
  subscribers: Set<import("bun").ServerWebSocket<WsData>>;
  outputBuffer: string[];
  ghost?: boolean;
  activeSubagentGhostId?: string;  // proxy ghost ID while Agent tool is running
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun run --bun tsc --noEmit --strict 2>&1 | head -30
```

Expected: no output (clean) or only pre-existing errors unrelated to the new fields.

- [ ] **Step 3: Commit**

```bash
git add server/types.ts
git commit -m "feat(types): add ghost, loiteringUntil to Session; activeSubagentGhostId to Terminal"
```

---

## Task 2: Preserve ghost/loiteringUntil in upsertSession

`upsertSession` currently rebuilds the session object from scratch. If `ghost` or `loiteringUntil` are set directly on the session after `upsertSession`, a subsequent `upsertSession` call would wipe them. Fix this by preserving them from `existing`.

**Files:**
- Modify: `server/sessions.ts`
- Test: `server/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `server/sessions.test.ts` (after the existing tests):

```ts
test("upsertSession preserves ghost flag across state updates", () => {
  sessions.set("ghost-abc", {
    id: "ghost-abc", cwd: "/p", state: "thinking", source: "claude",
    ghost: true,
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });

  upsertSession("ghost-abc", "/p", "editing", "claude");

  expect(sessions.get("ghost-abc")?.ghost).toBe(true);
});

test("upsertSession preserves loiteringUntil across state updates", () => {
  const until = Date.now() + 50_000;
  sessions.set("ghost-xyz", {
    id: "ghost-xyz", cwd: "/p", state: "waiting", source: "claude",
    ghost: true, loiteringUntil: until,
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });

  upsertSession("ghost-xyz", "/p", "waiting", "claude");

  expect(sessions.get("ghost-xyz")?.loiteringUntil).toBe(until);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/sessions.test.ts 2>&1
```

Expected: 2 new tests fail with `expected undefined to be true` / `expected undefined to be ...`

- [ ] **Step 3: Implement — preserve fields in upsertSession**

In `server/sessions.ts`, find the `sessions.set(id, { ... })` call inside `upsertSession` and add the two lines:

```ts
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
    ghost: existing?.ghost,
    loiteringUntil: existing?.loiteringUntil,
  });
  broadcastSessions();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/sessions.test.ts 2>&1
```

Expected: all tests pass including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add server/sessions.ts server/sessions.test.ts
git commit -m "feat(sessions): preserve ghost and loiteringUntil across upsertSession calls"
```

---

## Task 3: Ghost Loitering on Stop + pruneStale

**Files:**
- Modify: `server/hooks.ts`
- Modify: `server/sessions.ts`
- Modify: `server/hooks.test.ts`
- Modify: `server/sessions.test.ts`

- [ ] **Step 1: Update the existing Stop test and add new loitering tests**

In `server/hooks.test.ts`, **replace** the existing test `"Stop hook on ghost terminal removes it immediately"` with this updated version, and add two new `pruneStale` tests at the end:

```ts
// REPLACE this test (it tested immediate removal, which is no longer correct):
test("Stop hook on ghost terminal enters loitering instead of being removed", () => {
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "ghost-stop-session",
    cwd: "/home/user/project",
  });
  expect(sessions.size).toBe(1);
  expect(terminals.size).toBe(1);
  const [termId] = [...terminals.keys()];

  handleHook("claude", {
    hook_event_name: "Stop",
    session_id: "ghost-stop-session",
    cwd: "/home/user/project",
  });

  // Terminal and session are still present — loitering, not removed
  expect(terminals.has(termId)).toBe(true);
  expect(sessions.size).toBe(1);
  const s = sessions.get(termId)!;
  expect(s.state).toBe("waiting");
  expect(typeof s.loiteringUntil).toBe("number");
  expect(s.loiteringUntil!).toBeGreaterThan(Date.now() - 1_000);
  expect(s.loiteringUntil!).toBeLessThanOrEqual(Date.now() + 60_001);
  // cliSessionToTerminal still maps — don't clean up yet
  expect(cliSessionToTerminal.size).toBeGreaterThan(0);
});
```

Add to `server/sessions.test.ts`:

```ts
test("pruneStale removes ghost whose loiteringUntil is in the past", () => {
  const ghostId = "ghost-loiter-past";
  terminals.set(ghostId, {
    id: ghostId, cwd: "/p", proc: null as any,
    ghost: true, subscribers: new Set(), outputBuffer: [],
  } as Terminal);
  sessions.set(ghostId, {
    id: ghostId, cwd: "/p", state: "waiting", source: "claude",
    ghost: true,
    loiteringUntil: Date.now() - 1_000,
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });
  sessionLogs.set(ghostId, []);

  pruneStale();

  expect(terminals.has(ghostId)).toBe(false);
  expect(sessions.has(ghostId)).toBe(false);
});

test("pruneStale keeps ghost whose loiteringUntil is in the future", () => {
  const ghostId = "ghost-loiter-future";
  terminals.set(ghostId, {
    id: ghostId, cwd: "/p", proc: null as any,
    ghost: true, subscribers: new Set(), outputBuffer: [],
  } as Terminal);
  sessions.set(ghostId, {
    id: ghostId, cwd: "/p", state: "waiting", source: "claude",
    ghost: true,
    loiteringUntil: Date.now() + 30_000,
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });

  pruneStale();

  expect(terminals.has(ghostId)).toBe(true);
  expect(sessions.has(ghostId)).toBe(true);
});

test("pruneStale still removes ghost with no loiteringUntil after 15 minutes (existing rule)", () => {
  const ghostId = "ghost-stale-no-loiter";
  const staleTime = Date.now() - 16 * 60 * 1000;
  terminals.set(ghostId, {
    id: ghostId, cwd: "/p", proc: null as any,
    ghost: true, subscribers: new Set(), outputBuffer: [],
  } as Terminal);
  sessions.set(ghostId, {
    id: ghostId, cwd: "/p", state: "thinking", source: "claude",
    ghost: true,
    lastSeen: staleTime, startedAt: staleTime, stateChangedAt: staleTime,
  });
  sessionLogs.set(ghostId, []);

  pruneStale();

  expect(terminals.has(ghostId)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify the updated/new tests fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts server/sessions.test.ts 2>&1
```

Expected: the renamed Stop test fails (still removes immediately), 2 new pruneStale tests fail.

- [ ] **Step 3: Implement — Stop handler in hooks.ts**

In `server/hooks.ts`, find the `hookEvent === "Stop"` branch inside `processNormalizedHook`. Replace:

```ts
  } else if (hookEvent === "Stop") {
    const term = terminals.get(terminalId);
    if (term?.ghost) {
      cleanupGhostTerminal(terminalId);
      return;
    }
    state = "waiting";
  }
```

With:

```ts
  } else if (hookEvent === "Stop") {
    const term = terminals.get(terminalId);
    if (term?.ghost) {
      const ghostSession = sessions.get(terminalId);
      if (ghostSession) {
        const now = Date.now();
        ghostSession.state = "waiting";
        ghostSession.loiteringUntil = now + 60_000;
        ghostSession.stateChangedAt = now;
        ghostSession.lastSeen = now;
      }
      broadcastSessions();
      return;
    }
    state = "waiting";
  }
```

- [ ] **Step 4: Implement — pruneStale in sessions.ts**

In `server/sessions.ts`, find the ghost terminal pruning block inside `pruneStale`:

```ts
      // Ghost terminals follow the same 15-minute stale rule as sessions without terminals
      if (term.ghost && session.lastSeen < cutoff) {
        cleanupGhostTerminal(id, true);  // pruneStale will broadcast once after the loop
        changed = true;
        continue;
      }
```

Replace with:

```ts
      if (term.ghost) {
        const now = Date.now();
        // Loitering ghost: remove once the 60-second window expires
        if (session.loiteringUntil && now >= session.loiteringUntil) {
          cleanupGhostTerminal(id, true);
          changed = true;
          continue;
        }
        // Active ghost with no loiteringUntil: fall back to 15-minute stale rule
        if (!session.loiteringUntil && session.lastSeen < cutoff) {
          cleanupGhostTerminal(id, true);
          changed = true;
          continue;
        }
        continue;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts server/sessions.test.ts 2>&1
```

Expected: all tests pass including the renamed Stop test and 3 new pruneStale tests.

- [ ] **Step 6: Commit**

```bash
git add server/hooks.ts server/sessions.ts server/hooks.test.ts server/sessions.test.ts
git commit -m "feat(ghost): loiter 60s after Stop instead of immediate cleanup"
```

---

## Task 4: Sub-agent Proxy Ghost (Agent PreToolUse / PostToolUse)

When the parent terminal fires `PreToolUse` with `tool_name: "agent"`, create a proxy ghost to represent the sub-agent. When `PostToolUse` fires for the same tool, put the proxy into loitering (if it wasn't already adopted by the sub-agent's own hooks).

**Files:**
- Modify: `server/hooks.ts`
- Modify: `server/hooks.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/hooks.test.ts`:

```ts
function makeRealTerminal(termId: string, sessionId: string, cwd = "/proj"): void {
  terminals.set(termId, {
    id: termId, cwd, proc: {} as any, subscribers: new Set(), outputBuffer: [],
  });
  cliSessionToTerminal.set(sessionId, termId);
  sessions.set(termId, {
    id: termId, cwd, state: "thinking", source: "claude",
    lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });
}

test("PreToolUse Agent on known real terminal creates proxy ghost", () => {
  makeRealTerminal("term-1", "parent-sess-1");

  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    session_id: "parent-sess-1",
    cwd: "/proj",
    observatory_terminal_id: "term-1",
  });

  // One extra terminal/session for the proxy ghost
  expect(terminals.size).toBe(2);
  expect(sessions.size).toBe(2);
  const proxy = [...terminals.values()].find(t => t.ghost && t.id.startsWith("agentghost-"));
  expect(proxy).toBeDefined();
  expect(sessions.get(proxy!.id)?.state).toBe("thinking");
  expect(sessions.get(proxy!.id)?.ghost).toBe(true);
  // activeSubagentGhostId is set on parent terminal
  expect(terminals.get("term-1")?.activeSubagentGhostId).toBe(proxy!.id);
});

test("PostToolUse Agent puts un-adopted proxy ghost into loitering", () => {
  makeRealTerminal("term-2", "parent-sess-2", "/proj2");

  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    session_id: "parent-sess-2",
    cwd: "/proj2",
    observatory_terminal_id: "term-2",
  });

  const proxyId = [...terminals.keys()].find(k => k.startsWith("agentghost-"))!;
  expect(proxyId).toBeDefined();

  handleHook("claude", {
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    session_id: "parent-sess-2",
    cwd: "/proj2",
    observatory_terminal_id: "term-2",
  });

  // Proxy still present but loitering
  expect(terminals.has(proxyId)).toBe(true);
  const ps = sessions.get(proxyId)!;
  expect(ps.state).toBe("waiting");
  expect(typeof ps.loiteringUntil).toBe("number");
  expect(ps.loiteringUntil!).toBeGreaterThan(Date.now() - 1_000);
  // activeSubagentGhostId is cleared
  expect(terminals.get("term-2")?.activeSubagentGhostId).toBeUndefined();
});

test("PostToolUse Agent is no-op when proxy was already adopted", () => {
  makeRealTerminal("term-3", "parent-sess-3", "/proj3");

  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    session_id: "parent-sess-3",
    cwd: "/proj3",
    observatory_terminal_id: "term-3",
  });

  const proxyId = [...terminals.keys()].find(k => k.startsWith("agentghost-"))!;

  // Simulate adoption: sub-agent's UserPromptSubmit removes the sentinel key
  cliSessionToTerminal.delete("proxy:" + proxyId);
  // Also clear activeSubagentGhostId (adoption does this)
  terminals.get("term-3")!.activeSubagentGhostId = undefined;

  // PostToolUse fires — should NOT set loiteringUntil (real Stop hook handles it)
  handleHook("claude", {
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    session_id: "parent-sess-3",
    cwd: "/proj3",
    observatory_terminal_id: "term-3",
  });

  expect(sessions.get(proxyId)?.loiteringUntil).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: 3 new tests fail (proxy ghost not created, PostToolUse no-op).

- [ ] **Step 3: Implement — Agent PreToolUse detection**

In `server/hooks.ts`, add `broadcastSessions` to the imports at the top (it may already be imported — check):

```ts
import { broadcastSessions, appendLog } from "./broadcast";
```

In `processNormalizedHook`, inside the `hookEvent === "PreToolUse"` branch, **before** the existing `askuserquestion` check, add:

```ts
  } else if (hookEvent === "PreToolUse") {
    if (/^(agent|dispatch|task)$/i.test(toolName)) {
      const parentTerm = terminals.get(terminalId);
      if (parentTerm && !parentTerm.ghost) {
        const proxyId = `agentghost-${terminalId.slice(0, 8)}-${Date.now()}`;
        const proxyName = generateGhostName();
        terminals.set(proxyId, {
          id: proxyId, cwd, proc: null, ghost: true,
          subscribers: new Set(), outputBuffer: [],
        });
        cliSessionToTerminal.set("proxy:" + proxyId, proxyId);
        parentTerm.activeSubagentGhostId = proxyId;
        upsertSession(proxyId, cwd, "thinking", agentSource, proxyName);
        const ps = sessions.get(proxyId);
        if (ps) ps.ghost = true;
      }
      state = "thinking";
    } else if (/^askuserquestion$/i.test(toolName)) {
```

- [ ] **Step 4: Implement — Agent PostToolUse handling**

In `processNormalizedHook`, change the `hookEvent === "PostToolUse"` branch from:

```ts
  } else if (hookEvent === "PostToolUse") {
    state = "thinking";
  }
```

To:

```ts
  } else if (hookEvent === "PostToolUse") {
    if (/^(agent|dispatch|task)$/i.test(toolName)) {
      const parentTerm = terminals.get(terminalId);
      if (parentTerm?.activeSubagentGhostId) {
        const proxyId = parentTerm.activeSubagentGhostId;
        parentTerm.activeSubagentGhostId = undefined;
        // Only start loitering if the proxy was NOT adopted by the sub-agent's real hooks
        if (cliSessionToTerminal.has("proxy:" + proxyId)) {
          cliSessionToTerminal.delete("proxy:" + proxyId);
          const proxySession = sessions.get(proxyId);
          if (proxySession) {
            const now = Date.now();
            proxySession.state = "waiting";
            proxySession.loiteringUntil = now + 60_000;
            proxySession.stateChangedAt = now;
            proxySession.lastSeen = now;
          }
          broadcastSessions();
        }
      }
    }
    state = "thinking";
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/hooks.ts server/hooks.test.ts
git commit -m "feat(hooks): create proxy ghost on Agent PreToolUse, loiter on PostToolUse"
```

---

## Task 5: Adoption Logic in autoRegisterGhostSession

When `UserPromptSubmit` arrives from an unknown session, instead of always creating a new ghost, check for an existing startup or proxy ghost with matching `cwd` and adopt it. This prevents duplicate characters when both the startup scan and real hooks fire.

**Files:**
- Modify: `server/hooks.ts`
- Modify: `server/hooks.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/hooks.test.ts`:

```ts
test("UserPromptSubmit adopts proxy ghost with matching cwd instead of creating new ghost", () => {
  // Set up a real terminal with a proxy ghost already created
  makeRealTerminal("term-adopt-1", "parent-adopt-1", "/proj-adopt");

  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    session_id: "parent-adopt-1",
    cwd: "/proj-adopt",
    observatory_terminal_id: "term-adopt-1",
  });

  const beforeCount = terminals.size; // 2: real + proxy
  const proxyId = [...terminals.keys()].find(k => k.startsWith("agentghost-"))!;

  // Sub-agent fires UserPromptSubmit with its real session_id
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "subagent-real-id-1",
    cwd: "/proj-adopt",
  });

  // No new terminal created — proxy was adopted
  expect(terminals.size).toBe(beforeCount);
  // Sub-agent session maps to the proxy ghost id
  expect(cliSessionToTerminal.get("subagent-real-id-1")).toBe(proxyId);
  // Sentinel key is gone
  expect(cliSessionToTerminal.has("proxy:" + proxyId)).toBe(false);
  // Ghost state updated to thinking
  expect(sessions.get(proxyId)?.state).toBe("thinking");
  // activeSubagentGhostId cleared on parent terminal (PostToolUse won't double-loiter)
  expect(terminals.get("term-adopt-1")?.activeSubagentGhostId).toBeUndefined();
});

test("UserPromptSubmit does not adopt a proxy ghost that is already loitering", () => {
  makeRealTerminal("term-adopt-2", "parent-adopt-2", "/proj-adopt2");

  handleHook("claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    session_id: "parent-adopt-2",
    cwd: "/proj-adopt2",
    observatory_terminal_id: "term-adopt-2",
  });
  const proxyId = [...terminals.keys()].find(k => k.startsWith("agentghost-"))!;

  // Force the proxy into loitering manually
  const ps = sessions.get(proxyId)!;
  ps.loiteringUntil = Date.now() + 30_000;
  ps.state = "waiting";

  const beforeCount = terminals.size;

  // New sub-agent UserPromptSubmit should create a fresh ghost, not adopt the loitering one
  handleHook("claude", {
    hook_event_name: "UserPromptSubmit",
    session_id: "subagent-new-id",
    cwd: "/proj-adopt2",
  });

  // A new ghost was created
  expect(terminals.size).toBe(beforeCount + 1);
  expect(cliSessionToTerminal.get("subagent-new-id")).not.toBe(proxyId);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: 2 new adoption tests fail.

- [ ] **Step 3: Implement — findAdoptableGhost and updated autoRegisterGhostSession**

In `server/hooks.ts`, add the `findAdoptableGhost` helper function immediately above `autoRegisterGhostSession`:

```ts
function findAdoptableGhost(cwd: string): string | null {
  for (const [id, term] of terminals) {
    if (!term.ghost) continue;
    if (term.cwd !== cwd) continue;
    const s = sessions.get(id);
    if (s?.loiteringUntil) continue;  // already loitering — don't adopt
    if (id.startsWith("startup-") || id.startsWith("agentghost-")) return id;
  }
  return null;
}
```

Replace the body of `autoRegisterGhostSession` with:

```ts
function autoRegisterGhostSession(sessionId: string, cwd: string, source: string): string {
  const adoptable = findAdoptableGhost(cwd);
  if (adoptable) {
    cliSessionToTerminal.set(sessionId, adoptable);
    cliSessionToTerminal.delete("proxy:" + adoptable);
    // Clear activeSubagentGhostId so PostToolUse won't double-loiter this ghost
    for (const [, term] of terminals) {
      if (term.activeSubagentGhostId === adoptable) term.activeSubagentGhostId = undefined;
    }
    const agentSrc = source as import("./types").AgentSource;
    upsertSession(adoptable, cwd, "thinking", agentSrc, sessions.get(adoptable)?.name);
    console.log(`[hook] adopted ghost ${adoptable} for session ${sessionId}`);
    return adoptable;
  }

  const ghostId = `ghost-${sessionId.slice(0, 8)}-${Date.now()}`;
  const name = generateGhostName();
  terminals.set(ghostId, {
    id: ghostId, cwd, proc: null, ghost: true,
    subscribers: new Set(), outputBuffer: [],
  });
  cliSessionToTerminal.set(sessionId, ghostId);
  console.log(`[hook] auto-registered ghost ${ghostId} for ${source} session ${sessionId} (${name})`);
  upsertSession(ghostId, cwd, "thinking", source as import("./types").AgentSource, name);
  const gs = sessions.get(ghostId);
  if (gs) gs.ghost = true;
  return ghostId;
}
```

Also update the existing `autoRegisterGhostSession` to set `ghost: true` on newly created (non-adopted) sessions. The two lines `const gs = sessions.get(ghostId); if (gs) gs.ghost = true;` achieve this.

- [ ] **Step 4: Run all hooks tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/hooks.ts server/hooks.test.ts
git commit -m "feat(hooks): adopt startup/proxy ghost by cwd on UserPromptSubmit"
```

---

## Task 6: Startup Session Scan

Scan running AI agent processes at server boot and register ghost sessions for them.

**Files:**
- Create: `server/startup-scan.ts`
- Create: `server/startup-scan.test.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Write failing tests for parseAgentPids**

Create `server/startup-scan.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseAgentPids } from "./startup-scan";

const PS_HEADER = "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND";

test("parseAgentPids includes claude processes", () => {
  const output = [
    PS_HEADER,
    "user      1234  2.0  0.5 123456 45678 pts/0   Sl+  10:00   0:05 claude --chat",
  ].join("\n");
  expect(parseAgentPids(output)).toContain("1234");
});

test("parseAgentPids includes cursor processes", () => {
  const output = [
    PS_HEADER,
    "user      5678  1.5  0.3  67890 12345 pts/2   Sl+  10:00   0:02 /usr/bin/cursor .",
  ].join("\n");
  expect(parseAgentPids(output)).toContain("5678");
});

test("parseAgentPids excludes observatory-hook processes", () => {
  const output = [
    PS_HEADER,
    "user      1111  0.0  0.1  10000  1000 pts/0   S+   10:00   0:00 node observatory-hook.js claude",
    "user      2222  2.0  0.5 100000 40000 pts/1   Sl+  10:00   0:05 claude",
  ].join("\n");
  const pids = parseAgentPids(output);
  expect(pids).not.toContain("1111");
  expect(pids).toContain("2222");
});

test("parseAgentPids excludes grep and observatory processes", () => {
  const output = [
    PS_HEADER,
    "user      3333  0.0  0.0   5000   500 pts/0   S+   10:00   0:00 grep claude",
    "user      4444  1.0  0.2  50000 10000 pts/1   Sl+  10:00   0:01 node server/index.ts",
  ].join("\n");
  const pids = parseAgentPids(output);
  expect(pids).not.toContain("3333");
  expect(pids).not.toContain("4444");
});

test("parseAgentPids returns empty array for no matches", () => {
  const output = [PS_HEADER, "user   9999  0.0  0.0  1000  100 pts/0 S+ 10:00 0:00 bash"].join("\n");
  expect(parseAgentPids(output)).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/startup-scan.test.ts 2>&1
```

Expected: import error (file doesn't exist yet).

- [ ] **Step 3: Create server/startup-scan.ts**

```ts
import { spawn } from "bun";
import { readlink } from "fs/promises";
import { terminals, sessions, generateGhostName } from "./state";
import { upsertSession } from "./sessions";

const AGENT_RE  = /\b(claude|cursor|copilot|gemini)\b/i;
const NOISE_RE  = /observatory|hook\.js|grep/i;

/** Extract PIDs of running AI agent processes from `ps aux` output. */
export function parseAgentPids(psOutput: string): string[] {
  const pids: string[] = [];
  for (const line of psOutput.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;
    const pid = parts[1];
    const cmd = parts.slice(10).join(" ");
    if (AGENT_RE.test(cmd) && !NOISE_RE.test(cmd)) pids.push(pid);
  }
  return pids;
}

/** Scan running agent processes and register ghost sessions for unknown ones. */
export async function scanRunningSessions(): Promise<void> {
  try {
    const proc = spawn(["ps", "aux"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const pids = parseAgentPids(output);

    // Collect cwds already tracked to avoid duplicates
    const knownCwds = new Set<string>();
    for (const term of terminals.values()) knownCwds.add(term.cwd);

    for (const pid of pids) {
      try {
        const cwd = await readlink(`/proc/${pid}/cwd`);
        if (knownCwds.has(cwd)) continue;
        knownCwds.add(cwd);

        const ghostId = `startup-${pid}`;
        const name = generateGhostName();
        terminals.set(ghostId, {
          id: ghostId, cwd, proc: null, ghost: true,
          subscribers: new Set(), outputBuffer: [],
        });
        upsertSession(ghostId, cwd, "waiting", "claude", name);
        const s = sessions.get(ghostId);
        if (s) s.ghost = true;
        console.log(`[startup] ghost registered for pid ${pid} at ${cwd} (${name})`);
      } catch {
        // process exited or /proc not readable — skip silently
      }
    }
  } catch {
    // ps unavailable (macOS, permission denied) — silent fallback
  }
}
```

- [ ] **Step 4: Run startup-scan tests to verify they pass**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/startup-scan.test.ts 2>&1
```

Expected: all 5 tests pass.

- [ ] **Step 5: Wire up scanRunningSessions in index.ts**

In `server/index.ts`, add the import at the top (with the other imports):

```ts
import { scanRunningSessions } from "./startup-scan";
```

At the very bottom of the file, after the `console.log` lines, add:

```ts
// Scan for already-running agent sessions so they appear immediately on startup
scanRunningSessions().catch(() => {});
```

- [ ] **Step 6: Run full test suite**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test 2>&1
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/startup-scan.ts server/startup-scan.test.ts server/index.ts
git commit -m "feat(startup): scan running agent processes and register ghost sessions on boot"
```

---

## Task 7: Client — Ghost Flag + Sofa Animation

**Files:**
- Modify: `public/game.js`

No automated tests for game.js — verify visually by running the server.

- [ ] **Step 1: Add SOFA_SIT_SPOTS constant**

In `public/game.js`, add the constant immediately after the `LOUNGE_TABLE_SPOTS` definition (after line 97 approximately):

```js
  // ── Sofa sitting spots for ghost loitering (phase 1: 0–20 s) ─────────────
  const SOFA_SIT_SPOTS = [
    { col: 14, row: 12, dir: DIR.DOWN },
    { col: 15, row: 12, dir: DIR.DOWN },
  ];
```

- [ ] **Step 2: Add ghost field to createCharacter return object**

In `public/game.js`, in `createCharacter`, add `ghost: false` to the returned object (add it after `startedAt: Date.now()`):

```js
    return {
      sessionId, type, seatId,
      name:     CHAR_NAMES[slot],
      palette,
      state:    STATE.TYPE,
      dir:      seat ? seat.dir : DIR.DOWN,
      x: center.x, y: center.y,
      tileCol: col, tileRow: row,
      path: [], moveProgress: 0,
      isActive,
      isReading:  false,
      needsInput: false,
      bubbleType: null,
      frame: 0, frameTimer: 0,
      wanderTimer: 0,
      seatTimer: 0,
      stateChangedAt: Date.now(),
      startedAt: Date.now(),
      ghost: false,
    };
```

- [ ] **Step 3: Propagate ghost flag in syncSessions**

In `public/game.js`, in `syncSessions`, find the block that creates a new character:

```js
      if (!ch) {
        if (characters.size >= MAX_AGENTS) continue; // cap at 4 agents
        const seatId = assignSeat();
        // Initialize isActive correctly so applySessionState sees no fake transition
        const active = !['waiting', 'error'].includes(session.state);
        ch = createCharacter(session.id, session.source || session.type || '', seatId, active);
        characters.set(session.id, ch);
        if (session.name) ch.name = session.name;
        if (seatId) seatAssignments.set(seatId, session.id);
      }
```

Change it to set `ghost` **before** calling `applySessionState` (so the inactive-transition branch in `applySessionState` can check `ch.ghost`):

```js
      if (!ch) {
        if (characters.size >= MAX_AGENTS) continue; // cap at 4 agents
        const seatId = assignSeat();
        // Initialize isActive correctly so applySessionState sees no fake transition
        const active = !['waiting', 'error'].includes(session.state);
        ch = createCharacter(session.id, session.source || session.type || '', seatId, active);
        characters.set(session.id, ch);
        if (session.name) ch.name = session.name;
        if (seatId) seatAssignments.set(seatId, session.id);
      }
      // Sync ghost flag before applySessionState so the inactive transition can use it
      ch.ghost = session.ghost === true;
```

The `ch.ghost = session.ghost === true;` line goes immediately after the closing `}` of the `if (!ch)` block, before the `ch.startedAt = ...` line.

- [ ] **Step 4: Modify applySessionState inactive transition**

In `public/game.js`, find this block in `applySessionState`:

```js
    // Became inactive → start wander phase (left room if terminal open, lounge otherwise)
    if (wasActive && !ch.isActive) {
      ch.stateChangedAt = Date.now();
      ch.wanderTimer = 0;
      const termOpen = document.getElementById('terminal-panel').classList.contains('open');
      const restTiles = termOpen ? buildLeftRoomTiles() : buildLoungeTiles();
      if (restTiles.length > 0) {
        const t = restTiles[Math.floor(Math.random() * restTiles.length)];
        walkTo(ch, t.col, t.row, ch.dir);
      }
    }
```

Replace with:

```js
    // Became inactive → ghosts walk to sofa; others wander lounge or left room
    if (wasActive && !ch.isActive) {
      ch.stateChangedAt = Date.now();
      ch.wanderTimer = 0;
      if (ch.ghost) {
        const sofaSpot = SOFA_SIT_SPOTS[ch.palette % SOFA_SIT_SPOTS.length];
        walkTo(ch, sofaSpot.col, sofaSpot.row, sofaSpot.dir);
      } else {
        const termOpen = document.getElementById('terminal-panel').classList.contains('open');
        const restTiles = termOpen ? buildLeftRoomTiles() : buildLoungeTiles();
        if (restTiles.length > 0) {
          const t = restTiles[Math.floor(Math.random() * restTiles.length)];
          walkTo(ch, t.col, t.row, ch.dir);
        }
      }
    }
```

- [ ] **Step 5: Add ghost loitering phases to updateCharacter IDLE case**

In `public/game.js`, in `updateCharacter`, find the `STATE.IDLE` case. After the `if (ch.isActive) { ... break; }` block and before the `// Inactive — phase 1: wander` comment, insert the ghost loitering block:

```js
      case STATE.IDLE: {
        ch.frame = 0;
        if (ch.isActive) {
          if (!ch.seatId) {
            ch.state = STATE.TYPE; ch.frame = 0; ch.frameTimer = 0;
            break;
          }
          const seat = SEAT_DEFS.find(s => s.seatId === ch.seatId);
          if (seat) {
            const path = findPath(ch.tileCol, ch.tileRow, seat.col, seat.row);
            if (path.length > 0) {
              ch.path = path; ch.moveProgress = 0;
              ch.state = STATE.WALK; ch.frame = 0; ch.frameTimer = 0;
            } else {
              ch.state = STATE.TYPE; ch.dir = seat.dir; ch.frame = 0; ch.frameTimer = 0;
            }
          }
          break;
        }

        // Ghost loitering: phase 1 (0–20 s) sit on sofa, phase 2 (20–60 s) wander lounge
        if (ch.ghost) {
          const elapsed = ch.stateChangedAt ? (Date.now() - ch.stateChangedAt) / 1000 : 0;
          if (elapsed < 20) {
            const sofaSpot = SOFA_SIT_SPOTS[ch.palette % SOFA_SIT_SPOTS.length];
            if (ch.tileCol !== sofaSpot.col || ch.tileRow !== sofaSpot.row) {
              walkTo(ch, sofaSpot.col, sofaSpot.row, sofaSpot.dir);
            } else {
              ch.dir = sofaSpot.dir;
            }
            break;
          }
          // Phase 2 (elapsed >= 20 s): fall through to normal lounge wander below
        }

        // Inactive — phase 1: wander (0–5 min), phase 2: sleep (5–15 min)
        // ... (existing code unchanged from here) ...
```

The exact edit: find the `// Inactive — phase 1: wander (0–5 min), phase 2: sleep (5–15 min)` comment in the IDLE case and insert the ghost block immediately before it (the full block above replaces the existing IDLE case header through that comment).

- [ ] **Step 6: Verify the app runs and visually test ghost loitering**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun run dev &
```

Open `http://localhost:7337` in a browser. Then simulate a ghost session lifecycle:

```bash
# Register a ghost session
curl -s -X POST http://localhost:7337/hook/claude \
  -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"UserPromptSubmit","session_id":"test-ghost-1","cwd":"/tmp"}'

# Wait a few seconds, then fire Stop
sleep 3
curl -s -X POST http://localhost:7337/hook/claude \
  -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"Stop","session_id":"test-ghost-1","cwd":"/tmp"}'
```

Expected: character appears, walks to desk, then on Stop: walks to sofa area (cols 14–15, row 12) and sits for ~20 s, then starts wandering the lounge, then disappears after ~60 s.

```bash
# Kill dev server
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add public/game.js
git commit -m "feat(ui): ghost loitering animation — sofa sit 0-20s then wander before removal"
```

---

## Task 8: Version Bump + Full Test Suite

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version to 1.2.0**

In `package.json`, change:

```json
  "version": "0.1.0",
```

To:

```json
  "version": "1.2.0",
```

- [ ] **Step 2: Run the full test suite**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test 2>&1
```

Expected: all tests pass. Count should be higher than before this branch — check for any regressions.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 1.2.0"
```

---

## Self-Review

**Spec coverage:**
- ✅ Ghost loitering 60 s: Task 3 (server Stop handler + pruneStale)
- ✅ Sofa 0–20 s → wander 20–60 s: Task 7 (client animation)
- ✅ Sub-agent proxy ghost (Agent PreToolUse/PostToolUse): Task 4
- ✅ Sub-agent own-hooks path (existing, now stays visible): Task 3 (loitering keeps them alive)
- ✅ Proxy ghost adoption on UserPromptSubmit: Task 5
- ✅ Startup scan: Task 6
- ✅ Startup ghost adoption: Task 5 (`findAdoptableGhost` covers `startup-*` prefix)
- ✅ `upsertSession` field preservation: Task 2
- ✅ `ghost: true` set at session creation: Task 5 (`gs.ghost = true` line)
- ✅ `ghost: true` broadcast to client: Task 2 (preserved through upsertSession) + Task 6 (set on creation)
- ✅ Version 1.2.0: Task 8
- ✅ Real Observatory terminal sessions unaffected: Stop handler checks `term.ghost` before branching

**Placeholder scan:** None found — all steps contain exact code.

**Type consistency:**
- `session.ghost` used in sessions.ts (Task 2), hooks.ts (Tasks 3–5), startup-scan.ts (Task 6), game.js (Task 7) — consistent.
- `session.loiteringUntil` used in hooks.ts (Task 3), sessions.ts (Task 3), hooks.ts (Task 4) — consistent.
- `terminal.activeSubagentGhostId` used in hooks.ts (Tasks 4–5) — consistent.
- `SOFA_SIT_SPOTS` defined in Task 7 step 1, used in steps 4 and 5 — consistent.
- `findAdoptableGhost` defined and used in Task 5 — consistent.
- `parseAgentPids` exported in Task 6 step 3, imported in Task 6 step 1 test — consistent.
