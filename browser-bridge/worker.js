const allowed = new Set(["www.youtube.com", "x.com", "twitter.com"]);
let port,
  activeTab,
  reconnect,
  latest,
  activePlaying = false,
  delay = 1000;
function connect() {
  port = chrome.runtime.connectNative("local.carthing.video");
  port.onMessage.addListener((message) => {
    if (message.ready && latest) {
      delay = 1000;
      port.postMessage(latest);
    }
    if (message.connected === false) {
      port.disconnect();
      return;
    }
    if (message.action && activeTab !== undefined)
      chrome.tabs.sendMessage(activeTab, message).catch(() => {});
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
  if (activePlaying && activeTab !== sender.tab.id && !message.playing) return;
  activeTab = sender.tab.id;
  activePlaying = message.playing === true;
  const value = {
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
  latest = value;
  port?.postMessage(value);
});

chrome.tabs.onRemoved.addListener((id) => {
  if (id === activeTab && latest) {
    port?.postMessage({ ...latest, ended: true, playing: false });
    latest = undefined;
    activeTab = undefined;
    activePlaying = false;
  }
});
