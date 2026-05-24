import type { SessionState, AgentSource } from "./types";
import { sessions, sessionLogs, terminals } from "./state";
import { broadcastSessions } from "./broadcast";
import { cleanupGhostTerminal } from "./terminals";

// If a session's state hasn't been updated by a hook in this long, assume the
// agent is idle and fall back to "waiting". This prevents characters from being
// stuck in "input" / "thinking" / etc. when a Stop hook is lost or never fires.
const STATE_STALE_MS = 2 * 60 * 1000; // 2 minutes

export function pruneStale() {
  const now = Date.now();
  const cutoff = now - 15 * 60 * 1000;
  let changed = false;
  for (const [id, session] of sessions) {
    if (terminals.has(id)) {
      const term = terminals.get(id)!;
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
