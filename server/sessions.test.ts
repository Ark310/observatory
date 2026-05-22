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
