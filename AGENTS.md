# SideThing working rules

- Read README.md and docs/development.md before changing behavior.
- Keep the display dependency-free and the Mac helper native. Preserve Chromium 69 compatibility.
- Fix state at its existing source of truth. Prefer events and incremental updates over polling or duplicated caches.
- Keep secrets, device profiles, backups and built app bundles out of commits.
- Never weaken loopback/auth/origin checks or flash unsupported device layouts.
- Run npm run check and npm test. Inspect UI at 800×480 and narrow widths; verify hardware changes on the device.
- Distinguish simulated transport checks from physical checks in reports.
