import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "carthing-test-"));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "fixture.json"),
  provider = path.join(dir, "provider.mjs");
const initial = {
  title: "Fixture music",
  artist: "Fixture artist",
  bundleIdentifier: "com.fixture",
  mediaType: 1,
  playing: false,
  repeatMode: 1,
  shuffleMode: 1,
  durationMicros: 100000000,
  elapsedTimeMicros: 50000000,
  playbackRate: 1,
  timestampEpochMicros: Date.now() * 1000,
};
fs.writeFileSync(file, JSON.stringify(initial));
fs.writeFileSync(
  provider,
  `#!/usr/bin/env node
import fs from 'node:fs';
const file=${JSON.stringify(file)}, args=process.argv.slice(2);
const read=()=>JSON.parse(fs.readFileSync(file));
if(args[0]==='stream') {let previous;const emit=()=>{const current=read(),diff=!!previous,payload=diff?Object.fromEntries([...new Set([...Object.keys(previous),...Object.keys(current)])].filter(k=>JSON.stringify(previous[k])!==JSON.stringify(current[k])).map(k=>[k,current[k]??null])):current;console.log(JSON.stringify({payload,diff}));previous=current;};emit();fs.watchFile(file,{interval:25},emit);}
else {const m=read();if(args[0]==='repeat'||args[0]==='shuffle')m[args[0]+'Mode']=Number(args[1]);if(args[0]==='toggle-play-pause')m.playing=!m.playing;if(args[0]==='previous-track'||args[0]==='next-track')m.title=args[0];if(args[0]==='seek')m.elapsedTimeMicros=Number(args[1])*1000000;m.timestampEpochMicros=Date.now()*1000;fs.writeFileSync(file,JSON.stringify(m));}
`,
);
const musicFile = path.join(dir, "music.json");
fs.writeFileSync(
  musicFile,
  JSON.stringify({
    title: "Music fixture",
    artist: "Music artist",
    artworkData:
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAADhlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAAXnVPIAAABlklEQVQ4EZ1TSy8DURT+5k4tZKpBTEu3VjQeayvSFhGPxMKK8E8kIhKxEMEv8AukTWhVYiVYYKPViFc0GlX0JbNgpuaMznRuIlHu4p7H/b7vnrlzjoDKcrlczWWxvk9kQouZ+8mqWjkrqMphoVB4pXOBtoYmz6jI2JYeNVL86yojp2raTPHtKSzQzaxOuq6ZbKrrItrHezujsv9MJhG9WuI67N88GPSjt6cbmcyzeQ9nRVHERTyBo+MTI09chx0xPBjE6toGGDOexn5k+KqqYXN9FROTU9YZJxBPXOIhlYJbllEslaAoigFs9XiwuDCPnUgU26GwRSaHcVEl6Ory4SC2C6qIltfbhsd0Gm63XEFUDVdBNQ1ITgmy/N0Sp2fnyOXzuLu7x9zstB2GHwWSySv0+4eQzb5Y4JubW8u3O5zA+OgIonv7xiM6HRKckmTHQtPK8HV2cDlOYGl5BYHAANRPlQOZAb1BJBozQ8MKRhuLLMRlawz03zrGaDCgt2WNnCpM5xCX0VTRYPxJpDJMxLVa7r/j/AW5sZUWznyOgQAAAABJRU5ErkJggg==",
    playing: true,
    elapsed: 10,
    duration: 180,
    shuffleMode: 1,
    repeatMode: 1,
  }),
);
let providerSource = fs.readFileSync(provider, "utf8");
providerSource = providerSource.replace(
  "if(args[0]==='stream')",
  `if(args[0]==='--music-control') {const f=${JSON.stringify(musicFile)},m=JSON.parse(fs.readFileSync(f));if(args[1]==='repeat'||args[1]==='shuffle')m[args[1]+'Mode']=Number(args[2]);if(args[1]==='toggle-play-pause')m.playing=!m.playing;if(args[1]==='seek')m.elapsed=Number(args[2]);m.timestamp=Date.now();if(args[1]==='get')await new Promise(r=>setTimeout(r,200));else fs.writeFileSync(f,JSON.stringify(m));console.log(JSON.stringify(m));process.exit(0);}
if(args[0]==='stream')`,
);
fs.writeFileSync(provider, providerSource);
fs.chmodSync(provider, 0o700);
const env = {
  ...process.env,
  PORT: "4320",
  CARTHING_MEDIA_BIN: provider,
  CARTHING_MUSIC_BIN: provider,
  CARTHING_DATA_DIR: dir,
};
const binary = path.join(root, "CarThing.app/Contents/MacOS/CarThing");
let child, host, session, headers;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await pause(50);
  }
  throw Error("Timed out: " + label);
}
const base = "http://127.0.0.1:4320";
async function state() {
  return (await fetch(base + "/api/state", { headers })).json();
}
async function post(route, value, extra = {}) {
  return fetch(base + route, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", ...extra },
    body: JSON.stringify(value),
  });
}
async function start() {
  child = spawn(binary, ["--headless"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (d) => (errors += d));
  await until(async () => {
    session = JSON.parse(fs.readFileSync(path.join(dir, "session.json")));
    headers = { Authorization: "Bearer " + session.token };
    return (await state()).media.status === "ready";
  }, "native service ready");
  assert.equal(errors, "");
}
async function stop(p) {
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await done;
}
try {
  await start();
  assert.equal((await fetch(base + "/api/state")).status, 401);
  const partial = { ...initial, artist: "Changed creator" };
  fs.writeFileSync(file, JSON.stringify(partial));
  await until(
    async () => (await state()).media.artist === "Changed creator",
    "partial metadata update",
  );
  assert.equal(
    (await state()).media.title,
    initial.title,
    "unchanged fields survive partial updates",
  );
  delete partial.artist;
  fs.writeFileSync(file, JSON.stringify(partial));
  await until(
    async () => (await state()).media.artist === "",
    "removed metadata clears the display",
  );
  assert.equal(
    (await fetch(base + "/")).headers.get("referrer-policy"),
    "same-origin",
  );
  assert.equal(
    (await post("/api/control", { action: "repeat" }, { Origin: "null" }))
      .status,
    403,
  );
  assert.equal(
    (
      await post(
        "/api/control",
        { action: "repeat" },
        { Origin: "https://example.com" },
      )
    ).status,
    403,
  );
  assert.equal((await post("/api/control", { action: "unknown" })).status, 400);
  assert.equal((await fetch(base + "/api/outputs")).status, 401);
  const inventory = await (
    await fetch(base + "/api/outputs", { headers })
  ).json();
  assert.ok(
    inventory.outputs.every(
      (o) => Number.isInteger(o.id) && typeof o.name === "string",
    ),
  );
  assert.equal(
    (await post("/api/hardware", { action: "output", id: 0 })).status,
    409,
  );
  assert.equal(
    (await post("/api/hardware", { action: "output", id: true })).status,
    409,
  );
  assert.equal(
    (
      await post("/api/settings", {
        unit: "fahrenheit",
        location: { name: "Bad", latitude: 91, longitude: 0 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post("/api/settings", {
        unit: "fahrenheit",
        location: { name: "Manual city", latitude: 37, longitude: -122 },
      })
    ).status,
    400,
    "current location cannot be overridden by manual coordinates",
  );
  assert.equal(
    (await post("/api/settings", { unit: "celsius", location: null })).status,
    200,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, "settings.json"))),
    { unit: "celsius" },
    "location is not persisted",
  );
  for (let i = 0; i < 20; i++) {
    const abort = new AbortController();
    const response = await fetch(base + "/api/events", {
      headers,
      signal: abort.signal,
    });
    assert.equal(response.status, 200, "closed SSE tabs released");
    const reader = response.body.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    await pause(25);
  }
  for (const [action, field, expected] of [
    ["repeat", "repeatMode", 3],
    ["repeat", "repeatMode", 2],
    ["repeat", "repeatMode", 1],
    ["shuffle", "shuffleMode", 3],
    ["shuffle", "shuffleMode", 1],
    ["toggle-play-pause", "playing", true],
    ["toggle-play-pause", "playing", false],
    ["previous-track", "title", "previous-track"],
    ["next-track", "title", "next-track"],
  ]) {
    assert.equal((await post("/api/control", { action })).status, 200, action);
    await until(
      async () => (await state()).media[field] === expected,
      action + " streamed confirmation",
    );
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ ...initial, title: "Fixture video", mediaType: 2 }),
  );
  await until(
    async () => (await state()).media.kind === "video",
    "video normalization",
  );
  assert.deepEqual((await state()).media.capabilities, {
    seek: true,
    skip: false,
    shuffle: false,
    repeat: false,
  });
  assert.equal((await post("/api/control", { action: "shuffle" })).status, 409);
  assert.equal(
    (await post("/api/control", { action: "seek-back" })).status,
    200,
  );
  await until(
    async () => (await state()).media.elapsed === 40,
    "rewind exactly 10 seconds",
  );
  assert.equal(
    (await post("/api/control", { action: "seek-forward" })).status,
    200,
  );
  await until(
    async () => (await state()).media.elapsed === 50,
    "forward exactly 10 seconds",
  );
  assert.equal(
    (await post("/api/control", { action: "seek", seconds: true })).status,
    400,
  );
  assert.equal(
    (await post("/api/control", { action: "seek", seconds: 101 })).status,
    400,
  );
  assert.equal(
    (await post("/api/control", { action: "seek", seconds: 12.5 })).status,
    200,
  );
  await until(
    async () => (await state()).media.elapsed === 12.5,
    "absolute seeking",
  );
  assert.equal(
    (await post("/api/timer", { action: "set", minutes: true })).status,
    400,
  );
  assert.equal(
    (await post("/api/timer", { action: "adjust", minutes: 1.5 })).status,
    400,
  );
  assert.equal(
    (await post("/api/timer", { action: "set", minutes: 15 })).status,
    200,
  );
  assert.equal((await state()).timer.remaining, 900);
  await post("/api/timer", { action: "toggle" });
  await pause(100);
  await post("/api/timer", { action: "toggle" });
  assert.equal((await state()).timer.phase, "paused");
  const saved = session.token;
  for (let i = 0; i < 10; i++) {
    await stop(child);
    await start();
    assert.equal(
      (await state()).timer.phase,
      "paused",
      "timer survives restart",
    );
    assert.equal(session.token, saved, "pairing survives repeated restart");
  }
  const extension = fs
    .readFileSync(path.join(root, "browser-bridge/extension-id.txt"), "utf8")
    .trim();
  host = spawn(binary, ["chrome-extension://" + extension + "/"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let frames = Buffer.alloc(0);
  host.stdout.on("data", (d) => {
    frames = Buffer.concat([frames, d]);
    while (frames.length >= 4) {
      const n = frames.readUInt32LE();
      if (frames.length < n + 4) break;
      messages.push(JSON.parse(frames.subarray(4, n + 4)));
      frames = frames.subarray(n + 4);
    }
  });
  const send = (value) => {
    const body = Buffer.from(JSON.stringify(value)),
      size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    host.stdin.write(Buffer.concat([size, body]));
  };
  await until(
    () => messages.some((m) => m.ready),
    "native messaging handshake",
  );
  fs.writeFileSync(file, "{}");
  await until(
    async () => (await state()).media.status === "empty",
    "native metadata absent",
  );
  send({
    url: "https://x.com/fixture/status/1",
    title: "Fixture X video",
    creator: "@fixture",
    playing: false,
    duration: 120,
    elapsed: 30,
  });
  await until(
    async () => (await state()).media.source === "browser-bridge",
    "X bridge metadata",
  );
  assert.equal((await state()).media.artist, "@fixture");
  send({
    tabId: 2,
    url: "https://www.youtube.com/watch?v=fixture",
    title: "Other video",
    creator: "Creator",
    playing: true,
    duration: 100,
    elapsed: 1,
  });
  await until(
    async () => (await state()).media.title === "Other video",
    "latest started player",
  );
  assert.equal((await state()).media.sourceCount, 2);
  const selected = (await state()).media.sourceId;
  await post("/api/source", { action: "cycle" });
  assert.equal((await state()).media.title, "Fixture X video");
  assert.equal(
    (
      await post("/api/control", {
        action: "toggle-play-pause",
        sourceId: selected,
      })
    ).status,
    409,
  );

  const pending = post("/api/control", { action: "seek-forward" });
  await until(
    () => messages.some((m) => m.action === "seek-forward"),
    "browser command",
  );
  const command = messages.find((m) => m.action === "seek-forward");
  assert.equal(command.seconds, 10);
  send({ type: "ack", id: command.id, ok: true });
  assert.equal((await pending).status, 200);
  assert.equal(
    messages.filter((m) => m.id === command.id).length,
    1,
    "command sent once",
  );
  assert.equal(
    (
      await post("/api/browser", {
        url: "https://evil.example/video",
        title: "Untrusted",
      })
    ).status,
    400,
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...initial,
      title: "Music fixture",
      artist: "Music artist",
      artworkData: fs
        .readFileSync(path.join(root, "assets/logo.png"))
        .toString("base64"),
      bundleIdentifier: "com.apple.Music",
      shuffleMode: null,
      repeatMode: null,
      playing: true,
    }),
  );
  await until(
    async () =>
      (await state()).media.source === "com.apple.Music" &&
      (await state()).media.capabilities.shuffle,
    "direct Music modes",
  );
  const musicArtworkVersion = (await state()).media.artworkVersion;
  assert.ok(musicArtworkVersion, "native Music artwork is present");
  assert.equal((await state()).media.sourceCount, 3);
  assert.equal(
    (
      await post("/api/control", {
        action: "shuffle",
        sourceId: "com.apple.Music",
      })
    ).status,
    200,
  );
  assert.equal(JSON.parse(fs.readFileSync(musicFile)).shuffleMode, 3);
  await post("/api/source", { action: "cycle" });
  assert.equal((await state()).media.title, "Other video");
  send({
    tabId: 2,
    url: "https://www.youtube.com/watch?v=fixture",
    title: "Other video",
    creator: "Creator",
    playing: true,
    duration: 100,
    elapsed: 4,
  });
  await pause(100);
  assert.equal((await state()).media.title, "Other video");
  await post("/api/source", { action: "cycle" });
  await post("/api/source", { action: "cycle" });
  assert.equal((await state()).media.source, "com.apple.Music");
  assert.equal(
    (
      await post("/api/control", {
        action: "toggle-play-pause",
        sourceId: "com.apple.Music",
      })
    ).status,
    200,
  );
  assert.equal(
    (await state()).media.artworkVersion,
    musicArtworkVersion,
    "play/pause retains the same cover instead of replacing it with scripting artwork",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(musicFile)).playing,
    false,
    "viewed Music controls go to Music behind video",
  );
  assert.equal(
    (
      await post("/api/control", {
        action: "seek",
        seconds: 15,
        sourceId: "com.apple.Music",
      })
    ).status,
    200,
  );
  assert.equal(JSON.parse(fs.readFileSync(musicFile)).elapsed, 15);
  await pause(450);
  assert.equal(
    (await state()).media.elapsed,
    15,
    "Old Music reads cannot revert a seek",
  );
  console.log(
    "PASS: incremental metadata and deleted fields; native playback dispatch and streamed state; repeat off/all/one; shuffle; music/video capabilities; seeking exactly ±10 seconds; authentication/origin/input validation; 20 closed SSE clients released; saved pairing after 10 restarts; browser native-messaging metadata, commands and acknowledgement. Fixture provider only; real media unchanged.",
  );
} finally {
  if (host) {
    host.stdin.end();
    await stop(host);
  }
  await stop(child);
  fs.rmSync(dir, { recursive: true, force: true });
}
