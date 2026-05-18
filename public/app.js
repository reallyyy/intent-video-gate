const $ = (id) => document.getElementById(id);
const LOGIN_URLS = {
  youtube: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2Ffeed%2Fhistory%3Fintent_login_check%3D1",
  bilibili: "https://passport.bilibili.com/login?gourl=https%3A%2F%2Fwww.bilibili.com%2Faccount%2Fhistory%3Fintent_login_check%3D1"
};
let savedFilter = "";
let busy = false;
let feedRefreshing = false;
let aiRunning = false;
let tuneItem = null;
let tuneMessages = [];
let selectedReason = "";

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function init() {
  const health = await api("/api/health");
  savedFilter = health.filter || "";
  $("filter").value = savedFilter;
  updateLoginActions(health.auth);
  updateControls();
  await loadFeed();
}

async function refreshAuth() {
  const health = await api("/api/health");
  updateLoginActions(health.auth);
}

async function applyFilter() {
  setBusy(true, "Saving prompt...");
  const data = await api("/api/filter", {
    method: "POST",
    body: JSON.stringify({ filter: currentFilter() })
  });
  savedFilter = data.filter || "";
  $("filter").value = savedFilter;
  await loadFeed({ refresh: true });
}

async function loadFeed({ refresh = false } = {}) {
  feedRefreshing = refresh;
  updateControls();
  setBusy(true, refresh ? "Refreshing approved videos..." : "Loading approved videos...");
  try {
    const data = await api(`/api/feed${refresh ? "?refresh=1" : ""}`);
    render(data.items || []);
    feedRefreshing = false;
    setBusy(false, `${data.items?.length || 0} videos`);
  } catch (error) {
    render([]);
    feedRefreshing = false;
    setBusy(false, error.message);
  }
}

async function watch(item) {
  const data = await api("/api/watch", {
    method: "POST",
    body: JSON.stringify({ id: item.id })
  });
  if (data.mode === "native") {
    clearPlayer();
    window.location.href = data.openUrl;
    return;
  }
  showPlayer(data);
  $("player").hidden = false;
  $("player").scrollIntoView({ block: "start", behavior: "smooth" });
}

function showPlayer(data) {
  clearPlayer();
  const frame = $("playerFrame");
  frame.src = data.embedUrl;
  frame.hidden = false;
}

function clearPlayer() {
  const frame = $("playerFrame");
  frame.src = "about:blank";
  frame.hidden = true;
  $("player").hidden = true;
}

function render(items) {
  const feed = $("feed");
  feed.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No matching videos.";
    feed.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";

    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    if (item.thumbnail) {
      img.src = item.thumbnail;
    } else {
      img.className = "missing-thumb";
    }

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = item.title;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = [item.platform, item.uploader, formatDuration(item.durationSeconds)].filter(Boolean).join(" · ");

    const actions = document.createElement("span");
    actions.className = "card-actions";

    const watchButton = document.createElement("button");
    watchButton.type = "button";
    watchButton.className = "watch";
    watchButton.textContent = "Watch";
    watchButton.addEventListener("click", () => watch(item).catch((error) => setBusy(false, error.message)));

    const tuneButton = document.createElement("button");
    tuneButton.type = "button";
    tuneButton.className = "secondary tune";
    tuneButton.textContent = "Tune out";
    tuneButton.addEventListener("click", () => openTune(item));

    actions.append(watchButton, tuneButton);
    card.append(img, title, meta, actions);
    feed.append(card);
  }
}

function setBusy(isBusy, text) {
  busy = isBusy;
  $("status").textContent = text || "";
  updateControls();
}

function currentFilter() {
  return $("filter").value.trim();
}

function promptDirty() {
  return currentFilter() !== savedFilter;
}

function updateControls() {
  const dirty = promptDirty();
  $("apply").disabled = busy || !dirty;
  $("refresh").disabled = busy || dirty;
  $("refresh").classList.toggle("loading", feedRefreshing);
  $("refresh").setAttribute("aria-busy", feedRefreshing ? "true" : "false");
  if (!busy && dirty) {
    $("status").textContent = "Prompt changed. Apply & Refresh to update the feed.";
  }
}

function updateLoginActions(auth = {}) {
  const youtubeSignedIn = auth.youtube?.status === "signedIn";
  const bilibiliSignedIn = auth.bilibili?.status === "signedIn";
  $("loginYoutube").hidden = youtubeSignedIn;
  $("loginBilibili").hidden = bilibiliSignedIn;
  document.querySelector(".login-actions").hidden = youtubeSignedIn && bilibiliSignedIn;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!value) return "";
  const minutes = Math.floor(value / 60);
  const secs = String(value % 60).padStart(2, "0");
  return `${minutes}:${secs}`;
}

function openTune(item) {
  tuneItem = item;
  tuneMessages = [];
  selectedReason = "";
  $("tuneTitle").textContent = item.title || "Selected video";
  $("tuneMeta").textContent = [item.platform, item.uploader, formatDuration(item.durationSeconds)].filter(Boolean).join(" · ");
  $("manualInput").value = "";
  $("tuneInput").value = "";
  $("proposal").hidden = true;
  $("proposedFilter").value = "";
  $("videoDetails").hidden = false;
  $("videoDetails").textContent = "AI Assistant has not run yet.";
  renderTuneMessages();
  setTuneBusy(false, "");
  $("tuneDialog").showModal();
  $("manualInput").focus();
}

function closeTune() {
  $("tuneDialog").close();
  tuneItem = null;
  tuneMessages = [];
}

function renderTuneMessages() {
  const list = $("tuneMessages");
  list.textContent = "";
  if (!tuneMessages.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No AI discussion yet.";
    list.append(empty);
    return;
  }
  for (const message of tuneMessages) {
    const row = document.createElement("p");
    row.className = `message ${message.role}`;
    row.textContent = message.content;
    list.append(row);
  }
}

function buildManualProposal(reason = "") {
  if (!tuneItem) return;
  const chosen = String(reason || $("manualInput").value || "").trim();
  if (!chosen) {
    $("manualInput").placeholder = "low-effort gaming commentary";
    return;
  }
  $("proposedFilter").value = `${savedFilter || currentFilter()}\n\n${chosen}`.trim();
  $("proposal").hidden = false;
  $("videoDetails").hidden = false;
  $("videoDetails").textContent = "Manual draft ready. Do not describe this video; describe a type of video you want to avoid. Your words were kept exactly; nothing was added or rewritten.";
  setTuneBusy(false, "");
}

async function analyzeTune(extraMessage = "") {
  if (!tuneItem) return;
  if (extraMessage) tuneMessages.push({ role: "user", content: extraMessage });
  selectedReason = "";
  renderTuneMessages();
  aiRunning = true;
  setTuneBusy(true, "Gemini is checking video details...");
  try {
    const data = await api("/api/filter/refine-video", {
      method: "POST",
      body: JSON.stringify({ id: tuneItem.id, messages: tuneMessages })
    });
    tuneMessages.push({ role: "assistant", content: data.reply });
    if (data.videoSummary) {
      $("videoDetails").hidden = false;
      $("videoDetails").textContent = data.videoSummary;
    }
    $("proposedFilter").value = data.proposedFilter || "";
    $("proposal").hidden = false;
    renderTuneMessages();
    aiRunning = false;
    setTuneBusy(false, "");
  } catch (error) {
    aiRunning = false;
    setTuneBusy(false, error.message);
  }
}

async function sendTuneMessage() {
  const content = $("tuneInput").value.trim();
  $("tuneInput").value = "";
  await analyzeTune(content);
}

function setTuneBusy(isBusy, text) {
  $("tuneSend").disabled = isBusy;
  $("manualTune").disabled = isBusy;
  $("useProposal").disabled = isBusy || !$("proposedFilter").value.trim();
  $("tuneSend").classList.toggle("loading", aiRunning);
  $("tuneSend").setAttribute("aria-busy", aiRunning ? "true" : "false");
  if (text) $("status").textContent = text;
}

async function useProposal() {
  const filter = $("proposedFilter").value.trim();
  if (!filter) return;
  closeTune();
  $("filter").value = filter;
  await applyFilter();
}

$("apply").addEventListener("click", () => applyFilter().catch((error) => setBusy(false, error.message)));
$("refresh").addEventListener("click", () => loadFeed({ refresh: true }).catch((error) => setBusy(false, error.message)));
$("loginYoutube").addEventListener("click", () => {
  window.location.href = LOGIN_URLS.youtube;
});
$("loginBilibili").addEventListener("click", () => {
  window.location.href = LOGIN_URLS.bilibili;
});
$("filter").addEventListener("keydown", (event) => {
  if (event.key === "Enter") applyFilter().catch((error) => setBusy(false, error.message));
});
$("filter").addEventListener("input", updateControls);
$("tuneClose").addEventListener("click", closeTune);
$("tuneCancel").addEventListener("click", closeTune);
$("tuneCancelIdle").addEventListener("click", closeTune);
$("manualTune").addEventListener("click", () => buildManualProposal(selectedReason || $("manualInput").value));
$("tuneSend").addEventListener("click", () => sendTuneMessage().catch((error) => setTuneBusy(false, error.message)));
$("useProposal").addEventListener("click", () => useProposal().catch((error) => setBusy(false, error.message)));
$("proposedFilter").addEventListener("input", () => setTuneBusy(false, ""));
$("manualInput").addEventListener("input", () => {
  selectedReason = "";
});
$("manualInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") buildManualProposal();
});
$("tuneInput").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    sendTuneMessage().catch((error) => setTuneBusy(false, error.message));
  }
});
window.addEventListener("focus", () => refreshAuth().catch(() => {}));

init().catch((error) => setBusy(false, error.message));
