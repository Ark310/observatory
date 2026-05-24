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
