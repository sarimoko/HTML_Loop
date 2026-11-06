
const decks = {
  A: { player: null, ready: false, loaded: false },
  B: { player: null, ready: false, loaded: false }
};

let apiKey = "";
let queue = [];

function extractYouTubeId(input) {
  try {
    const url = new URL(input);

    if (url.hostname === "youtu.be") {
      return url.pathname.slice(1);
    }

    return url.searchParams.get("v") ||
      url.pathname.match(/(?:embed|shorts|live)\/([^/?]+)/)?.[1] ||
      null;
  } catch {
    return null;
  }
}

function extractPlaylistId(input) {
  try {
    return new URL(input).searchParams.get("list");
  } catch {
    return null;
  }
}

function onYouTubeIframeAPIReady() {
  ["A", "B"].forEach(id => {
    decks[id].player = new YT.Player("player" + id, {
      height: "200",
      width: "200",
      playerVars: {
        playsinline: 1,
        controls: 0,
        disablekb: 1,
        rel: 0
      },
      events: {
        onReady: () => {
          decks[id].ready = true;
          updateStatus(id, "READY");
          applyVolumes();
        },
        onStateChange: event => handlePlayerState(id, event)
      }
    });
  });
}

window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function updateStatus(id, status) {
  document.getElementById("state" + id).textContent = status;
}

function setTrackInfo(id, title) {
  document.getElementById("title" + id).textContent = title;
  document.getElementById("artist" + id).textContent =
    "YouTube · Deck " + id;
}

function handlePlayerState(id, event) {
  const vinyl = document.getElementById("vinyl" + id);
  const playButton = document.getElementById("play" + id);

  if (event.data === YT.PlayerState.PLAYING) {
    vinyl.classList.add("playing");
    playButton.textContent = "Ⅱ";
    updateStatus(id, "PLAYING");
  } else {
    vinyl.classList.remove("playing");
    playButton.textContent = "▶";

    if (event.data === YT.PlayerState.PAUSED) {
      updateStatus(id, "PAUSED");
    }

    if (event.data === YT.PlayerState.ENDED) {
      updateStatus(id, "ENDED");
    }
  }
}

async function loadDeck(id) {
  const input = document.getElementById("search" + id).value.trim();

  if (!input) return;

  const player = decks[id].player;

  if (!decks[id].ready) {
    alert("The YouTube player is still initializing.");
    return;
  }

  const videoId = extractYouTubeId(input);
  const playlistId = extractPlaylistId(input);

  if (playlistId) {
    player.loadPlaylist({
      listType: "playlist",
      list: playlistId,
      index: 0
    });

    setTrackInfo(id, "YouTube Playlist");
    decks[id].loaded = true;
    addToQueue(id, "Playlist: " + playlistId);
    return;
  }

  if (videoId) {
    player.loadVideoById(videoId);
    setTrackInfo(id, "YouTube Track");
    decks[id].loaded = true;
    addToQueue(id, "YouTube video: " + videoId);
    return;
  }

  await searchYouTube(id, input);
}

async function searchYouTube(id, query) {
  if (!apiKey) {
    alert("Text search requires a YouTube Data API key. Paste a YouTube URL instead, or add your API key in Settings.");
    return;
  }

  try {
    const endpoint = new URL(
      "https://www.googleapis.com/youtube/v3/search"
    );

    endpoint.search = new URLSearchParams({
      part: "snippet",
      type: "video",
      maxResults: "5",
      q: query,
      key: apiKey
    });

    const response = await fetch(endpoint);

    if (!response.ok) {
      throw new Error("YouTube search failed: " + response.status);
    }

    const data = await response.json();

    if (!data.items?.length) {
      alert("No matching tracks found.");
      return;
    }

    const results = data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title
    }));

    showSearchResults(id, results);
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
}

function showSearchResults(id, results) {
  const choice = prompt(
    results.map((item, index) =>
      `${index + 1}. ${item.title}`
    ).join("\n") + "\n\nEnter a result number:"
  );

  const index = Number(choice) - 1;

  if (!Number.isInteger(index) || !results[index]) return;

  const selected = results[index];

  decks[id].player.loadVideoById(selected.id);
  decks[id].loaded = true;
  setTrackInfo(id, selected.title);
  addToQueue(id, selected.title);
}

function addToQueue(deck, title) {
  queue.push({ deck, title });
  renderQueue();
}

function renderQueue() {
  const container = document.getElementById("queue");
  container.innerHTML = "";

  queue.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "queue-item";

    const title = document.createElement("span");
    title.textContent = item.title;

    const deck = document.createElement("span");
    deck.textContent = "DECK " + item.deck;

    row.append(title, deck);
    container.appendChild(row);
  });
}

function togglePlay(id) {
  const player = decks[id].player;

  if (!decks[id].loaded) {
    alert("Load a track first.");
    return;
  }

  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    player.pauseVideo();
  } else {
    player.playVideo();
  }
}

function stopDeck(id) {
  const player = decks[id].player;
  if (player && decks[id].loaded) {
    player.stopVideo();
  }
}

function cueDeck(id) {
  const player = decks[id].player;
  if (player && decks[id].loaded) {
    player.pauseVideo();
    player.seekTo(0, true);
  }
}

function seekDeck(id, seconds) {
  const player = decks[id].player;

  if (player && decks[id].loaded) {
    const current = player.getCurrentTime();
    const duration = player.getDuration();

    player.seekTo(
      Math.max(0, Math.min(duration, current + seconds)),
      true
    );
  }
}

function getChannelLevel(id) {
  return Number(document.getElementById("fader" + id).value) *
    Number(document.getElementById("gain" + id).value) / 100;
}

function applyVolumes() {
  const crossfader =
    Number(document.getElementById("crossfader").value) / 100;

  const master =
    Number(document.getElementById("master").value) / 100;

  // Equal-power crossfade.
  const volumeA = Math.cos(crossfader * Math.PI / 2);
  const volumeB = Math.sin(crossfader * Math.PI / 2);

  const finalA = getChannelLevel("A") * volumeA * master;
  const finalB = getChannelLevel("B") * volumeB * master;

  if (decks.A.ready) {
    decks.A.player.setVolume(Math.round(finalA));
  }

  if (decks.B.ready) {
    decks.B.player.setVolume(Math.round(finalB));
  }

  document.getElementById("masterMeter").style.height =
    Math.max(finalA, finalB) + "%";
}

function drawWaveform(canvasId, phase) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;

    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = "#b6f36b";
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let x = 0; x < width; x++) {
      const y = height / 2 +
        Math.sin((x + phase) * 0.08) *
        Math.sin((x + phase) * 0.025) *
        height * 0.32;

      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();
  }

  draw();
}

function updateTime(id) {
  const player = decks[id].player;
  if (!player || !decks[id].ready || !decks[id].loaded) return;

  const time = Math.floor(player.getCurrentTime() || 0);
  const minutes = String(Math.floor(time / 60)).padStart(2, "0");
  const seconds = String(time % 60).padStart(2, "0");

  document.getElementById("time" + id).textContent =
    `${minutes}:${seconds}`;
}

function connectControls() {
  ["A", "B"].forEach(id => {
    document.getElementById("load" + id)
      .addEventListener("click", () => loadDeck(id));

    document.getElementById("search" + id)
      .addEventListener("keydown", event => {
        if (event.key === "Enter") loadDeck(id);
      });

    document.getElementById("play" + id)
      .addEventListener("click", () => togglePlay(id));

    document.getElementById("stop" + id)
      .addEventListener("click", () => stopDeck(id));

    document.getElementById("cue" + id)
      .addEventListener("click", () => cueDeck(id));

    document.getElementById("back" + id)
      .addEventListener("click", () => seekDeck(id, -10));

    document.getElementById("forward" + id)
      .addEventListener("click", () => seekDeck(id, 10));

    ["gain", "fader"].forEach(control => {
      document.getElementById(control + id)
        .addEventListener("input", applyVolumes);
    });

    document.getElementById("pitch" + id)
      .addEventListener("input", event => {
        document.getElementById("pitchValue" + id).textContent =
          event.target.value + "%";
      });
  });

  ["crossfader", "master"].forEach(id => {
    document.getElementById(id)
      .addEventListener("input", applyVolumes);
  });

  document.getElementById("settingsButton").onclick = () => {
    document.getElementById("settingsModal").classList.remove("hidden");
  };

  document.getElementById("closeSettings").onclick = () => {
    document.getElementById("settingsModal").classList.add("hidden");
  };

  document.getElementById("saveSettings").onclick = () => {
    apiKey = document.getElementById("apiKey").value.trim();
    document.getElementById("settingsModal").classList.add("hidden");
    alert("API key saved for this browser session.");
  };
}

document.addEventListener("DOMContentLoaded", () => {
  connectControls();
  drawWaveform("waveA", 0);
  drawWaveform("waveB", 70);

  setInterval(() => {
    updateTime("A");
    updateTime("B");
  }, 500);
});
