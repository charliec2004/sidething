# Development

`public/` contains the display with no framework or build step. `native/` contains the Swift helper: local HTTP/SSE, media metadata, USB pairing, CoreAudio, current location and explicit release updates. `device/` contains guarded installation/recovery tools. Node and Python fixtures are development tools; the running Mac helper does not use Node.

## Keep it small

- Merge incremental media updates. Decode and resize artwork only when it changes.
- Reuse DOM nodes; update controls and forecasts only when their state changes.
- Run the one-second display timer only for a visible clock or playing timeline.
- Use CoreAudio callbacks for output/volume state; enumerate outputs when requested.
- Keep one ADB subscription and one display monitor. Cancel stale setup work and release owned forwards on disconnect or shutdown.
- Retry lost transport with bounded backoff. Preserve pairing and recover from a Chromium restart without user intervention.
- Keep the HTTP listener on loopback. Retain authentication, origin validation, request bounds and file permissions.

The main module is intentionally small and direct; avoid frameworks, polling loops and new services. Readable source is preferred over minifying the repository.

## Check

```sh
npm run check
npm test
```

Fixtures cover metadata deltas and deleted fields, adaptive controls, repeat/shuffle, ±10-second seeking, authentication/origins, closed SSE clients, ten helper restarts, twenty USB detach/attach cycles, fragmented ADB frames, CDP notifications, Chromium/tracker restarts and forwarding cleanup. USB fixtures use fake transports and never write to hardware. Physical boot, playback, volume, brightness and USB reconnects still need device checks for hardware changes.

Use the menu’s screen gallery to inspect normal, paused, shuffle/repeat, loading, disconnected and audio-output states at 800×480 and narrow widths. A source chooser changes the Mac’s system audio output; apps with their own AirPlay/output routing may keep that separate choice.

## Release

Update `VERSION`, pass checks and device verification, push a `vX.Y.Z` tag, and create a GitHub release for that tag. The update menu compares the latest release with the bundled version. Source updates require the official origin, a clean main checkout and a fast-forward merge; a failed build restores the previous app bundle. Runtime settings and private backups are never part of the update.

Development overrides: `PORT`, `CARTHING_DATA_DIR`, `CARTHING_MEDIA_BIN`, `CARTHING_RESOURCES`, `CARTHING_ADB_BIN`, `CARTHING_ADB_SERVER_PORT`. Do not use real credentials or device profiles in fixtures.
