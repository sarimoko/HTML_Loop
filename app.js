
const $ = id => document.getElementById(id);

const DB_NAME = "sarimoko-loop";
const DB_VERSION = 1;

let db;
let audioContext;
let masterGain;
let reverbNode;
let reverbWet;
let delayNode;
let delayFeedback;
let delayWet;
let selectedQueueIndex = -1;
let library = [];
let queue = [];

const decks = {
  A: { audio: $("audioA"), cue: 0, trackId: null, nodes: null, peaks: [] },
  B: { audio: $("audioB"), cue: 0, trackId: null, nodes: null, peaks: [] }
};

function notify(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("tracks")) {
        database.createObjectStore("tracks", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("sets")) {
        database.createObjectStore("sets", { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(store, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getTrack = id => storeRequest("tracks", "readonly", s => s.get(id));
const getAllTracks = () => storeRequest("tracks", "readonly", s => s.getAll());
const putTrack = track => storeRequest("tracks", "readwrite", s => s.put(track));
const deleteTrack = id => storeRequest("tracks", "readwrite", s => s.delete(id));
const getAllSets = () => storeRequest("sets", "readonly", s => s.getAll());
const putSet = set => storeRequest("sets", "readwrite", s => s.put(set));
const deleteSet = id => storeRequest("sets", "readwrite", s => s.delete(id));

function ensureAudioEngine() {
  if (audioContext) {
    if (audioContext.state === "suspended") audioContext.resume();
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextClass();

  masterGain = audioContext.createGain();
  masterGain.gain.value = 0.9;

  delayNode = audioContext.createDelay(2);
  delayNode.delayTime.value = 0.32;

  delayFeedback = audioContext.createGain();
  delayFeedback.gain.value = 0.28;

  delayWet = audioContext.createGain();
  delayWet.gain.value = 0;

  delayNode.connect(delayFeedback);
  delayFeedback.connect(delayNode);
  delayNode.connect(delayWet);
  delayWet.connect(masterGain);

  reverbNode = audioContext.createConvolver();
  reverbNode.buffer = createImpulse(audioContext, 2.5, 2.2);

  reverbWet = audioContext.createGain();
  reverbWet.gain.value = 0;

  reverbNode.connect(reverbWet);
  reverbWet.connect(masterGain);

  masterGain.connect(audioContext.destination);

  ["A", "B"].forEach(createDeckAudioGraph);

  applyMixer();
}

function createImpulse(context, seconds, decay) {
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);

  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);

    for (let i = 0; i < length; i++) {
      const fade = Math.pow(1 - i / length, decay);
      data[i] = (Math.random() * 2 - 1) * fade;
    }
  }

  return impulse;
}

function createDeckAudioGraph(id) {
  const deck = decks[id];
  const source = audioContext.createMediaElementSource(deck.audio);

  const bass = audioContext.createBiquadFilter();
  bass.type = "lowshelf";
  bass.frequency.value = 180;

  const mid = audioContext.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1000;
  mid.Q.value = 0.8;

  const treble = audioContext.createBiquadFilter();
  treble.type = "highshelf";
  treble.frequency.value = 5000;

  const filter = audioContext.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 12000;

  const channelGain = audioContext.createGain();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.78;

  source.connect(bass);
  bass.connect(mid);
  mid.connect(treble);
  treble.connect(filter);

  // Dry audio path.
  filter.connect(channelGain);

  // Parallel echo and reverb sends.
  filter.connect(delayNode);
  filter.connect(reverbNode);

  channelGain.connect(analyser);
  analyser.connect(masterGain);

  deck.nodes = {
    source, bass, mid, treble, filter,
    channelGain, analyser
  };
}

async function importFiles(fileList) {
  const files = [...fileList].filter(file =>
    file.type.startsWith("audio/")
  );

  if (!files.length) {
    notify("No supported audio files selected.");
    return;
  }

  ensureAudioEngine();

  for (const file of files) {
    const track = {
      id: crypto.randomUUID(),
      name: file.name.replace(/\.[^.]+$/, ""),
      filename: file.name,
      size: file.size,
      type: file.type,
      added: Date.now(),
      blob: file
    };

    await putTrack(track);
  }

  await refreshLibrary();
  notify(`${files.length} track(s) imported.`);
}

async function refreshLibrary() {
  library = await getAllTracks();
  library.sort((a, b) => a.name.localeCompare(b.name));

  $("libraryCount").textContent = `${library.length} TRACKS`;
  renderLibrary();
}

function renderLibrary() {
  const container = $("libraryList");
  container.replaceChildren();

  if (!library.length) {
    container.innerHTML = '<div class="empty-state">Your music library is empty. Import audio files to get started.</div>';
    return;
  }

  library.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "track-row";

    const number = document.createElement("div");
    number.className = "track-index";
    number.textContent = String(index + 1).padStart(2, "0");

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "track-title";
    title.textContent = track.name;

    const meta = document.createElement("div");
    meta.className = "track-meta";
    meta.textContent = `${track.filename} · ${formatBytes(track.size)}`;

    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    actions.append(
      actionButton("ADD TO SET", () => addToQueue(track.id)),
      actionButton("LOAD A", () => loadTrack("A", track.id)),
      actionButton("LOAD B", () => loadTrack("B", track.id)),
      actionButton("DELETE", () => removeLibraryTrack(track.id))
    );

    row.append(number, info, actions);
    container.appendChild(row);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function actionButton(label, callback) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", callback);
  return button;
}

function addToQueue(trackId) {
  const track = library.find(item => item.id === trackId);
  if (!track) return;

  queue.push(trackId);
  selectedQueueIndex = queue.length - 1;
  renderQueue();
  notify("Added to set.");
}

function renderQueue() {
  const container = $("queueList");
  container.replaceChildren();

  $("queueCount").textContent = `${queue.length} TRACKS`;

  if (!queue.length) {
    container.innerHTML = '<div class="empty-state">Your set is empty. Add tracks from the music library.</div>';
    return;
  }

  queue.forEach((trackId, index) => {
    const track = library.find(item => item.id === trackId);
    if (!track) return;

    const row = document.createElement("div");
    row.className = "track-row";

    const number = document.createElement("div");
    number.className = "track-index";
    number.textContent = String(index + 1).padStart(2, "0");

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "track-title";
    title.textContent = track.name;

    const meta = document.createElement("div");
    meta.className = "track-meta";
    meta.textContent = selectedQueueIndex === index ? "SELECTED TRACK" : "IN SET";

    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    actions.append(
      actionButton("SELECT", () => {
        selectedQueueIndex = index;
        renderQueue();
      }),
      actionButton("LOAD A", () => loadTrack("A", trackId)),
      actionButton("LOAD B", () => loadTrack("B", trackId)),
      actionButton("↑", () => moveQueueItem(index, -1)),
      actionButton("↓", () => moveQueueItem(index, 1)),
      actionButton("REMOVE", () => removeQueueItem(index))
    );

    row.append(number, info, actions);

    if (selectedQueueIndex === index) {
      row.style.background = "#252b20";
    }

    container.appendChild(row);
  });
}

function moveQueueItem(index, direction) {
  const target = index + direction;

  if (target < 0 || target >= queue.length) return;

  [queue[index], queue[target]] = [queue[target], queue[index]];

  if (selectedQueueIndex === index) selectedQueueIndex = target;
  else if (selectedQueueIndex === target) selectedQueueIndex = index;

  renderQueue();
}

function removeQueueItem(index) {
  queue.splice(index, 1);

  if (selectedQueueIndex === index) selectedQueueIndex = -1;
  else if (selectedQueueIndex > index) selectedQueueIndex--;

  renderQueue();
}

async function removeLibraryTrack(id) {
  const inUse = Object.values(decks).some(deck => deck.trackId === id);

  if (inUse) {
    notify("Eject this track from its deck before deleting it.");
    return;
  }

  if (!confirm("Permanently remove this audio file from your LOOP library?")) return;

  await deleteTrack(id);
  queue = queue.filter(item => item !== id);

  if (selectedQueueIndex >= queue.length) selectedQueueIndex = queue.length - 1;

  await refreshLibrary();
  renderQueue();
  notify("Track deleted.");
}

async function loadTrack(deckId, trackId) {
  ensureAudioEngine();

  const track = await getTrack(trackId);
  if (!track) {
    notify("That track is no longer in your library.");
    return;
  }

  const deck = decks[deckId];
  const audio = deck.audio;

  audio.pause();

  if (deck.objectURL) URL.revokeObjectURL(deck.objectURL);

  deck.objectURL = URL.createObjectURL(track.blob);
  deck.trackId = trackId;
  deck.cue = 0;
  deck.peaks = [];

  audio.src = deck.objectURL;
  audio.load();

  $(`title${deckId}`).textContent = track.name;
  $(`detail${deckId}`).textContent = `${track.filename} · ${formatBytes(track.size)}`;
  $(`status${deckId}`).textContent = "LOADING";
  $(`status${deckId}`).classList.remove("playing");

  try {
    const buffer = await track.blob.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(buffer);
    deck.peaks = makeWaveformPeaks(decoded, 700);
    drawTimeline(deckId);
  } catch (error) {
    console.warn("Waveform decoding failed:", error);
    deck.peaks = [];
    drawTimeline(deckId);
  }

  notify(`Loaded ${track.name} into Deck ${deckId}.`);
}

function makeWaveformPeaks(audioBuffer, count) {
  const channel = audioBuffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(channel.length / count));
  const peaks = [];

  for (let i = 0; i < count; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, channel.length);
    let peak = 0;

    for (let j = start; j < end; j++) {
      peak = Math.max(peak, Math.abs(channel[j]));
    }

    peaks.push(peak);
  }

  return peaks;
}

function playDeck(id) {
  const deck = decks[id];

  if (!deck.trackId) {
    notify(`Load a track into Deck ${id} first.`);
    return;
  }

  ensureAudioEngine();
  audioContext.resume();

  deck.audio.play().catch(error => {
    console.error(error);
    notify("Playback could not start. Try pressing play again.");
  });
}

function pauseDeck(id) {
  decks[id].audio.pause();
}

function stopDeck(id) {
  const deck = decks[id];
  deck.audio.pause();
  deck.audio.currentTime = 0;
  deck.cue = 0;
  updateDeckDisplay(id);
}

function cueDeck(id) {
  const deck = decks[id];

  if (!deck.trackId) {
    notify(`Load a track into Deck ${id} first.`);
    return;
  }

  if (!deck.audio.paused) {
    deck.cue = deck.audio.currentTime;
    deck.audio.pause();
    notify(`Cue point set at ${formatTime(deck.cue)}.`);
  } else {
    deck.audio.currentTime = deck.cue || 0;
    notify(`Returned to cue point ${formatTime(deck.cue)}.`);
  }
}

function seekDeck(id, seconds) {
  const audio = decks[id].audio;
  if (!decks[id].trackId || !Number.isFinite(audio.duration)) return;

  audio.currentTime = Math.max(
    0,
    Math.min(audio.duration, audio.currentTime + seconds)
  );
}

function ejectDeck(id) {
  const deck = decks[id];
  deck.audio.pause();
  deck.audio.removeAttribute("src");
  deck.audio.load();

  if (deck.objectURL) URL.revokeObjectURL(deck.objectURL);

  deck.objectURL = null;
  deck.trackId = null;
  deck.cue = 0;
  deck.peaks = [];

  $(`title${id}`).textContent = "No track loaded";
  $(`detail${id}`).textContent = "Import music or select a library track";
  $(`status${id}`).textContent = "EMPTY";
  $(`play${id}`).textContent = "▶";
  $(`time${id}`).textContent = "00:00";
  $(`elapsed${id}`).textContent = "00:00";
  $(`duration${id}`).textContent = "00:00";
  $(`vinyl${id}`).classList.remove("playing");

  drawTimeline(id);
}

function updateDeckDisplay(id) {
  const deck = decks[id];
  const audio = deck.audio;

  if (!deck.trackId) return;

  const current = audio.currentTime || 0;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;

  $(`time${id}`).textContent = formatTime(current);
  $(`elapsed${id}`).textContent = formatTime(current);
  $(`duration${id}`).textContent = formatTime(duration);

  drawTimeline(id);
}

function drawTimeline(id) {
  const canvas = $(`timeline${id}`);
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, rect.width);
  const height = 42;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = "#111318";
  ctx.fillRect(0, 0, width, height);

  const peaks = decks[id].peaks;
  const audio = decks[id].audio;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const progress = duration > 0 ? audio.currentTime / duration : 0;

  if (peaks.length) {
    const step = width / peaks.length;

    peaks.forEach((peak, index) => {
      const barHeight = Math.max(2, peak * 34);
      const x = index * step;
      const played = index / peaks.length <= progress;

      ctx.fillStyle = played ? "#b6f36b" : "#56604d";
      ctx.fillRect(x, (height - barHeight) / 2, Math.max(1, step - 1), barHeight);
    });
  } else {
    ctx.fillStyle = "#30343c";
    ctx.fillRect(0, height / 2 - 1, width, 2);
  }

  if (duration > 0) {
    const x = progress * width;
    ctx.fillStyle = "#fff";
    ctx.fillRect(x - 1, 0, 2, height);
  }
}

function drawSpectrum(id) {
  const canvas = $(`visual${id}`);
  const ctx = canvas.getContext("2d");
  const analyser = decks[id].nodes?.analyser;

  if (!analyser) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, rect.width);
  const height = 100;

  if (canvas.width !== Math.floor(width * dpr) ||
      canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);

  const bars = 48;
  const gap = 3;
  const barWidth = Math.max(1, (width - (bars - 1) * gap) / bars);

  for (let i = 0; i < bars; i++) {
    const sampleIndex = Math.floor(i * data.length / bars);
    const value = data[sampleIndex] / 255;
    const barHeight = Math.max(2, value * height * 0.9);

    ctx.fillStyle = `rgba(182,243,107,${0.35 + value * 0.65})`;
    ctx.fillRect(
      i * (barWidth + gap),
      height - barHeight,
      barWidth,
      barHeight
    );
  }
}

function applyMixer() {
  if (!audioContext || !masterGain) return;

  const cross = Number($("crossfader").value) / 100;
  const master = Number($("master").value) / 100;

  const gains = {
    A: Math.cos(cross * Math.PI / 2),
    B: Math.sin(cross * Math.PI / 2)
  };

  ["A", "B"].forEach(id => {
    const nodes = decks[id].nodes;
    if (!nodes) return;

    const level = Number($(`level${id}`).value) / 100;
    nodes.channelGain.gain.setTargetAtTime(
      gains[id] * level,
      audioContext.currentTime,
      0.015
    );
  });

  masterGain.gain.setTargetAtTime(master, audioContext.currentTime, 0.015);

  const a = decks.A.audio;
  const b = decks.B.audio;
  const peak = Math.max(
    a.paused ? 0 : Number($("levelA").value) * gains.A,
    b.paused ? 0 : Number($("levelB").value) * gains.B
  );

  $("masterMeter").style.height = `${peak * master}%`;
}

function applyEQ(id) {
  const nodes = decks[id].nodes;
  if (!nodes) return;

  nodes.bass.gain.value = Number($(`bass${id}`).value);
  nodes.mid.gain.value = Number($(`mid${id}`).value);
  nodes.treble.gain.value = Number($(`treble${id}`).value);

  ["bass", "mid", "treble"].forEach(name => {
    $(`${name}Read${id}`).textContent = `${$(`${name}${id}`).value} dB`;
  });
}

function applyPitch(id) {
  const value = Number($(`pitch${id}`).value);
  decks[id].audio.playbackRate = 1 + value / 100;
  $(`pitchRead${id}`).textContent = `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function applyEffects() {
  if (!audioContext) return;

  const filter = Number($("filter").value);
  const echo = Number($("echo").value) / 100;
  const reverb = Number($("reverb").value) / 100;

  ["A", "B"].forEach(id => {
    const nodes = decks[id].nodes;
    if (nodes) {
      nodes.filter.frequency.setTargetAtTime(filter, audioContext.currentTime, 0.03);
    }
  });

  delayWet.gain.setTargetAtTime(echo * 0.65, audioContext.currentTime, 0.03);
  reverbWet.gain.setTargetAtTime(reverb * 0.65, audioContext.currentTime, 0.03);

  $("filterRead").textContent = filter >= 1000
    ? `${(filter / 1000).toFixed(1)} kHz`
    : `${filter} Hz`;

  $("echoRead").textContent = `${Math.round(echo * 100)}%`;
  $("reverbRead").textContent = `${Math.round(reverb * 100)}%`;
}

async function saveSet() {
  if (!queue.length) {
    notify("Add tracks to your set first.");
    return;
  }

  const name = prompt("Name this DJ set:");
  if (!name?.trim()) return;

  const set = {
    id: crypto.randomUUID(),
    name: name.trim(),
    tracks: [...queue],
    saved: Date.now()
  };

  await putSet(set);
  await refreshSets();
  $("savedSets").value = set.id;
  notify(`Saved set: ${set.name}`);
}

async function refreshSets() {
  const sets = await getAllSets();
  const select = $("savedSets");
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "LOAD SAVED SET…";
  select.appendChild(placeholder);

  sets.sort((a, b) => b.saved - a.saved);

  sets.forEach(set => {
    const option = document.createElement("option");
    option.value = set.id;
    option.textContent = set.name;
    select.appendChild(option);
  });
}

async function loadSet(id) {
  if (!id) return;

  const sets = await getAllSets();
  const set = sets.find(item => item.id === id);
  if (!set) return;

  const existing = new Set(library.map(track => track.id));
  queue = set.tracks.filter(trackId => existing.has(trackId));
  selectedQueueIndex = queue.length ? 0 : -1;

  renderQueue();
  notify(`Loaded set: ${set.name}`);
}

async function removeSet() {
  const id = $("savedSets").value;
  if (!id) {
    notify("Choose a saved set first.");
    return;
  }

  const sets = await getAllSets();
  const set = sets.find(item => item.id === id);

  if (!confirm(`Delete saved set "${set?.name || "Untitled"}"?`)) return;

  await deleteSet(id);
  await refreshSets();
  notify("Saved set deleted.");
}

function setupDeck(id) {
  const audio = decks[id].audio;

  $(`play${id}`).addEventListener("click", () => {
    if (audio.paused) playDeck(id);
    else pauseDeck(id);
  });

  $(`stop${id}`).addEventListener("click", () => stopDeck(id));
  $(`cue${id}`).addEventListener("click", () => cueDeck(id));
  $(`back${id}`).addEventListener("click", () => seekDeck(id, -10));
  $(`forward${id}`).addEventListener("click", () => seekDeck(id, 10));
  $(`eject${id}`).addEventListener("click", () => ejectDeck(id));

  $(`loadQueue${id}`).addEventListener("click", () => {
    if (selectedQueueIndex < 0 || !queue[selectedQueueIndex]) {
      notify("Select a track in the set builder first.");
      return;
    }
    loadTrack(id, queue[selectedQueueIndex]);
  });

  $(`level${id}`).addEventListener("input", () => {
    $(`levelRead${id}`).textContent = `${$("level" + id).value}%`;
    applyMixer();
  });

  ["bass", "mid", "treble"].forEach(name => {
    $(`${name}${id}`).addEventListener("input", () => applyEQ(id));
  });

  $(`pitch${id}`).addEventListener("input", () => applyPitch(id));

  audio.addEventListener("play", () => {
    $(`play${id}`).textContent = "Ⅱ";
    $(`status${id}`).textContent = "PLAYING";
    $(`status${id}`).classList.add("playing");
    $(`vinyl${id}`).classList.add("playing");
    applyMixer();
  });

  audio.addEventListener("pause", () => {
    $(`play${id}`).textContent = "▶";
    $(`status${id}`).textContent = "PAUSED";
    $(`status${id}`).classList.remove("playing");
    $(`vinyl${id}`).classList.remove("playing");
    applyMixer();
  });

  audio.addEventListener("ended", () => {
    $(`status${id}`).textContent = "ENDED";
  });

  audio.addEventListener("loadedmetadata", () => updateDeckDisplay(id));
  audio.addEventListener("timeupdate", () => updateDeckDisplay(id));

  const timeline = $(`timeline${id}`);

  function seekFromPointer(event) {
    const rect = timeline.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));

    if (Number.isFinite(audio.duration)) {
      audio.currentTime = ratio * audio.duration;
    }
  }

  timeline.addEventListener("click", seekFromPointer);

  timeline.addEventListener("keydown", event => {
    if (event.key === "ArrowRight") seekDeck(id, 5);
    if (event.key === "ArrowLeft") seekDeck(id, -5);
  });
}

function animationLoop() {
  ["A", "B"].forEach(id => {
    drawSpectrum(id);
  });

  requestAnimationFrame(animationLoop);
}

function connectControls() {
  $("fileInput").addEventListener("change", event => {
    importFiles(event.target.files);
    event.target.value = "";
  });

  $("libraryInput").addEventListener("change", event => {
    importFiles(event.target.files);
    event.target.value = "";
  });

  $("crossfader").addEventListener("input", applyMixer);
  $("master").addEventListener("input", applyMixer);

  ["filter", "echo", "reverb"].forEach(id => {
    $(id).addEventListener("input", applyEffects);
  });

  $("saveSet").addEventListener("click", saveSet);
  $("clearQueue").addEventListener("click", () => {
    queue = [];
    selectedQueueIndex = -1;
    renderQueue();
  });

  $("savedSets").addEventListener("change", event => {
    loadSet(event.target.value);
  });

  $("deleteSet").addEventListener("click", removeSet);

  $("settingsButton").addEventListener("click", () => {
    notify("Audio processing runs locally in this browser.");
  });
}

async function init() {
  try {
    db = await openDatabase();
    await refreshLibrary();
    await refreshSets();

    ["A", "B"].forEach(setupDeck);
    connectControls();
    renderQueue();
    animationLoop();

    notify("LOOP audio engine ready.");
  } catch (error) {
    console.error(error);
    alert("LOOP could not initialize browser storage. Try another browser or check private browsing settings.");
  }
}

init();
