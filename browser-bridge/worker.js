const allowed = new Set(["www.youtube.com", "x.com", "twitter.com"]);
let port,
  reconnect,
  delay = 1000;
const players = new Map();
function connect() {
  port = chrome.runtime.connectNative("local.carthing.video");
  port.onMessage.addListener((message) => {
    if (message.ready) {
      delay = 1000;
      players.forEach((value) => port.postMessage(value));
    }
    if (message.connected === false) {
      port.disconnect();
      return;
    }
    if (message.action && players.has(message.tabId))
      chrome.tabs.sendMessage(message.tabId, message).catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    clearTimeout(reconnect);
    reconnect = setTimeout(connect, delay);
    delay = Math.min(30000, delay * 2);
  });
}
connect();
chrome.runtime.onMessage.addListener((message, sender) => {
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    return;
  }
  if (
    !allowed.has(url.hostname) ||
    url.protocol !== "https:" ||
    !sender.tab ||
    sender.frameId !== 0
  )
    return;
  if (message.type === "ack") {
    if (
      typeof message.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(message.id) &&
      typeof message.ok === "boolean"
    )
      port?.postMessage({ type: "ack", id: message.id, ok: message.ok });
    return;
  }
  if (
    typeof message.title !== "string" ||
    !message.title.trim() ||
    message.title.length > 500 ||
    typeof message.creator !== "string" ||
    message.creator.length > 500
  )
    return;
  if (
    !Number.isFinite(message.duration) ||
    message.duration < 0 ||
    !Number.isFinite(message.elapsed) ||
    message.elapsed < 0
  )
    return;
  const value = {
    tabId: sender.tab.id,
    url: url.href.slice(0, 2048),
    title: message.title,
    creator: message.creator,
    duration: Math.min(message.duration, 864000),
    elapsed: Math.min(message.elapsed, 864000),
    playing: message.playing === true,
    ended: message.ended === true,
  };
  if (
    typeof message.thumbnail === "string" &&
    message.thumbnail.length < 150000 &&
    /^[A-Za-z0-9+/=]*$/.test(message.thumbnail)
  )
    value.thumbnail = message.thumbnail;
  if (value.ended) players.delete(sender.tab.id);
  else {
    players.set(sender.tab.id, value);
    if (players.size > 8) players.delete(players.keys().next().value);
  }
  port?.postMessage(value);
});

chrome.tabs.onRemoved.addListener((id) => {
  const value = players.get(id);
  if (value) {
    port?.postMessage({ ...value, ended: true, playing: false });
    players.delete(id);
  }
});
