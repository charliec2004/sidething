const elements = {};
document.querySelectorAll("[id]").forEach((el) => (elements[el.id] = el));
const $ = (id) => elements[id];
const setHidden = (el, hidden) => {
  if (hidden) el.setAttribute("hidden", "");
  else el.removeAttribute("hidden");
};
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
let helperOffset = 0,
  timerAlertTimer,
  timerAlertUntil = 0;
const helperNow = () => Date.now() + helperOffset;
let timelineIdentity = "",
  timelineResetUntil = 0,
  timelineFastUntil = 0,
  timelineResetTimer;
let playIntent = null,
  playDeadline = 0,
  metadataTimer,
  trackDeadline = 0;
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
  if (scrubbing) void endSeek(true);
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
function animateSwitch(el) {
  if (el.animate)
    el.animate(
      [
        { opacity: 0.65, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
}
function nextView() {
  selectView((view + 1) % views.length);
}
window.addEventListener("carthing:view-next", nextView);
let touchedButton;
function pressFeedback(e) {
  const button = e.target.closest && e.target.closest("button");
  if (!button || button.disabled) return;
  touchedButton = button;
  button.classList.add("touch-feedback");
}
function releaseFeedback() {
  if (!touchedButton) return;
  const button = touchedButton;
  touchedButton = null;
  setTimeout(() => button.classList.remove("touch-feedback"), 180);
}
window.addEventListener("pointerdown", pressFeedback, true);
window.addEventListener("touchstart", pressFeedback, {
  passive: true,
  capture: true,
});
["pointerup", "pointercancel", "touchend", "touchcancel"].forEach((name) =>
  window.addEventListener(name, releaseFeedback, true),
);
window.addEventListener("keydown", (e) => {
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
    if (views[view] === "clock" && clockStyle === 5) $("timer-toggle").click();
    else $("play").click();
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
const modeIntents = {};
function updateControls() {
  const confirmed = (state && state.media) || {};
  const m = Object.assign({}, confirmed);
  ["shuffle", "repeat"].forEach((action) => {
    const intent = modeIntents[action];
    if (!intent) return;
    if (
      intent.source !== m.sourceId ||
      intent.mode === m[action + "Mode"] ||
      Date.now() > intent.deadline
    )
      delete modeIntents[action];
    else m[action + "Mode"] = intent.mode;
  });
  const step = m.seekStep || 10,
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
  setHidden($("repeatone"), m.repeatMode !== 2);
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
    setHidden($("placeholder"), false);
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
  const oldMedia = state && state.media,
    oldTimer = state && state.timer;
  state = value;
  if (Number.isFinite(value.serverTime))
    helperOffset = value.serverTime - Date.now();
  if (
    value.timer &&
    value.timer.phase === "finished" &&
    (!oldTimer || oldTimer.phase !== "finished")
  )
    timerFinished(value.timer);
  if (value.timer && value.timer.phase !== "finished") {
    stopTimerAlert();
  }
  const identity = [
    value.media.sourceId,
    value.media.title,
    value.media.artist,
  ].join("|");
  if (timelineIdentity && identity !== timelineIdentity) {
    timelineResetUntil = Date.now() + 180;
    clearTimeout(timelineResetTimer);
    timelineResetTimer = setTimeout(() => {
      timelineResetUntil = 0;
      timelineFastUntil = Date.now() + 200;
      tick();
    }, 180);
    $("progress").style.transitionDuration = ".18s";
    $("progress").style.transform =
      `scaleX(${value.media.duration ? value.media.elapsed / value.media.duration : 0})`;
  }
  timelineIdentity = identity;
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
  if (
    scrubbing &&
    (!connected ||
      (oldMedia &&
        (oldMedia.title !== m.title || oldMedia.sourceId !== m.sourceId)))
  )
    void endSeek(true);
  $("artwork").classList.toggle("video", m.kind === "video");
  $("player-cycle").hidden = !(m.sourceCount > 1);
  $("player-cycle").disabled = !connected || !!pending;
  if (showMedia) {
    if (
      oldMedia &&
      oldMedia.title !== m.title &&
      oldMedia.title &&
      Date.now() > trackDeadline
    ) {
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
  renderTimer();
  tick();
  scheduleTick();
}
let previousWeather = "",
  weatherHourly = false;
$("weather").onclick = (e) => {
  if (!state || !state.weather.current || e.target.closest("button")) return;
  weatherHourly = !weatherHourly;
  renderWeather();
  animateSwitch($("forecast"));
};
$("weather").onkeydown = (e) => {
  if (e.key === " ") {
    e.preventDefault();
    $("weather").click();
  }
};
function renderWeather() {
  const w = state.weather || {},
    current = w.current,
    l = state.config && state.config.location;
  const signature = JSON.stringify([w, l, weatherHourly]);
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
  setHidden($("weathericon"), !current);
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
  const forecast = weatherHourly ? w.hourly : w.daily;
  if (forecast && forecast.time)
    forecast.time.slice(1, 6).forEach((date, i) => {
      const row = document.createElement("div");
      row.className = "forecast-row";
      const label = document.createElement("span"),
        temperature = document.createElement("span");
      const hour = Number(date.slice(11, 13));
      label.textContent = weatherHourly
        ? `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`
        : weekdays[new Date(`${date}T12:00:00Z`).getUTCDay()].slice(0, 3);
      temperature.textContent = weatherHourly
        ? `${Math.round(forecast.temperature_2m[i + 1])}°`
        : `${Math.round(forecast.temperature_2m_max[i + 1])}° / ${Math.round(forecast.temperature_2m_min[i + 1])}°`;
      row.append(label, temperature);
      $("forecast").append(row);
    });
  $("weather-layout").setAttribute(
    "aria-label",
    weatherHourly
      ? "Hourly forecast. Tap for five days"
      : "Five day forecast. Tap for five hours",
  );
}
const format = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
// Commands are acknowledged by the helper; a short-lived draft makes dial input immediate.
let timerDraft = null,
  timerQueue = [],
  timerSending = false,
  timerSendDelay,
  timerAnimation;
const timerModel = () =>
  timerDraft ||
  (state && state.timer) || { phase: "idle", remaining: 0, endsAt: 0 };
const timerSeconds = (t) =>
  t.phase === "running"
    ? Math.min(t.remaining, Math.max(0, (t.endsAt - helperNow()) / 1000))
    : t.remaining;
function stopTimerAlert() {
  clearTimeout(timerAlertTimer);
  const clock = $("clock");
  if (!clock.classList.contains("timer-alert")) return;
  const color = getComputedStyle(clock).backgroundColor;
  clock.classList.remove("timer-alert");
  if (clock.animate)
    clock.animate(
      [{ backgroundColor: color }, { backgroundColor: "#090a0b" }],
      { duration: 180, easing: "ease-out" },
    );
}
function timerFinished(timer) {
  clockStyle = 5;
  renderTimer();
  selectView(1);
  timerAlertUntil = (timer.finishedAt || 0) + 45000;
  const remaining = timerAlertUntil - helperNow();
  clearTimeout(timerAlertTimer);
  $("clock").classList.toggle("timer-alert", remaining > 0);
  if (remaining > 0) timerAlertTimer = setTimeout(stopTimerAlert, remaining);
}
function timerChange(t, command) {
  const next = Object.assign({}, t),
    seconds = t.phase === "idle" ? 60 : timerSeconds(t);
  if (command.action === "adjust" || command.action === "set") {
    next.remaining = Math.max(
      60,
      Math.min(
        86400,
        command.action === "set"
          ? command.minutes * 60
          : seconds + command.minutes * 60,
      ),
    );
    next.duration =
      ["running", "paused"].includes(t.phase) && command.action === "adjust"
        ? Math.max(
            60,
            Math.min(86400, (t.duration || seconds) + command.minutes * 60),
          )
        : next.remaining;
    if (t.phase === "running")
      next.endsAt = helperNow() + next.remaining * 1000;
    else if (t.phase !== "paused") next.phase = "ready";
  } else if (command.action === "reset")
    Object.assign(next, {
      phase: "idle",
      remaining: 0,
      endsAt: 0,
      duration: 0,
    });
  else if (command.action === "replay" && t.phase === "finished")
    Object.assign(next, {
      phase: "running",
      remaining: t.duration,
      endsAt: helperNow() + t.duration * 1000,
      finishedAt: 0,
    });
  else if (command.action === "toggle") {
    if (t.phase === "running")
      Object.assign(next, { phase: "paused", remaining: seconds, endsAt: 0 });
    else if (seconds > 0)
      Object.assign(next, {
        phase: "running",
        endsAt: helperNow() + seconds * 1000,
      });
  }
  return next;
}
function timerCommand(command) {
  if (!state || (!connected && !demo)) {
    notice("Reconnect to set the timer");
    return;
  }
  if (command.action === "reset" || command.action === "replay")
    stopTimerAlert();
  timerDraft = timerChange(timerModel(), command);
  const last = timerQueue[timerQueue.length - 1];
  if (last && last.action === "adjust" && command.action === "adjust")
    last.minutes += command.minutes;
  else timerQueue.push(command);
  renderTimer();
  scheduleTick();
  if (!timerSendDelay)
    timerSendDelay = setTimeout(() => {
      timerSendDelay = null;
      void sendTimer();
    }, 40);
}
async function sendTimer() {
  if (timerSending || !timerQueue.length) return;
  timerSending = true;
  const command = timerQueue.shift();
  try {
    if (command.action !== "adjust" || command.minutes) {
      if (demo) state.timer = timerChange(state.timer, command);
      else {
        const response = await api("/api/timer", command);
        if (Number.isFinite(response.serverTime))
          helperOffset = response.serverTime - Date.now();
        state.timer = response.timer;
      }
    }
  } catch (e) {
    timerQueue = [];
    notice(e.message);
  } finally {
    timerSending = false;
    if (!timerQueue.length) timerDraft = null;
    renderTimer();
    scheduleTick();
    if (timerQueue.length) void sendTimer();
  }
}
let previousTimerMinute = null,
  timerLayerVisible = null,
  clockFadeIn,
  clockFadeOut;
function renderClockLayers(active) {
  if (active === timerLayerVisible) return;
  const incoming = $(active ? "timer-layout" : "clock-face"),
    outgoing = $(active ? "clock-face" : "timer-layout");
  if (clockFadeIn) clockFadeIn.cancel();
  if (clockFadeOut) clockFadeOut.cancel();
  incoming.hidden = false;
  if (timerLayerVisible !== null && incoming.animate) {
    outgoing.hidden = false;
    clockFadeOut = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 120,
      easing: "ease-out",
      fill: "forwards",
    });
    clockFadeOut.onfinish = () => {
      outgoing.hidden = true;
    };
    clockFadeIn = incoming.animate(
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  } else outgoing.hidden = true;
  outgoing.style.pointerEvents = "none";
  incoming.style.pointerEvents = "";
  outgoing.inert = true;
  incoming.inert = false;
  timerLayerVisible = active;
}
function renderTimer() {
  const t = timerModel(),
    active = clockStyle === 5,
    choosing = t.phase === "ready" || t.phase === "idle";
  renderClockLayers(active);
  if (!active) {
    previousTimerMinute = null;
    return;
  }
  const seconds = t.phase === "idle" ? 60 : Math.ceil(timerSeconds(t)),
    minutes = Math.max(1, Math.ceil(seconds / 60));
  $("timer-done").hidden = t.phase !== "finished";
  $("timer-before").disabled = minutes <= 1;
  $("timer-after").disabled = minutes >= 1440;
  $("timer-wheel").hidden = !choosing;
  $("timer-readout").hidden = choosing;
  setText($("timer-readout"), format(seconds));
  setText($("timer-minute"), String(minutes));
  setText($("timer-before"), minutes > 1 ? String(minutes - 1) : "");
  setText($("timer-after"), minutes < 1440 ? String(minutes + 1) : "");
  $("timer-wheel").setAttribute("aria-valuenow", String(minutes));
  $("timer-wheel").setAttribute("aria-valuetext", minutes + " minutes");
  if (
    choosing &&
    previousTimerMinute !== null &&
    minutes !== previousTimerMinute
  ) {
    clearTimeout(timerAnimation);
    $("timer-wheel").classList.add("turning");
    timerAnimation = setTimeout(
      () => $("timer-wheel").classList.remove("turning"),
      120,
    );
  }
  previousTimerMinute = minutes;
  const finished = t.phase === "finished";
  setHidden($("timer-playicon"), t.phase === "running" || finished);
  setHidden($("timer-pauseicon"), t.phase !== "running");
  setHidden($("timer-checkicon"), !finished);
  setHidden($("timer-clearicon"), finished);
  setHidden($("timer-replayicon"), !finished);
  $("timer-reset").setAttribute(
    "aria-label",
    finished ? "Replay timer" : "Stop timer",
  );
  $("timer-toggle").setAttribute(
    "aria-label",
    finished ? "Done" : t.phase === "running" ? "Pause timer" : "Start timer",
  );
  $("timer-toggle").disabled = !connected || (!finished && seconds === 0);
  $("timer-reset").disabled = !connected;
  $("timer-layout").classList.toggle(
    "finished",
    t.phase === "finished" || (t.phase === "running" && seconds === 0),
  );
}
$("timer-toggle").onclick = () => {
  if (timerModel().phase === "finished") {
    clearTimer();
    return;
  }
  if (timerModel().phase === "idle")
    timerCommand({ action: "set", minutes: 1 });
  timerCommand({ action: "toggle" });
};
$("timer-before").onclick = () =>
  timerCommand({ action: "adjust", minutes: -1 });
$("timer-after").onclick = () => timerCommand({ action: "adjust", minutes: 1 });
function clearTimer() {
  clockStyle = 0;
  timerCommand({ action: "reset" });
  renderTimer();
  tick();
  scheduleTick();
}
$("timer-reset").onclick = () => {
  if (timerModel().phase === "finished") timerCommand({ action: "replay" });
  else clearTimer();
};
$("timer-wheel").onkeydown = (e) => {
  if (
    e.key === "ArrowUp" ||
    e.key === "ArrowRight" ||
    e.key === "ArrowDown" ||
    e.key === "ArrowLeft"
  ) {
    e.preventDefault();
    timerCommand({
      action: "adjust",
      minutes: ["ArrowUp", "ArrowRight"].includes(e.key) ? 1 : -1,
    });
  }
};
let timerTouchY;
$("timer-wheel").addEventListener(
  "touchstart",
  (e) => {
    timerTouchY = e.touches[0].clientY;
  },
  { passive: true },
);
$("timer-wheel").addEventListener(
  "touchmove",
  (e) => {
    const next = e.touches[0].clientY,
      steps = Math.trunc((timerTouchY - next) / 28);
    if (!steps) return;
    e.preventDefault();
    timerTouchY -= steps * 28;
    timerCommand({ action: "adjust", minutes: steps });
  },
  { passive: false },
);

let clockStyle = 0;
try {
  const saved = Number(localStorage.getItem("clockStyle"));
  if (Number.isInteger(saved) && saved >= 0 && saved < 6) clockStyle = saved;
} catch {}
if (demo) clockStyle = 0;
function clockChange(e) {
  if (e && e.target.closest("button, #timer-wheel")) return;
  const leavingTimer = clockStyle === 5;
  if (leavingTimer) stopTimerAlert();
  clockStyle = (clockStyle + 1) % 6;
  renderTimer();
  try {
    localStorage.setItem("clockStyle", String(clockStyle));
  } catch {}
  tick();
  scheduleTick();
  if (!leavingTimer && clockStyle !== 5) animateSwitch($("clock-face"));
}
$("clock").onclick = clockChange;
$("clock-face").onkeydown = (e) => {
  if (e.key === " ") {
    e.preventDefault();
    clockChange();
  }
};
function renderClock(now) {
  const hour = now.getUTCHours(),
    minute = String(now.getUTCMinutes()).padStart(2, "0"),
    seconds = String(now.getUTCSeconds()).padStart(2, "0"),
    meridiem = hour < 12 ? "AM" : "PM",
    showSeconds = clockStyle % 2 === 0,
    style = Math.floor(clockStyle / 2);
  $("time").hidden = style !== 0;
  $("clock-bold").hidden = style !== 1;
  $("clock-analog").hidden = style !== 2;
  setText(
    $("time"),
    `${hour % 12 || 12}:${minute}${showSeconds ? ":" + seconds : ""} ${meridiem}`,
  );
  setText($("clock-bold-time"), `${hour % 12 || 12}:${minute}`);
  setText(
    $("clock-bold-extra"),
    (showSeconds ? seconds + " · " : "") + meridiem,
  );
  setText($("clock-period"), meridiem);
  setHidden($("clock-second"), !showSeconds);
  const second = showSeconds ? now.getUTCSeconds() : 0;
  $("clock-hour").setAttribute(
    "transform",
    `rotate(${(hour % 12) * 30 + now.getUTCMinutes() / 2} 150 150)`,
  );
  $("clock-minute").setAttribute(
    "transform",
    `rotate(${now.getUTCMinutes() * 6 + second / 10} 150 150)`,
  );
  $("clock-second").setAttribute("transform", `rotate(${second * 6} 150 150)`);
  $("clock-face").setAttribute(
    "aria-label",
    "Clock: " + $("time").textContent + ". Tap to change style",
  );
}

let scrubbing = false,
  scrubSeconds = 0,
  scrubPointer;
function seekPreview(seconds) {
  scrubSeconds = Math.max(0, Math.min(state.media.duration, seconds));
  const display = $("display").getBoundingClientRect(),
    timeline = $("timeline").getBoundingClientRect();
  const x =
    timeline.left -
    display.left +
    (scrubSeconds / state.media.duration) * timeline.width;
  $("seek-time").style.left =
    Math.max(128, Math.min(display.width - 128, x)) + "px";
  $("seek-time").style.top =
    Math.max(140, timeline.top - display.top - 28) + "px";
  setText($("seek-time"), format(scrubSeconds));
  $("progress").style.transitionDuration = "0s";
  $("progress").style.transform =
    `scaleX(${scrubSeconds / state.media.duration})`;
  $("timeline").setAttribute("aria-valuenow", String(Math.floor(scrubSeconds)));
}
function beginSeek(seconds) {
  if (
    !state ||
    !connected ||
    !state.media.duration ||
    !state.media.capabilities.seek ||
    pending
  )
    return false;
  scrubbing = true;
  $("scrub-overlay").hidden = false;
  seekPreview(seconds);
  return true;
}
function seekPosition(x) {
  if (!state || !state.media || !state.media.duration) return 0;
  const r = $("timeline").getBoundingClientRect();
  return ((x - r.left) / r.width) * state.media.duration;
}
async function endSeek(cancel = false) {
  if (!scrubbing) return;
  scrubbing = false;
  $("scrub-overlay").hidden = true;
  if (cancel) {
    tick();
    return;
  }
  const target = scrubSeconds;
  pending = "timeline";
  updateControls();
  try {
    if (demo) {
      state.media.elapsed = target;
      state.media.timestamp = Date.now();
    } else
      await api("/api/control", {
        action: "seek",
        seconds: target,
        sourceId: state.media.sourceId,
      });
  } catch (e) {
    notice(e.message);
  } finally {
    pending = "";
    tick();
    updateControls();
  }
}
$("timeline").onpointerdown = (e) => {
  if (!beginSeek(seekPosition(e.clientX))) return;
  e.preventDefault();
  scrubPointer = e.pointerId;
  $("timeline").setPointerCapture(e.pointerId);
};
$("timeline").onpointermove = (e) => {
  if (scrubbing && e.pointerId === scrubPointer)
    seekPreview(seekPosition(e.clientX));
};
$("timeline").onpointerup = (e) => {
  if (e.pointerId === scrubPointer) void endSeek();
};
$("timeline").onpointercancel = () => {
  void endSeek(true);
};
$("timeline").onkeydown = (e) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  if (!state || !state.media || !state.media.duration) return;
  const m = state.media,
    current =
      m.elapsed +
      (m.playing ? Math.max(0, helperNow() - m.timestamp) / 1000 : 0);
  const target =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? m.duration
        : current + (e.key === "ArrowLeft" ? -5 : 5);
  if (beginSeek(target)) void endSeek();
};

function tick() {
  if (!$("outputs-dialog").hidden) return;
  if (views[view] === "clock") {
    if (clockStyle === 5) {
      if (
        demo &&
        timerModel().phase === "running" &&
        timerSeconds(timerModel()) <= 0
      ) {
        state.timer = {
          phase: "finished",
          duration: state.timer.duration,
          remaining: 0,
          endsAt: 0,
          finishedAt: helperNow(),
        };
        timerFinished(state.timer);
      }
      renderTimer();
      return;
    }
    const offset =
        (state && state.config && state.config.utcOffsetSeconds) || 0,
      now = new Date(helperNow() + offset * 1000),
      hour = now.getUTCHours();
    renderClock(now);
  }
  if (scrubbing || views[view] !== "media" || !state || !state.media.duration)
    return;
  const m = state.media,
    elapsed = Math.min(
      m.duration,
      Math.max(
        0,
        m.elapsed +
          (m.playing && connected
            ? (Math.max(0, helperNow() - m.timestamp) / 1000) * (m.rate || 1)
            : 0),
      ),
    );
  if (Date.now() >= timelineResetUntil) {
    $("progress").style.transitionDuration =
      Date.now() < timelineFastUntil
        ? ".12s"
        : m.playing && connected
          ? "1s"
          : ".12s";
    $("progress").style.transform = `scaleX(${elapsed / m.duration})`;
  }
  setText($("elapsed"), format(elapsed));
  setText($("duration"), format(m.duration));
  $("timeline").setAttribute("aria-valuemax", String(m.duration));
  $("timeline").setAttribute("aria-valuenow", String(Math.floor(elapsed)));
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
      if (["next-track", "previous-track"].includes(button.dataset.action))
        trackDeadline = Date.now() + 4000;
      button.classList.add("acknowledged");
      setTimeout(() => button.classList.remove("acknowledged"), 180);
      if (button.dataset.action === "toggle-play-pause") {
        playIntent = !state.media.playing;
        playDeadline = Date.now() + 2000;
      }
      if (["shuffle", "repeat"].includes(button.dataset.action)) {
        const action = button.dataset.action,
          current = state.media[action + "Mode"];
        modeIntents[action] = {
          source: state.media.sourceId,
          mode:
            action === "shuffle"
              ? current === 1
                ? 3
                : 1
              : { 1: 3, 3: 2, 2: 1 }[current],
          deadline: Date.now() + 2500,
        };
      }
      updateControls();
      try {
        if (demo) {
          const m = state.media,
            a = button.dataset.action;
          if (m.playing)
            m.elapsed = Math.min(
              m.duration,
              m.elapsed + Math.max(0, helperNow() - m.timestamp) / 1000,
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
        } else
          await api("/api/control", {
            action: button.dataset.action,
            sourceId: state.media.sourceId,
          });
      } catch (e) {
        delete modeIntents[button.dataset.action];
        playIntent = null;
        notice(e.message);
      } finally {
        pending = "";
        updateControls();
        if (modeIntents[button.dataset.action])
          setTimeout(updateControls, 2600);
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
let volumeDraft = null,
  volumeHide;
const wheelVolume = true; // Keep the fixed-width toast available for comparison.
function showVolume(value, direction, sticky = false) {
  if (!wheelVolume) {
    feedback("Volume " + Math.round(value * 100) + "%");
    return;
  }
  $("volume-ui").hidden = false;
  setText(
    $("volume-value"),
    value === null ? "—" : String(Math.round(value * 100)),
  );
  $("volume-plus").classList.toggle("active", direction > 0);
  $("volume-minus").classList.toggle("active", direction < 0);
  clearTimeout(volumeHide);
  if (!sticky)
    volumeHide = setTimeout(() => {
      $("volume-ui").hidden = true;
      volumeDraft = null;
    }, 1000);
}
function feedback(message) {
  $("feedback").textContent = message;
  $("feedback").hidden = false;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => ($("feedback").hidden = true), 900);
}
let previousOutput = "",
  previousOutputKind = "";
function renderHardware() {
  const h = (state && state.hardware) || {};
  $("output-button").hidden = !h.output;
  $("output-button").disabled = !connected || outputBusy;
  const shift = h.nightShift || {};
  const warm =
    !!shift.enabled &&
    (!/Mac/.test(navigator.platform) || demo === "night-shift");
  const strength = Math.max(0, Math.min(1, Number(shift.strength) || 0));
  const matrix = `1 0 0 0 0  0 ${1 - strength * 0.255} 0 0 0  0 0 ${1 - strength * 0.57} 0 0  0 0 0 1 0`;
  if ($("temperature-matrix").getAttribute("values") !== matrix)
    $("temperature-matrix").setAttribute("values", matrix);
  $("display").style.filter = warm ? "url(#temperature-filter)" : "none";
  const outputName = h.output ? h.output.name : "";
  const kind = (h.output && h.output.kind) || "speaker";
  if (kind !== previousOutputKind) {
    previousOutputKind = kind;
    $("output-icon").setAttribute("href", "#output-" + kind);
  }
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
    const current = volumeDraft === null ? state.hardware.volume : volumeDraft;
    volumeDraft =
      current === null
        ? null
        : Math.max(0, Math.min(1, current + command.delta));
    showVolume(volumeDraft, command.delta);
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
      if (!hardwareQueue.some((c) => c.action === "volume")) {
        volumeDraft = state.hardware.volume;
        showVolume(volumeDraft, command.delta);
      }
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
    if (!$("outputs-dialog").hidden && !e.deltaX) return;
    const delta = e.deltaX || e.deltaY;
    if (!delta) return;
    e.preventDefault();
    if (
      views[view] === "clock" &&
      clockStyle === 5 &&
      ["idle", "ready"].includes(timerModel().phase)
    )
      timerCommand({ action: "adjust", minutes: delta > 0 ? 1 : -1 });
    else if (views[view] === "settings")
      setBrightness(Number($("brightness").value) + (delta > 0 ? 5 : -5));
    else queueHardware({ action: "volume", delta: delta > 0 ? 0.025 : -0.025 });
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
            { id: 1, name: "MacBook Speakers", kind: "speaker" },
            { id: 2, name: "AirPods", kind: "airpods" },
            { id: 3, name: "Studio Display", kind: "speaker" },
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
        kind: id === 2 ? "airpods" : "speaker",
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
$("player-cycle").onclick = async () => {
  if (pending) return;
  pending = "player-cycle";
  $("player-cycle").disabled = true;
  try {
    if (demo)
      preview(state.media.kind === "video" ? "players-music" : "players-video");
    else render(await api("/api/source", { action: "cycle" }));
  } catch (e) {
    notice(e.message);
  } finally {
    pending = "";
    $("player-cycle").disabled = !connected;
  }
};
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
function setBrightness(value) {
  const slider = $("brightness");
  value = Math.max(Number(slider.min), Math.min(Number(slider.max), value));
  slider.value = value;
  setText($("brightness-value"), value + "%");
  queueHardware({ action: "brightness", value });
}
$("brightness").addEventListener("input", () =>
  setBrightness(Number($("brightness").value)),
);
function preview(name) {
  const video = name === "video" || name === "x" || name === "players-video";
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
    sourceId: video ? "browser:1" : "com.apple.Music",
    sourceCount: name.startsWith("players-") ? 2 : 1,
  };
  const w = {
    status: "ready",
    current: { temperature_2m: 64, weather_code: 0 },
    hourly: {
      time: [
        "2026-10-12T16:00",
        "2026-10-12T17:00",
        "2026-10-12T18:00",
        "2026-10-12T19:00",
        "2026-10-12T20:00",
        "2026-10-12T21:00",
      ],
      temperature_2m: [64, 65, 63, 61, 59, 58],
    },
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
    timer: { phase: "idle", remaining: 0, endsAt: 0 },
    hardware: {
      brightness: 92,
      displayOn: true,
      volume: 0.44,
      output: { id: 1, name: "MacBook Speakers", kind: "speaker" },
    },
    config: {
      location: { name: "San Francisco" },
      unit: "fahrenheit",
      utcOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    },
  });
  if (name === "output-airpods" || name === "output-headphones") {
    state.hardware.output = {
      id: 2,
      name: name === "output-airpods" ? "AirPods" : "Headphones",
      kind: name.slice(7),
    };
    renderHardware();
  }
  if (name === "music-paused") m.playing = false;
  if (name === "shuffle-on") m.shuffleMode = 3;
  if (name === "repeat-all") m.repeatMode = 3;
  if (name === "repeat-one") m.repeatMode = 2;
  updateControls();
  if (name.startsWith("source-")) {
    $("outputs-dialog").hidden = false;
    const outputs = [
      { id: 1, name: "MacBook Speakers", kind: "speaker" },
      { id: 2, name: "AirPods", kind: "airpods" },
      { id: 3, name: "Studio Display", kind: "speaker" },
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
  if (name === "weather" || name === "weather-hours") {
    weatherHourly = name === "weather-hours";
    renderWeather();
    selectView(2);
  }
  if (name === "night-shift") {
    state.hardware.nightShift = { enabled: true, strength: 0.8 };
    renderHardware();
  }
  if (name === "scrubbing") {
    beginSeek(143);
  }
  if (
    name === "clock" ||
    name.startsWith("clock-") ||
    name.startsWith("timer-")
  ) {
    const styles = [
      "clock",
      "clock-no-seconds",
      "clock-bold",
      "clock-bold-no-seconds",
      "clock-analog",
    ];
    if (styles.includes(name)) clockStyle = styles.indexOf(name);
    if (name.startsWith("timer-")) {
      clockStyle = 5;
      state.timer = {
        phase: name === "timer-alert" ? "finished" : name.slice(6),
        remaining: ["timer-finished", "timer-alert"].includes(name) ? 0 : 900,
        duration: 900,
        endsAt: Date.now() + 900000,
      };
      renderTimer();
      if (name === "timer-alert") timerFinished({ finishedAt: helperNow() });
    }
    selectView(1);
  }
  if (name.startsWith("volume-")) {
    if (name === "volume-weather") selectView(2);
    showVolume(
      name === "volume-down" ? 0.09 : 0.44,
      name === "volume-down" ? -1 : 1,
      true,
    );
  }
  if (name === "settings") selectView(3);
  tick();
  scheduleTick();
}
let tickTimer,
  tickCadence = 0;
function scheduleTick() {
  const needed =
    !document.hidden &&
    (!state || !state.hardware || state.hardware.displayOn !== false) &&
    $("outputs-dialog").hidden &&
    ((views[view] === "clock" &&
      (clockStyle < 5 || timerModel().phase === "running")) ||
      (views[view] === "media" &&
        connected &&
        state &&
        state.media.playing &&
        state.media.duration));
  const cadence = needed
    ? views[view] === "clock" && clockStyle < 5 && clockStyle % 2 === 1
      ? 60000
      : 1000
    : 0;
  if (cadence !== tickCadence) {
    clearTimeout(tickTimer);
    tickTimer = null;
    tickCadence = cadence;
  }
  if (cadence && !tickTimer)
    tickTimer = setTimeout(
      () => {
        tickTimer = null;
        tick();
        scheduleTick();
      },
      cadence - (Date.now() % cadence) + 5,
    );
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
