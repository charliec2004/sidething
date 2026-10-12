let video,
  lastTime = 0,
  last = "",
  thumbnail = "",
  thumbnailKey = "";
const observed = new WeakSet(),
  handled = new Map();
const isYouTube = location.hostname === "www.youtube.com";
const clean = (v) =>
  String(v || "")
    .trim()
    .slice(0, 500);
function active() {
  return (
    [...document.querySelectorAll("video")].find(
      (v) => !v.paused && !v.ended,
    ) ||
    video ||
    document.querySelector("video")
  );
}
function capture() {
  if (!video) return;
  const key = video.currentSrc + "|" + video.poster;
  if (key === thumbnailKey) return;
  thumbnail = "";
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  thumbnailKey = key;
  try {
    const c = document.createElement("canvas"),
      scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.max(1, Math.round(video.videoWidth * scale));
    c.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = c.getContext("2d");
    ctx.drawImage(video, 0, 0, c.width, c.height);
    thumbnail = c.toDataURL("image/jpeg", 0.65).split(",")[1];
  } catch {}
}
function emit(force = false) {
  video = active();
  if (!video) return;
  const article = video.closest("article");
  const metadata = navigator.mediaSession?.metadata;
  const title = clean(
    isYouTube
      ? document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
          ?.textContent ||
          metadata?.title ||
          document.title.replace(/ - YouTube$/, "")
      : article?.querySelector('[data-testid="tweetText"]')?.textContent ||
          metadata?.title ||
          document.title,
  );
  const creator = clean(
    isYouTube
      ? document.querySelector("#owner #channel-name a")?.textContent ||
          metadata?.artist
      : article?.querySelector('[data-testid="User-Name"]')?.textContent ||
          metadata?.artist,
  );
  const value = {
    title,
    creator,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    elapsed: video.currentTime || 0,
    playing: !video.paused && !video.ended,
    ended: video.ended,
  };
  const key = JSON.stringify({ ...value, elapsed: 0 });
  if (!force && key === last && Date.now() - lastTime < 30000) return;
  capture();
  if (thumbnail) value.thumbnail = thumbnail;
  last = key;
  lastTime = Date.now();
  chrome.runtime.sendMessage(value).catch(() => {});
}
function scan() {
  for (const v of document.querySelectorAll("video")) {
    if (observed.has(v)) continue;
    observed.add(v);
    for (const e of [
      "play",
      "pause",
      "ended",
      "seeked",
      "loadedmetadata",
      "durationchange",
    ])
      v.addEventListener(e, () => {
        video = v;
        emit(true);
      });
    v.addEventListener("timeupdate", () => {
      if (v === active()) emit();
    });
  }
  emit();
}
let scanTimer;
const observer = new MutationObserver(() => {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 200);
});
observer.observe(document.body, { childList: true, subtree: true });
scan();
chrome.runtime.onMessage.addListener(async (message) => {
  if (
    !message.id ||
    !["toggle-play-pause", "seek-back", "seek-forward", "seek"].includes(message.action)
  )
    return;
  if (handled.has(message.id)) {
    chrome.runtime.sendMessage({
      type: "ack",
      id: message.id,
      ok: handled.get(message.id),
    });
    return;
  }
  let ok = false;
  try {
    video = active();
    if (!video) throw Error();
    if (message.action === "toggle-play-pause") {
      if (video.paused) await video.play();
      else video.pause();
    } else
      video.currentTime = Math.max(
        0,
        Math.min(
          video.duration || Infinity,
          (message.action === "seek" && Number.isFinite(message.seconds) ? message.seconds : video.currentTime + (message.action === "seek-back" ? -10 : 10)),
        ),
      );
    ok = true;
    emit(true);
  } catch {}
  handled.set(message.id, ok);
  if (handled.size > 32) handled.delete(handled.keys().next().value);
  chrome.runtime
    .sendMessage({ type: "ack", id: message.id, ok })
    .catch(() => {});
});
