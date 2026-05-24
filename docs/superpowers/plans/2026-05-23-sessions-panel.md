# Sessions Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix ghost loitering overshoot and add a modal sessions panel with per-session kill and grouping by project.

**Architecture:** Server gets a `setTimeout`-based precise loitering cleanup and a `DELETE /api/sessions/:id` endpoint. Client gets a `#sessions-btn` button, a `#sessions-modal` popup, and `renderSessionsModal()` logic wired to the existing `allSessions` WebSocket feed.

**Tech Stack:** Bun/TypeScript (server), vanilla JS + HTML/CSS (client), bun:test for server tests.

---

## File Map

| File | Change |
|---|---|
| `server/hooks.ts` | Add `setTimeout` precise cleanup after setting `loiteringUntil` |
| `server/index.ts` | Import `cleanupGhostTerminal`; add `DELETE /api/sessions/:id` route |
| `server/hooks.test.ts` | Add test for the DELETE handler logic |
| `public/index.html` | Add `#sessions-btn`, `#sessions-backdrop`, `#sessions-modal` markup |
| `public/styles.css` | Add styles for all new elements |
| `public/game.js` | Add modal open/close/render/kill logic; hook into WS update |

---

## Task 1: Loitering precision fix

**Files:**
- Modify: `server/hooks.ts`

- [ ] **Step 1: Verify current tests pass before touching anything**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test 2>&1
```

Expected: 28 pass, 0 fail.

- [ ] **Step 2: Implement — add setTimeout in the Stop ghost handler**

In `server/hooks.ts`, find the ghost Stop handler. Replace:

```ts
      if (ghostSession) {
        const now = Date.now();
        ghostSession.state = "waiting";
        ghostSession.loiteringUntil = now + 60_000;
        ghostSession.stateChangedAt = now;
        ghostSession.lastSeen = now;
      }
      broadcastSessions();
      return;
```

With:

```ts
      if (ghostSession) {
        const now = Date.now();
        ghostSession.state = "waiting";
        ghostSession.loiteringUntil = now + 60_000;
        ghostSession.stateChangedAt = now;
        ghostSession.lastSeen = now;
        const loiterExpiry = ghostSession.loiteringUntil;
        setTimeout(() => {
          const s = sessions.get(terminalId);
          if (s?.loiteringUntil === loiterExpiry) {
            cleanupGhostTerminal(terminalId);
            broadcastSessions();
          }
        }, 60_100);
      }
      broadcastSessions();
      return;
```

- [ ] **Step 3: Run tests to confirm nothing regressed**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test 2>&1
```

Expected: 28 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
cd /home/abdul/observatory && git add server/hooks.ts && git commit -m "fix(ghost): schedule precise cleanup 60s after loitering starts"
```

---

## Task 2: DELETE /api/sessions/:id endpoint

**Files:**
- Modify: `server/index.ts`
- Modify: `server/hooks.test.ts`

- [ ] **Step 1: Write a failing test**

Add to the end of `server/hooks.test.ts`:

```ts
test("cleanupGhostTerminal removes all ghost state (DELETE handler contract)", () => {
  const id = "del-ghost-99";
  terminals.set(id, {
    id, cwd: "/tmp", proc: null as any, ghost: true,
    subscribers: new Set(), outputBuffer: [],
  } as Terminal);
  sessions.set(id, {
    id, cwd: "/tmp", state: "waiting", source: "claude",
    ghost: true, lastSeen: Date.now(), startedAt: Date.now(), stateChangedAt: Date.now(),
  });
  sessionLogs.set(id, []);
  cliSessionToTerminal.set("some-sess", id);

  cleanupGhostTerminal(id);

  expect(terminals.has(id)).toBe(false);
  expect(sessions.has(id)).toBe(false);
  expect(cliSessionToTerminal.get("some-sess")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it passes (cleanupGhostTerminal already works)**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test server/hooks.test.ts 2>&1
```

Expected: all tests pass including the new one.

- [ ] **Step 3: Add cleanupGhostTerminal import to index.ts**

In `server/index.ts`, change:

```ts
import { spawnTerminal, killTerminal, writeTerminal, resizeTerminal } from "./terminals";
```

To:

```ts
import { spawnTerminal, killTerminal, writeTerminal, resizeTerminal, cleanupGhostTerminal } from "./terminals";
```

- [ ] **Step 4: Add the DELETE route to index.ts**

Find the line:

```ts
    return serveStatic(pathname);
```

Insert immediately before it:

```ts
    if (req.method === "DELETE" && pathname.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(pathname.slice("/api/sessions/".length));
      if (id) {
        const term = terminals.get(id);
        if (term?.ghost) {
          cleanupGhostTerminal(id);
        } else {
          sessions.delete(id);
        }
        broadcastSessions();
      }
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    }

```

- [ ] **Step 5: Run full test suite**

```bash
cd /home/abdul/observatory && ~/.bun/bin/bun test 2>&1
```

Expected: 29 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /home/abdul/observatory && git add server/index.ts server/hooks.test.ts && git commit -m "feat(api): add DELETE /api/sessions/:id endpoint"
```

---

## Task 3: Sessions panel HTML + CSS

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`

- [ ] **Step 1: Add markup to index.html**

In `public/index.html`, find:

```html
  <!-- Command palette overlay -->
```

Insert immediately before that line:

```html
  <!-- Sessions button -->
  <button id="sessions-btn" title="Sessions">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
      <circle cx="3" cy="6" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="3" cy="12" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="3" cy="18" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  </button>

  <!-- Sessions backdrop + modal -->
  <div id="sessions-backdrop"></div>
  <div id="sessions-modal">
    <div id="sessions-modal-header">
      <span id="sessions-modal-title">Sessions</span>
      <button id="sessions-modal-close" title="Close">&#x2715;</button>
    </div>
    <div id="sessions-modal-body"></div>
  </div>

```

- [ ] **Step 2: Add CSS to styles.css**

Append to the end of `public/styles.css`:

```css
/* ── Sessions button ──────────────────────────────────────────────── */
#sessions-btn {
  position: fixed;
  top: 54px;
  right: 12px;
  z-index: 20;
  width: 34px; height: 34px;
  border-radius: 8px;
  background: #1a1a2e;
  border: 1px solid #3e4451;
  color: #888;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
#sessions-btn:hover { background: #282c34; color: #e5e5e5; border-color: #61afef; }

/* ── Sessions modal ───────────────────────────────────────────────── */
#sessions-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 50;
}
#sessions-backdrop.open { display: block; }

#sessions-modal {
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  z-index: 51;
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  background: #1a1a2e;
  border: 1px solid #3e4451;
  border-radius: 12px;
  overflow: hidden;
  flex-direction: column;
  display: none;
}
#sessions-modal.open { display: flex; }

#sessions-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #3e4451;
  flex-shrink: 0;
}
#sessions-modal-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  font-weight: 700;
  color: #e5e5e5;
}
#sessions-modal-close {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
}
#sessions-modal-close:hover { background: #282c34; color: #e5e5e5; }

#sessions-modal-body {
  overflow-y: auto;
  padding: 12px;
  flex: 1;
}
#sessions-modal-empty {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: #5c6370;
  text-align: center;
  padding: 24px 0;
}

/* ── Session group ────────────────────────────────────────────────── */
.sess-group { margin-bottom: 16px; }
.sess-group:last-child { margin-bottom: 0; }

.sess-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.sess-group-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  color: #61afef;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sess-kill-all {
  background: none;
  border: none;
  color: #cc4444;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.sess-kill-all:hover { background: #2a1414; }

/* ── Session row ──────────────────────────────────────────────────── */
.sess-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  margin-bottom: 4px;
  background: #0d0d1a;
  border: 1px solid #2a2d3a;
}
.sess-row:last-child { margin-bottom: 0; }

.sess-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: #e5e5e5;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sess-ghost-pill {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #888;
  background: #1e2030;
  border: 1px solid #3e4451;
  border-radius: 3px;
  padding: 1px 4px;
  flex-shrink: 0;
}
.sess-state {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  border-radius: 3px;
  padding: 2px 5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.sess-state.thinking { color: #e5c07b; background: #2a2010; }
.sess-state.editing  { color: #98c379; background: #102010; }
.sess-state.reading  { color: #61afef; background: #101828; }
.sess-state.running  { color: #c678dd; background: #1a1028; }
.sess-state.waiting  { color: #5c6370; background: #141414; }
.sess-state.input    { color: #e06c75; background: #201014; }
.sess-state.mcp      { color: #56b6c2; background: #101e20; }

.sess-dur {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #5c6370;
  white-space: nowrap;
  flex-shrink: 0;
}
.sess-kill {
  background: none;
  border: none;
  color: #5c6370;
  font-size: 13px;
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 4px;
  line-height: 1;
  flex-shrink: 0;
}
.sess-kill:hover { color: #e06c75; background: #201014; }
```

- [ ] **Step 3: Commit**

```bash
cd /home/abdul/observatory && git add public/index.html public/styles.css && git commit -m "feat(ui): add sessions panel button and modal markup/styles"
```

---

## Task 4: Sessions modal JS logic

**Files:**
- Modify: `public/game.js`

- [ ] **Step 1: Find the insertion point**

Run:

```bash
grep -n "search-btn.*addEventListener\|getElementById('search-btn')" /home/abdul/observatory/public/game.js
```

Note the line number — you will insert the sessions modal block immediately BEFORE that line.

- [ ] **Step 2: Add modal setup and renderSessionsModal before the search-btn click handler**

Insert this entire block immediately before the `search-btn` addEventListener line found in Step 1:

```js
  // ── Sessions modal ────────────────────────────────────────────────────────
  const sessionsBtn        = document.getElementById('sessions-btn');
  const sessionsModal      = document.getElementById('sessions-modal');
  const sessionsBackdrop   = document.getElementById('sessions-backdrop');
  const sessionsModalClose = document.getElementById('sessions-modal-close');
  const sessionsModalBody  = document.getElementById('sessions-modal-body');
  let sessionsModalOpen = false;

  function openSessionsModal()  {
    sessionsModalOpen = true;
    sessionsModal.classList.add('open');
    sessionsBackdrop.classList.add('open');
    renderSessionsModal();
  }
  function closeSessionsModal() {
    sessionsModalOpen = false;
    sessionsModal.classList.remove('open');
    sessionsBackdrop.classList.remove('open');
  }

  function formatDur(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function killSession(id) {
    await fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  function renderSessionsModal() {
    if (!sessionsModalOpen) return;
    const now = Date.now();

    const groups = new Map();
    for (const s of allSessions) {
      const key = s.cwd || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    if (groups.size === 0) {
      sessionsModalBody.textContent = '';
      const empty = document.createElement('div');
      empty.id = 'sessions-modal-empty';
      empty.textContent = 'No active sessions';
      sessionsModalBody.appendChild(empty);
      return;
    }

    let html = '';
    for (const [cwd, group] of groups) {
      group.sort((a, b) => {
        if (!!a.ghost !== !!b.ghost) return a.ghost ? 1 : -1;
        return (a.startedAt || 0) - (b.startedAt || 0);
      });
      const parts = cwd ? cwd.split('/').filter(Boolean) : [];
      const projectName = escHtml(parts.length ? parts[parts.length - 1] : '(unknown)');
      const safeIds = group.map(s => escHtml(s.id)).join(',');
      html += '<div class="sess-group">';
      html += '<div class="sess-group-header">';
      html += '<span class="sess-group-name" title="' + escHtml(cwd) + '">' + projectName + '</span>';
      html += '<button class="sess-kill-all" data-ids="' + safeIds + '">Kill all</button>';
      html += '</div>';
      for (const s of group) {
        const name = escHtml(s.name || s.source || s.id.slice(0, 8));
        const dur  = s.startedAt ? formatDur(now - s.startedAt) : '—';
        const st   = escHtml(s.state || 'waiting');
        const sid  = escHtml(s.id);
        html += '<div class="sess-row">';
        html += '<span class="sess-name">' + name + '</span>';
        if (s.ghost) html += '<span class="sess-ghost-pill">ghost</span>';
        html += '<span class="sess-state ' + st + '">' + st + '</span>';
        html += '<span class="sess-dur">' + dur + '</span>';
        html += '<button class="sess-kill" data-id="' + sid + '" title="Remove">&#x2715;</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    sessionsModalBody.innerHTML = html;

    sessionsModalBody.querySelectorAll('.sess-kill').forEach(function(btn) {
      btn.addEventListener('click', function() { killSession(btn.dataset.id); });
    });
    sessionsModalBody.querySelectorAll('.sess-kill-all').forEach(function(btn) {
      btn.addEventListener('click', function() {
        btn.dataset.ids.split(',').forEach(function(id) { killSession(id); });
      });
    });
  }

  sessionsBtn.addEventListener('click', function() {
    sessionsModalOpen ? closeSessionsModal() : openSessionsModal();
  });
  sessionsModalClose.addEventListener('click', closeSessionsModal);
  sessionsBackdrop.addEventListener('click', closeSessionsModal);

```

- [ ] **Step 3: Add renderSessionsModal call to the WebSocket message handler**

Find:

```js
          allSessions = msg.data || [];
          syncSessions(allSessions);
```

Change to:

```js
          allSessions = msg.data || [];
          syncSessions(allSessions);
          renderSessionsModal();
```

- [ ] **Step 4: Verify the changes look correct**

```bash
grep -n "renderSessionsModal\|sessionsModalOpen\|sessionsBtn\|formatDur\|escHtml" /home/abdul/observatory/public/game.js
```

Expected: each of `renderSessionsModal`, `sessionsModalOpen`, `sessionsBtn`, `formatDur`, `escHtml` appear multiple times.

- [ ] **Step 5: Commit**

```bash
cd /home/abdul/observatory && git add public/game.js && git commit -m "feat(ui): sessions modal — grouped view with per-session kill"
```

---

## Self-Review

**Spec coverage:**
- ✅ Loitering precision: Task 1 (`setTimeout` 60 100 ms)
- ✅ `DELETE /api/sessions/:id`: Task 2
- ✅ Sessions button below search: Task 3 HTML (`top: 54px`)
- ✅ Modal with backdrop + X close: Task 3 HTML/CSS
- ✅ Click-outside closes: Task 4 (`sessionsBackdrop.addEventListener('click', closeSessionsModal)`)
- ✅ Sessions grouped by CWD: Task 4 (`renderSessionsModal` groups by `s.cwd`)
- ✅ Non-ghost first within group: Task 4 (sort by `ghost` then `startedAt`)
- ✅ Name, ghost pill, state badge, duration per row: Task 4 row HTML
- ✅ Per-session kill + kill-all: Task 4 (`.sess-kill`, `.sess-kill-all`)
- ✅ Auto-refresh on WS update: Task 4 (`renderSessionsModal()` in WS handler)
- ✅ XSS safety: `escHtml()` sanitizes all session-derived strings before innerHTML

**Placeholder scan:** None found.

**Type consistency:** `allSessions` used in Task 4 is the same variable populated at line 188 of `game.js` and updated in `syncSessions`. `escHtml` defined and used consistently in Task 4.
