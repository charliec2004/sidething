const elements = {};
document.querySelectorAll("[id]").forEach((el) => (elements[el.id] = el));
const $ = (id) => elements[id];
const controls = [...document.querySelectorAll("[data-action]")];
const mediaLayout = document.querySelector(".media-layout");
const setText = (el, value) => {
  if (el.textContent !== value) el.textContent = value;
};
const demo = new URLSearchParams(location.search).get("demo");
const views = ["media", "clock", "weather", "settings"];
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
let playIntent = null,
  playDeadline = 0,
  metadataTimer;
let streamController,
  reconnectWake,
  reconnectNow = false;
let view = 0,
  state,
  pending = "",
  connected = false,
  artVersion = "",
  artURL = "",
  imageRevision = 0,
  reconnectDelay = 500;
if (location.hash.length > 1) {
  sessionStorage.setItem("sidecarToken", location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
}
const token = () => sessionStorage.getItem("sidecarToken") || "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function selectView(index) {
  closeOutputs();
  if (index === view) return;
  const previous = $(views[view]);
  previous.classList.remove("current");
  previous.classList.add("leaving");
  previous.inert = true;
  view = index;
  const current = $(views[view]);
  current.classList.remove("leaving");
  current.inert = false;
  current.classList.add("current");
  setTimeout(() => {
    if (!previous.classList.contains("current"))
      previous.classList.remove("leaving");
  }, 230);
  tick();
  scheduleTick();
}
function nextView() {
  selectView((view + 1) % views.length);
}
window.addEventListener("carthing:view-next", nextView);
window.addEventListener("pointerdown", () =>
  document.body.classList.remove("keyboard-input"),
);
window.addEventListener(
  "touchstart",
  () => document.body.classList.remove("keyboard-input"),
  { passive: true },
);
window.addEventListener("keydown", (e) => {
  if (e.key === "Tab") document.body.classList.add("keyboard-input");
  if (e.repeat) return;
  if (e.key === "F13" || e.key === "Escape") {
    e.preventDefault();
    nextView();
  }
  if (/^[1-4]$/.test(e.key)) {
    e.preventDefault();
    selectView(Number(e.key) - 1);
  }
  if (e.key === "m" || e.key === "M" || e.key === "Power") {
    e.preventDefault();
    queueHardware({
      action: "display",
      on:
        powerIntent === null
          ? !((state && state.hardware && state.hardware.displayOn) !== false)
          : !powerIntent,
    });
  }
  if (e.key === "Enter") {
    e.preventDefault();
    $("play").click();
  }
});
async function fetchTimed(path, options, timeout) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(
      path,
      Object.assign({}, options, { signal: controller.signal }),
    );
  } finally {
    clearTimeout(timer);
  }
}
async function api(path, body) {
  const response = await fetchTimed(
    path,
    {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    8000,
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Operation failed");
  return value;
}
function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
  setTimeout(() => {
    if ($("notice").textContent === message) $("notice").hidden = true;
  }, 5000);
}
let previousControls = "";
function updateControls() {
  const m = (state && state.media) || {},
    step = m.seekStep || 10,
    capabilities = m.capabilities || {},
    video = m.kind === "video";
  const playing = playIntent === null ? !!m.playing : playIntent;
  const key = [
    connected,
    m.status,
    video,
    step,
    capabilities.shuffle,
    capabilities.repeat,
    capabilities.seek,
    capabilities.skip,
    playing,
    m.shuffleMode,
    m.repeatMode,
    pending,
  ].join("|");
  if (key === previousControls) return;
  previousControls = key;
  $("shuffle").hidden = video || !capabilities.shuffle;
  $("repeat").hidden = video || !capabilities.repeat;
  $("back").hidden = $("forward").hidden = !(video
    ? capabilities.seek
    : capabilities.skip);
  $("back").dataset.action = video ? "seek-back" : "previous-track";
  $("forward").dataset.action = video ? "seek-forward" : "next-track";
  $("back").setAttribute(
    "aria-label",
    video ? `Rewind ${step} seconds` : "Previous track",
  );
  $("forward").setAttribute(
    "aria-label",
    video ? `Forward ${step} seconds` : "Next track",
  );
  $("backicon").setAttribute("href", video ? "#seek-back-icon" : "#back-icon");
  $("forwardicon").setAttribute(
    "href",
    video ? "#seek-forward-icon" : "#forward-icon",
  );
  $("back").classList.toggle("seeking", video);
  $("forward").classList.toggle("seeking", video);
  $("play").classList.toggle("is-playing", playing);
  $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("shuffle").setAttribute(
    "aria-pressed",
    String([2, 3].includes(m.shuffleMode)),
  );
  $("repeat").setAttribute(
    "aria-pressed",
    String([2, 3].includes(m.repeatMode)),
  );
  $("repeatone").hidden = m.repeatMode !== 2;
  $("repeat").setAttribute(
    "aria-label",
    m.repeatMode === 2
      ? "Repeat one"
      : m.repeatMode === 3
        ? "Repeat all"
        : "Repeat off",
  );
  controls.forEach((el) => {
    el.disabled = !connected || m.status !== "ready";
    el.setAttribute("aria-busy", String(pending === el.id));
  });
}
async function updateArtwork(m) {
  const version = m.artworkVersion || m.artwork || "";
  if (version === artVersion) return;
  artVersion = version;
  const revision = ++imageRevision;
  if (!version) {
    if (artURL.startsWith("blob:")) URL.revokeObjectURL(artURL);
    artURL = "";
    $("artwork").classList.remove("switching");
    $("art").hidden = true;
    $("placeholder").hidden = false;
    return;
  }
  let url = m.artwork;
  try {
    if (!demo) {
      const response = await fetchTimed(
        `/api/artwork?v=${encodeURIComponent(version)}`,
        { headers: { Authorization: `Bearer ${token()}` } },
        5000,
      );
      if (!response.ok) throw Error();
      url = URL.createObjectURL(await response.blob());
    }
    const image = new Image();
    image.src = url;
    await image.decode();
    if (revision !== imageRevision) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      return;
    }
    $("artwork").classList.add("switching");
    await sleep(130);
    if (revision !== imageRevision) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      return;
    }
    const old = artURL;
    artURL = url;
    $("art").src = url;
    $("art").hidden = false;
    $("placeholder").toggleAttribute("hidden", true);
    $("artwork").classList.remove("switching");
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
  } catch {
    if (url && url.startsWith("blob:") && url !== artURL)
      URL.revokeObjectURL(url);
    if (revision === imageRevision) {
      artVersion = "";
      $("artwork").classList.remove("switching");
    }
  }
}
function render(value) {
  const oldMedia = state && state.media;
  state = value;
  if (
    playIntent !== null &&
    (state.media.playing === playIntent || Date.now() > playDeadline)
  )
    playIntent = null;
  const m = state.media,
    showMedia = !!m.title;
  mediaLayout.hidden = !showMedia;
  $("idle").hidden = showMedia;
  const idleText =
    m.status === "empty"
      ? "Nothing playing"
      : m.status === "unavailable"
        ? "Playback unavailable"
        : "Connecting";
  setText($("idletext"), idleText);
  $("idle").classList.toggle(
    "reconnecting",
    m.status === "loading" || m.status === "unavailable",
  );
  $("display").classList.toggle(
    "disconnected",
    !connected || m.status === "unavailable",
  );
  $("artwork").classList.toggle("video", m.kind === "video");
  if (showMedia) {
    if (oldMedia && oldMedia.title !== m.title && oldMedia.title) {
      clearTimeout(metadataTimer);
      $("metadata").classList.add("switching");
      metadataTimer = setTimeout(() => {
        $("title").textContent = state.media.title;
        $("creator").textContent = state.media.artist || "";
        $("metadata").classList.remove("switching");
        metadataTimer = null;
      }, 130);
    } else if (!metadataTimer) {
      setText($("title"), m.title);
      setText($("creator"), m.artist || "");
    }
    $("creator").hidden = !m.artist;
    void updateArtwork(m);
  }
  $("timeline").hidden = !m.duration;
  updateControls();
  renderWeather();
  renderHardware();
  tick();
  scheduleTick();
}
let previousWeather = "";
function renderWeather() {
  const w = state.weather || {},
    current = w.current,
    l = state.config && state.config.location;
  const signature = JSON.stringify([w, l]);
  if (signature === previousWeather) return;
  previousWeather = signature;
  $("weather-setup").hidden = !!l;
  $("weather-layout").hidden = !l;
  const locating = w.status === "locating" || w.status === "loading";
  $("choose-location").hidden = locating;
  $("choose-location").textContent =
    w.status === "location-denied"
      ? "Enable location"
      : w.status === "location-unavailable"
        ? "Retry location"
        : "Allow location";
  $("location-state").hidden = !locating;
  $("location-state").textContent = "Locating…";
  $("place").textContent = (l && l.name) || "";
  $("temperature").textContent = current
    ? Math.round(current.temperature_2m)
    : "—";
  const code = current && current.weather_code;
  $("condition").textContent =
    code === undefined
      ? ""
      : code === 0
        ? "Clear"
        : code <= 3
          ? "Partly cloudy"
          : code <= 48
            ? "Fog"
            : code <= 67
              ? "Rain"
              : code <= 77
                ? "Snow"
                : code <= 82
                  ? "Showers"
                  : code <= 86
                    ? "Snow showers"
                    : "Thunderstorms";
  const glyph =
    code === 0
      ? "sun"
      : code <= 3
        ? "cloud"
        : code <= 48
          ? "fog"
          : code <= 67
            ? "rain"
            : code <= 77
              ? "snow"
              : code <= 82
                ? "rain"
                : code <= 86
                  ? "snow"
                  : "storm";
  $("weather-glyph").setAttribute("href", "#weather-" + glyph);
  $("weathericon").hidden = !current;
  $("range").textContent = w.daily
    ? `H ${Math.round(w.daily.temperature_2m_max[0])}°   L ${Math.round(w.daily.temperature_2m_min[0])}°`
    : "";
  $("weatherstate").textContent =
    w.status === "unconfigured"
      ? ""
      : w.status === "loading"
        ? "Loading weather"
        : w.status === "unavailable"
          ? "Weather unavailable"
          : w.status === "stale"
            ? "Last forecast · offline"
            : "";
  $("forecast").textContent = "";
  if (w.daily)
    w.daily.time.slice(1, 6).forEach((date, i) => {
      const row = document.createElement("div");
      row.className = "forecast-row";
      const day = document.createElement("span"),
        range = document.createElement("span");
      day.textContent = weekdays[
        new Date(`${date}T12:00:00Z`).getUTCDay()
      ].slice(0, 3);
      range.textContent = `${Math.round(w.daily.temperature_2m_max[i + 1])}° / ${Math.round(w.daily.temperature_2m_min[i + 1])}°`;
      row.append(day, range);
      $("forecast").append(row);
    });
}
const format = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
function tick() {
  if (!$("outputs-dialog").hidden) return;
  if (views[view] === "clock") {
    const offset =
        (state && state.config && state.config.utcOffsetSeconds) || 0,
      now = new Date(Date.now() + offset * 1000),
      hour = now.getUTCHours();
    setText(
      $("time"),
      `${hour % 12 || 12}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`,
    );
  }
  if (views[view] !== "media" || !state || !state.media.duration) return;
  const m = state.media,
    elapsed = Math.min(
      m.duration,
      Math.max(
        0,
        m.elapsed +
          (m.playing && connected
            ? (Math.max(0, Date.now() - m.timestamp) / 1000) * (m.rate || 1)
            : 0),
      ),
    );
  $("progress").style.transitionDuration = m.playing && connected ? "1s" : "0s";
  $("progress").style.transform = `scaleX(${elapsed / m.duration})`;
  setText($("elapsed"), format(elapsed));
  setText($("duration"), format(m.duration));
}
async function connect() {
  while (!demo) {
    try {
      streamController = new AbortController();
      const response = await fetch("/api/events", {
        signal: streamController.signal,
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!response.ok || !response.body) throw Error();
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw Error();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 64000) throw Error();
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (event.startsWith("event: state\n")) {
              connected = true;
              reconnectDelay = 500;
              render(JSON.parse(event.slice(event.indexOf("data: ") + 6)));
            }
            if (event.startsWith("event: view\n")) nextView();
          }
        }
      } finally {
        await reader.cancel();
      }
    } catch {
      connected = false;
      updateControls();
      renderHardware();
      scheduleTick();
      $("display").classList.add("disconnected");
      if (!state || !state.media.title) {
        $("idle").hidden = false;
        $("idle").classList.add("reconnecting");
        $("idletext").textContent = "Reconnecting";
      }
      if (!reconnectNow)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, reconnectDelay);
          reconnectWake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      reconnectWake = null;
      reconnectNow = false;
      reconnectDelay = Math.min(15000, reconnectDelay * 2);
    }
  }
}
controls.forEach(
  (button) =>
    (button.onclick = async () => {
      if (pending || button.disabled) return;
      pending = button.id;
      if (button.dataset.action === "toggle-play-pause") {
        playIntent = !state.media.playing;
        playDeadline = Date.now() + 2000;
      }
      updateControls();
      try {
        if (demo) {
          const m = state.media,
            a = button.dataset.action;
          if (m.playing)
            m.elapsed = Math.min(
              m.duration,
              m.elapsed + Math.max(0, Date.now() - m.timestamp) / 1000,
            );
          m.timestamp = Date.now();
          if (a === "repeat") m.repeatMode = { 1: 3, 3: 2, 2: 1 }[m.repeatMode];
          if (a === "shuffle") m.shuffleMode = m.shuffleMode === 1 ? 3 : 1;
          if (a === "toggle-play-pause") m.playing = !m.playing;
          if (a.startsWith("seek-"))
            m.elapsed = Math.max(
              0,
              Math.min(m.duration, m.elapsed + (a === "seek-back" ? -10 : 10)),
            );
          render(state);
        } else await api("/api/control", { action: button.dataset.action });
      } catch (e) {
        playIntent = null;
        notice(e.message);
      } finally {
        pending = "";
        updateControls();
        if (playIntent !== null)
          setTimeout(() => {
            if (Date.now() >= playDeadline) {
              playIntent = null;
              updateControls();
            }
          }, 2100);
      }
    }),
);
let hardwareQueue = [],
  activeHardware = null,
  powerIntent = null,
  hardwareTimer,
  feedbackTimer;
function feedback(message) {
  $("feedback").textContent = message;
  $("feedback").hidden = false;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => ($("feedback").hidden = true), 900);
}
let previousOutput = "";
function renderHardware() {
  const h = (state && state.hardware) || {};
  $("output-button").hidden = !h.output;
  $("output-button").disabled = !connected || outputBusy;
  const outputName = h.output ? h.output.name : "";
  if ($("output-button").title !== outputName)
    $("output-button").title = outputName;
  const key = [h.output && h.output.id, h.outputRevision].join("|");
  if (key !== previousOutput) {
    previousOutput = key;
    if (!$("outputs-dialog").hidden && !outputBusy) void openOutputs();
  }
  if (
    h.brightness !== undefined &&
    !(activeHardware && activeHardware.action === "brightness") &&
    !hardwareQueue.some((c) => c.action === "brightness")
  ) {
    $("brightness").value = h.brightness;
    setText($("brightness-value"), h.brightness + "%");
  }
}
function queueHardware(command) {
  if (command.action === "display") powerIntent = command.on;
  if (command.action === "volume") {
    const last = hardwareQueue.find((c) => c.action === "volume");
    if (last)
      last.delta = Math.max(-0.2, Math.min(0.2, last.delta + command.delta));
    else hardwareQueue.push(command);
  } else {
    hardwareQueue = hardwareQueue.filter((c) => c.action !== command.action);
    hardwareQueue.push(command);
  }
  if (!hardwareTimer)
    hardwareTimer = setTimeout(() => {
      hardwareTimer = null;
      void sendHardware();
    }, 40);
}
async function sendHardware() {
  if (activeHardware || !hardwareQueue.length) return;
  const command = hardwareQueue.shift();
  if (command.action === "volume" && command.delta === 0) {
    if (hardwareQueue.length) void sendHardware();
    return;
  }
  activeHardware = command;
  try {
    if (demo) {
      const h = state.hardware;
      if (command.action === "volume")
        h.volume = Math.max(0, Math.min(1, h.volume + command.delta));
      if (command.action === "brightness") h.brightness = command.value;
      if (command.action === "display") h.displayOn = command.on;
    } else {
      const result = await api("/api/hardware", command);
      state.hardware = result.hardware;
    }
    renderHardware();
    if (command.action === "volume")
      feedback("Volume " + Math.round(state.hardware.volume * 100) + "%");
  } catch (e) {
    powerIntent = null;
    notice(e.message);
  } finally {
    activeHardware = null;
    if (
      command.action === "display" &&
      !hardwareQueue.some((c) => c.action === "display")
    )
      powerIntent = null;
    renderHardware();
    if (hardwareQueue.length) void sendHardware();
  }
}
window.addEventListener(
  "wheel",
  (e) => {
    const delta = e.deltaX || e.deltaY;
    if (!delta) return;
    e.preventDefault();
    if (views[view] === "settings") {
      const value = Math.max(
        5,
        Math.min(100, Number($("brightness").value) + (delta > 0 ? 2 : -2)),
      );
      $("brightness").value = value;
      $("brightness-value").textContent = value + "%";
      queueHardware({ action: "brightness", value });
    } else
      queueHardware({ action: "volume", delta: delta > 0 ? 0.025 : -0.025 });
  },
  { passive: false },
);
let outputBusy = false,
  outputRevision = 0;
function closeOutputs() {
  outputRevision++;
  $("outputs-dialog").hidden = true;
  scheduleTick();
}
function outputStatus(message) {
  setText($("outputs-state"), message);
  $("outputs-state").hidden = !message;
}
function outputList(outputs) {
  $("outputs-list").textContent = "";
  const selected = state.hardware.output && state.hardware.output.id;
  outputs
    .slice()
    .sort((a, b) => Number(b.id === selected) - Number(a.id === selected))
    .forEach((output) => {
      const button = document.createElement("button");
      button.textContent = output.name;
      button.className = "output-option";
      button.disabled = outputBusy;
      button.setAttribute(
        "aria-pressed",
        String(state.hardware.output && output.id === state.hardware.output.id),
      );
      button.onclick = () => selectOutput(output.id);
      $("outputs-list").append(button);
    });
}
async function openOutputs() {
  if (outputBusy) return;
  const revision = ++outputRevision;
  $("outputs-dialog").hidden = false;
  scheduleTick();
  $("outputs-retry").hidden = true;
  $("outputs-list").textContent = "";
  outputStatus("Loading…");
  try {
    const result = demo
      ? {
          outputs: [
            { id: 1, name: "MacBook Speakers" },
            { id: 2, name: "AirPods" },
            { id: 3, name: "Studio Display" },
          ],
        }
      : await api("/api/outputs");
    if ($("outputs-dialog").hidden || revision !== outputRevision) return;
    outputList(result.outputs);
    outputStatus(result.outputs.length ? "" : "No audio outputs");
    $("outputs-retry").hidden = !!result.outputs.length;
  } catch {
    if (revision === outputRevision) {
      outputStatus("Output unavailable");
      $("outputs-retry").hidden = false;
    }
  }
}
async function selectOutput(id) {
  if (outputBusy) return;
  outputBusy = true;
  renderHardware();
  outputStatus("Switching…");
  $("outputs-list")
    .querySelectorAll("button")
    .forEach((button) => (button.disabled = true));
  try {
    if (demo) {
      await sleep(350);
      state.hardware.output = {
        id,
        name: { 1: "MacBook Speakers", 2: "AirPods", 3: "Studio Display" }[id],
      };
    } else
      state.hardware = (
        await api("/api/hardware", { action: "output", id })
      ).hardware;
    renderHardware();
    closeOutputs();
  } catch {
    outputStatus("Output unavailable");
    $("outputs-retry").hidden = false;
  } finally {
    outputBusy = false;
    renderHardware();
    $("outputs-list")
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = false));
  }
}
$("output-button").onclick = openOutputs;
$("outputs-close").onclick = closeOutputs;
$("outputs-retry").onclick = openOutputs;
$("choose-location").onclick = async () => {
  try {
    await api("/api/location", {});
  } catch (e) {
    notice(e.message);
  }
};
$("brightness").addEventListener("input", () => {
  const value = Number($("brightness").value);
  $("brightness-value").textContent = value + "%";
  queueHardware({ action: "brightness", value });
});
function preview(name) {
  const video = name === "video" || name === "x";
  const m = {
    status: "ready",
    kind: video ? "video" : "music",
    title: video
      ? name === "x"
        ? "Building a tiny desk display"
        : "Why every company now needs to think and operate like a lab team | Josh…"
      : "Weightless",
    artist: video
      ? name === "x"
        ? "@charles"
        : "Lenny’s Podcast"
      : "Mira Sol",
    artwork: video ? (name === "x" ? "/x.svg" : "/video.svg") : "/music.svg",
    playing: !video,
    duration: video ? 628 : 247,
    elapsed: video ? 83 : 72,
    timestamp: Date.now(),
    rate: 1,
    repeatMode: 1,
    shuffleMode: 1,
    capabilities: { seek: true, skip: !video, shuffle: !video, repeat: !video },
  };
  const w = {
    status: "ready",
    current: { temperature_2m: 64, weather_code: 0 },
    daily: {
      time: [
        "2026-10-11",
        "2026-10-12",
        "2026-10-13",
        "2026-10-14",
        "2026-10-15",
        "2026-10-16",
      ],
      temperature_2m_max: [68, 67, 65, 66, 69, 70],
      temperature_2m_min: [54, 55, 53, 54, 55, 56],
    },
  };
  connected = name !== "connecting" && name !== "unavailable";
  if (["empty", "connecting", "unavailable"].includes(name)) {
    m.status =
      name === "empty"
        ? "empty"
        : name === "connecting"
          ? "loading"
          : "unavailable";
    m.title = "";
    m.artist = "";
    m.artwork = "";
    m.duration = 0;
  }
  render({
    media: m,
    weather: w,
    hardware: {
      brightness: 92,
      displayOn: true,
      volume: 0.44,
      output: { id: 1, name: "MacBook Speakers" },
    },
    config: {
      location: { name: "San Francisco" },
      unit: "fahrenheit",
      utcOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    },
  });
  if (name === "music-paused") m.playing = false;
  if (name === "shuffle-on") m.shuffleMode = 3;
  if (name === "repeat-all") m.repeatMode = 3;
  if (name === "repeat-one") m.repeatMode = 2;
  updateControls();
  if (name.startsWith("source-")) {
    $("outputs-dialog").hidden = false;
    const outputs = [
      { id: 1, name: "MacBook Speakers" },
      { id: 2, name: "AirPods" },
      { id: 3, name: "Studio Display" },
    ];
    outputList(
      ["source-empty", "source-loading", "source-unavailable"].includes(name)
        ? []
        : outputs,
    );
    outputStatus(
      name === "source-switching"
        ? "Switching…"
        : name === "source-unavailable"
          ? "Output unavailable"
          : name === "source-loading"
            ? "Loading…"
            : name === "source-empty"
              ? "No audio outputs"
              : "",
    );
    $("outputs-retry").hidden = ![
      "source-empty",
      "source-unavailable",
    ].includes(name);
    if (name === "source-switching")
      $("outputs-list")
        .querySelectorAll("button")
        .forEach((button) => (button.disabled = true));
  }
  if (name === "weather") selectView(2);
  if (name === "clock") selectView(1);
  if (name === "settings") selectView(3);
  tick();
  scheduleTick();
}
let tickTimer;
function scheduleTick() {
  const needed =
    !document.hidden &&
    $("outputs-dialog").hidden &&
    (views[view] === "clock" ||
      (views[view] === "media" &&
        connected &&
        state &&
        state.media.playing &&
        state.media.duration));
  if (needed && !tickTimer) tickTimer = setInterval(tick, 1000);
  if (!needed && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
function reconnect() {
  reconnectDelay = 500;
  reconnectNow = true;
  if (streamController) streamController.abort();
  if (reconnectWake) reconnectWake();
}
window.addEventListener("carthing:connected", reconnect);
window.addEventListener("online", () => {
  if (!connected) reconnect();
});
document.addEventListener("visibilitychange", () => {
  scheduleTick();
  tick();
});
if (demo) preview(demo);
else void connect();
