// Fake ADB/CDP transports exercise reconnects without touching USB or playback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sidething-usb-"));
const serial = "FAKE123456",
  trackers = new Set(),
  sockets = new Set();
let attached = false,
  currentURL = "file:///var/carthing/boot.html",
  commands = 0,
  child;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, label) {
  for (let n = 0; n < 150; n++) {
    if (await test()) return;
    await pause(40);
  }
  throw Error("Timed out: " + label);
}
function frame(value, opcode = 1) {
  const bytes = Buffer.from(value),
    header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
  header[0] = 128 | opcode;
  header[1] = bytes.length < 126 ? bytes.length : 126;
  if (bytes.length >= 126) header.writeUInt16BE(bytes.length, 2);
  return Buffer.concat([header, bytes]);
}
const cdp = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify([
      {
        type: "page",
        url: currentURL,
        webSocketDebuggerUrl: `ws://127.0.0.1:${cdp.address().port}/devtools/page/fixture`,
      },
    ]),
  );
});
cdp.on("upgrade", (request, socket) => {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      crypto
        .createHash("sha1")
        .update(
          request.headers["sec-websocket-key"] +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64") +
      "\r\n\r\n",
  );
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15,
        masked = !!(buffer[1] & 128);
      let size = buffer[1] & 127,
        offset = 2;
      if (size === 126) {
        if (buffer.length < 4) return;
        size = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (size === 127) throw Error("Unexpected large fixture frame");
      const key = masked ? buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buffer.length < offset + size) return;
      const body = Buffer.from(buffer.subarray(offset, offset + size));
      buffer = buffer.subarray(offset + size);
      if (key) for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
      if (opcode === 8) {
        socket.end(frame("", 8));
        return;
      }
      if (opcode !== 1) continue;
      const message = JSON.parse(body);
      commands++;
      if (message.method === "Page.navigate") {
        const url = new URL(message.params.url);
        url.hash = "";
        currentURL = url.href;
      }
      // Notifications may arrive before a response; they must not break pairing.
      socket.write(
        frame(
          JSON.stringify({ method: "Runtime.consoleAPICalled", params: {} }),
        ),
      );
      socket.write(
        frame(
          JSON.stringify({
            id: message.id,
            result:
              message.method === "Runtime.evaluate"
                ? { result: { type: "boolean", value: true } }
                : { frameId: "fixture" },
          }),
        ),
      );
    }
  });
});
await new Promise((r) => cdp.listen(0, "127.0.0.1", r));
function report() {
  const body = Buffer.from(attached ? serial + "\tdevice\n" : ""),
    message = Buffer.concat([
      Buffer.from(body.length.toString(16).padStart(4, "0")),
      body,
    ]);
  for (const tracker of trackers) {
    tracker.write(message.subarray(0, 2));
    tracker.write(message.subarray(2));
  }
}
const adb = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("close", () => trackers.delete(socket));
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length >= 4 + parseInt(buffer.subarray(0, 4).toString(), 16)) {
      socket.removeAllListeners("data");
      socket.write("OKAY");
      trackers.add(socket);
      report();
    }
  });
});
await new Promise((r) => adb.listen(0, "127.0.0.1", r));
const log = path.join(scratch, "commands.jsonl"),
  fakeADB = path.join(scratch, "adb"),
  provider = path.join(scratch, "media");
fs.writeFileSync(
  fakeADB,
  `#!/usr/bin/env node\nconst fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args.includes('forward')&&args.includes('tcp:0'))console.log(${cdp.address().port});`,
);
fs.chmodSync(fakeADB, 0o700);
fs.writeFileSync(
  provider,
  `#!/usr/bin/env node\nconsole.log(JSON.stringify({payload:{title:'USB fixture',playing:false},diff:false}));setInterval(()=>{},1000);`,
);
fs.chmodSync(provider, 0o700);
fs.writeFileSync(
  path.join(scratch, "device.json"),
  JSON.stringify({ serial, brightness: 92 }),
);
const env = {
  ...process.env,
  PORT: "4321",
  CARTHING_DATA_DIR: scratch,
  CARTHING_MEDIA_BIN: provider,
  CARTHING_ADB_BIN: fakeADB,
  CARTHING_ADB_SERVER_PORT: String(adb.address().port),
};
const calls = () =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const allocations = () =>
  calls().filter((args) => args.includes("tcp:0")).length;
const removals = () =>
  calls().filter((args) => args.includes("--remove")).length;
let token;
async function connected() {
  return (
    await (
      await fetch("http://127.0.0.1:4321/api/state", {
        headers: { Authorization: "Bearer " + token },
      })
    ).json()
  ).hardware.connected;
}
try {
  child = spawn(
    path.join(root, "CarThing.app/Contents/MacOS/CarThing"),
    ["--headless"],
    { env, stdio: "ignore" },
  );
  await until(() => {
    try {
      token = JSON.parse(
        fs.readFileSync(path.join(scratch, "session.json")),
      ).token;
      return trackers.size > 0;
    } catch {
      return false;
    }
  }, "USB subscription");
  for (let i = 0; i < 20; i++) {
    const before = commands;
    attached = true;
    report();
    await until(() => commands > before, "pair/reconnect");
    assert.equal(await connected(), true);
    attached = false;
    report();
    await until(async () => !(await connected()), "disconnect state");
    await until(() => removals() === allocations(), "owned forwards released");
  }
  attached = true;
  report();
  await until(() => sockets.size > 0, "display monitor");
  const before = commands;
  for (const socket of sockets) socket.destroy();
  currentURL = "file:///var/carthing/boot.html";
  await until(() => commands > before, "Chromium restart recovery");
  for (const tracker of trackers) tracker.destroy();
  await until(() => trackers.size === 0, "tracker disconnected");
  await until(() => trackers.size > 0, "ADB tracker restart recovery");
  await until(() => sockets.size > 0, "pair after tracker restart");
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await done;
  assert.equal(
    removals(),
    allocations(),
    "shutdown released every owned forward",
  );
  console.log(
    "PASS: 20 USB detach/attach cycles; split ADB frames; noisy CDP replies; Chromium restart; ADB tracker restart; owned forwarding cleanup. Fake transport only.",
  );
} finally {
  if (child && child.exitCode === null) {
    const done = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await done;
  }
  for (const socket of [...trackers, ...sockets]) socket.destroy();
  await new Promise((r) => adb.close(r));
  await new Promise((r) => cdp.close(r));
  fs.rmSync(scratch, { recursive: true, force: true });
}
