import { test, expect, beforeEach } from "bun:test";
import { generateGhostName, GHOST_NAMES, sessions, wsClients } from "./state";
import { upsertSession } from "./sessions";

beforeEach(() => {
  sessions.clear();
  wsClients.clear();   // prevents broadcast errors
});

test("generateGhostName returns a non-empty string", () => {
  const name = generateGhostName();
  expect(typeof name).toBe("string");
  expect(name.length).toBeGreaterThan(0);
});

test("generateGhostName returns a value from GHOST_NAMES", () => {
  const name = generateGhostName();
  expect(GHOST_NAMES).toContain(name);
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
