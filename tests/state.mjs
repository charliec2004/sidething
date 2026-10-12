import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "sidething-state-"));
try {
  const binary = join(dir, "checks");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "native/Countdown.swift",
      "native/Players.swift",
      "tests/state.swift",
      "-o",
      binary,
    ],
    { stdio: "inherit" },
  );
  execFileSync(binary, [], { stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
