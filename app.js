const CONFIG = {
  clientId: "c5a19b58f9a84644a9419a758d9a3876",
  redirectUri: "https://studio-gh.github.io/no-skip-fm/",
  scopes: [
    "playlist-read-private",
    "playlist-read-collaborative",
    "streaming",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing"
  ]
};

const STORAGE = {
  access: "noskip_access_token",
  refresh: "noskip_refresh_token",
  expires: "noskip_expires_at",
  state: "noskip_oauth_state",
  verifier: "noskip_pkce_verifier"
};

const $ = (selector) => document.querySelector(selector);
const state = { playlists: [], currentPlaylist: null, currentTracks: [], selectedTrack: null, recordPlaced: false, player: null, deviceId: null, currentTrack: null, collectionView: new URLSearchParams(location.search).get("view") === "pile" ? "pile" : "shelf", pileRotation: 0, pileDrag: null, pileMoved: false, ignorePileClick: false, playerReady: null, resolvePlayerReady: null, playbackDuration: 0, playbackPosition: 0, playbackUpdatedAt: 0, playbackPaused: true, currentTrackIndex: -1, suppressPileClick: false, playlistRequestId: 0 };

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(length = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return base64url(bytes);
}
async function sha256(value) {
  return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}
function setStatus(message, kind = "") {
  const el = $("#status");
  el.textContent = message;
  el.dataset.kind = kind;
}
function saveTokens(data) {
  localStorage.setItem(STORAGE.access, data.access_token);
  if (data.refresh_token) localStorage.setItem(STORAGE.refresh, data.refresh_token);
  localStorage.setItem(STORAGE.expires, String(Date.now() + data.expires_in * 1000));
}
function clearTokens() {
  Object.values(STORAGE).forEach((key) => localStorage.removeItem(key));
  sessionStorage.removeItem(STORAGE.state);
  sessionStorage.removeItem(STORAGE.verifier);
}
async function login() {
  const verifier = randomString(64);
  const challenge = base64url(await sha256(verifier));
  const oauthState = randomString(24);
  sessionStorage.setItem(STORAGE.verifier, verifier);
  sessionStorage.setItem(STORAGE.state, oauthState);

  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: "code",
    redirect_uri: CONFIG.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state: oauthState,
    scope: CONFIG.scopes.join(" ")
  }).toString();
  window.location.assign(url);
}
async function exchangeCode(code) {
  const verifier = sessionStorage.getItem(STORAGE.verifier);
  const expectedState = sessionStorage.getItem(STORAGE.state);
  const returnedState = new URLSearchParams(location.search).get("state");
  if (!verifier || !expectedState || returnedState !== expectedState) {
    throw new Error("Spotify sign-in could not be verified. Please connect again.");
  }
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CONFIG.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: CONFIG.redirectUri,
      code_verifier: verifier
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || "Could not complete Spotify sign-in.");
  saveTokens(data);
  sessionStorage.removeItem(STORAGE.verifier);
  sessionStorage.removeItem(STORAGE.state);
}
async function getAccessToken(forceRefresh = false) {
  const token = localStorage.getItem(STORAGE.access);
  const expiresAt = Number(localStorage.getItem(STORAGE.expires) || 0);
  if (!forceRefresh && token && Date.now() < expiresAt - 60000) return token;

  const refreshToken = localStorage.getItem(STORAGE.refresh);
  if (!refreshToken) throw new Error("Your Spotify session has expired. Connect Spotify again.");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CONFIG.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  const data = await response.json();
  if (!response.ok) {
    clearTokens();
    throw new Error(data.error_description || "Spotify session expired. Please connect again.");
  }
  saveTokens(data);
  return data.access_token;
}
async function spotify(path, options = {}, retry = true) {
  const token = await getAccessToken();
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && retry) {
    await getAccessToken(true);
    return spotify(path, options, false);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Spotify API error (${response.status})`);
  }
  if (response.status === 204) return null;
  return response.json();
}
async function loadPlaylists() {
  setStatus("Finding your records…");
  const all = [];
  let url = "/me/playlists?limit=50";
  while (url) {
    const page = await spotify(url);
    all.push(...(page.items || []));
    url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
  }
  state.playlists = all;
  renderPlaylists();
  setCollectionView(state.collectionView, false);
  setStatus(`${all.length} collections ready`, "success");
}
function imageFor(item) {
  return item?.images?.[0]?.url || "";
}

function setCollectionView(view, updateUrl = true) {
  state.collectionView = view === "pile" ? "pile" : "shelf";
  document.querySelectorAll(".view-tab").forEach((tab) => {
    const active = tab.dataset.view === state.collectionView;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  const shelf = $("#shelf");
  shelf.classList.toggle("pile-view", state.collectionView === "pile");
  shelf.classList.toggle("shelf-view", state.collectionView === "shelf");
  if (state.collectionView === "shelf") {
    // Pile positioning is written inline for smooth dragging. Always clear it
    // when returning to the grid so the two layouts never contaminate each other.
    shelf.querySelectorAll(".record-card").forEach((card) => {
      card.style.removeProperty("transform");
      card.style.removeProperty("z-index");
      card.style.removeProperty("opacity");
      card.style.removeProperty("--orbit-depth");
    });
  }
  if (updateUrl) {
    const url = new URL(location.href);
    if (state.collectionView === "pile") url.searchParams.set("view", "pile");
    else url.searchParams.delete("view");
    history.replaceState({}, "", url);
  }
  if (state.collectionView === "pile") renderPileOrbit();
}
function renderPileOrbit() {
  if (state.collectionView !== "pile") return;
  const stage = $("#shelf");
  const cards = [...stage.querySelectorAll(".record-card")];
  if (!cards.length) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const rx = Math.max(120, width * 0.435);
  const ry = Math.max(145, height * 0.405);
  const count = cards.length;
  cards.forEach((card, index) => {
    const angle = ((index / count) * Math.PI * 2) + (state.pileRotation * Math.PI / 180) - Math.PI / 2;
    const x = Math.cos(angle) * rx;
    const y = Math.sin(angle) * ry;
    let rotation = (angle * 180 / Math.PI) + 90;
    while (rotation > 90) rotation -= 180;
    while (rotation < -90) rotation += 180;
    const depth = (Math.sin(angle) + 1) / 2;
    const scale = 0.72 + depth * 0.31;
    card.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${rotation}deg) scale(${scale})`;
    card.style.zIndex = String(Math.round(depth * 100));
    card.style.opacity = String(0.68 + depth * 0.32);
    card.style.setProperty("--orbit-depth", depth.toFixed(3));
    card.setAttribute("aria-label", `Open playlist: ${card.querySelector(".record-name")?.textContent || "playlist"}`);
  });
}

function renderPlaylists() {
  const shelf = $("#shelf");
  shelf.innerHTML = "";
  if (!state.playlists.length) {
    shelf.innerHTML = '<p class="empty">No playlists found on this account yet.</p>';
    return;
  }
  state.playlists.forEach((playlist, index) => {
    const card = document.createElement("button");
    card.className = "record-card";
    card.dataset.playlistId = playlist.id;
    card.dataset.name = playlist.name;
    card.setAttribute("aria-pressed", String(state.currentPlaylist?.id === playlist.id));
    card.style.setProperty("--tilt", `${(index % 5 - 2) * 1.4}deg`);
    card.style.setProperty("--i", index);
    card.innerHTML = `
      <span class="sleeve"><img src="${imageFor(playlist) || "./assets/studio-gh-mark.svg"}" alt="" loading="lazy"><span class="disc"></span></span>
      <span class="record-name"></span>
      <span class="record-meta">${playlist.items?.total ?? playlist.tracks?.total ?? "—"} tracks</span>`;
    card.querySelector(".record-name").textContent = playlist.name;
    card.addEventListener("click", (event) => {
      if (state.suppressPileClick) { event.preventDefault(); state.suppressPileClick = false; return; }
      openPlaylist(playlist);
    });
    shelf.append(card);
  });
}
async function openPlaylist(playlist) {
  const requestId = ++state.playlistRequestId;
  state.currentPlaylist = playlist;
  document.querySelectorAll(".record-card").forEach((card) => {
    const active = card.dataset.playlistId === playlist.id;
    card.classList.toggle("is-selected", active);
    card.setAttribute("aria-pressed", String(active));
  });
  // Prime Spotify audio while this playlist click is still a direct user gesture.
  if (state.player) state.player.activateElement().catch(() => {});
  state.recordPlaced = true;
  $("#turntable").classList.add("record-placed");
  $("#record-stack").classList.add("record-pulled");
  $("#return-record").disabled = false;
  $("#collection-title").textContent = playlist.name;
  $("#collection-subtitle").textContent = "Loading the grooves…";
  $("#tracks").innerHTML = "";
  $("#collection").hidden = false;
  $("#collection").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const all = [];
    let url = `/playlists/${encodeURIComponent(playlist.id)}/items?limit=50&fields=items(item(name,uri,artists(name),album(name,images),duration_ms,type,is_playable)),next,total`;
    while (url) {
      const page = await spotify(url);
      if (requestId !== state.playlistRequestId) return;
      all.push(...(page.items || []).map((entry) => entry.item).filter((item) => item?.type === "track" && item.is_playable !== false));
      url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
    }
    if (requestId !== state.playlistRequestId) return;
    state.currentTracks = all;
    state.currentTrackIndex = all.length ? 0 : -1;
    state.selectedTrack = all[0] || null;
    $("#collection-subtitle").textContent = `${all.length} tracks · selected collection`;
    renderTracks(all);
    $("#booth").hidden = false;
    $("#booth-title").textContent = playlist.name;
    $("#booth-caption").textContent = `${all.length} tracks in this collection`;
    $("#booth-cover").src = imageFor(playlist) || "./assets/studio-gh-mark.svg";
    $("#vinyl-label").src = imageFor(playlist) || "./assets/studio-gh-mark.svg";
    $("#vinyl-label-text").textContent = playlist.name;
    $("#booth").scrollIntoView({ behavior: "smooth", block: "center" });
    if (state.selectedTrack) await playTrack(state.selectedTrack);
    else $("#booth-caption").textContent = "No playable tracks in this playlist.";
  } catch (error) {
    if (requestId !== state.playlistRequestId) return;
    $("#collection-subtitle").textContent = error.message;
  }
}
function renderTracks(tracks) {
  const list = $("#tracks");
  list.innerHTML = "";
  tracks.forEach((track, index) => {
    const row = document.createElement("button");
    row.className = "track-row";
    const cover = imageFor(track.album);
    row.innerHTML = `
      <span class="track-index">${String(index + 1).padStart(2, "0")}</span>
      <img class="track-cover" src="${cover || "./assets/studio-gh-mark.svg"}" alt="" loading="lazy">
      <span class="track-copy"><strong></strong><small></small></span>
      <span class="track-play">PLAY ↗</span>`;
    row.querySelector("strong").textContent = track.name;
    row.querySelector("small").textContent = (track.artists || []).map((artist) => artist.name).join(", ");
    row.dataset.trackIndex = String(index);
    row.addEventListener("click", () => {
      state.currentTrackIndex = index;
      state.selectedTrack = track;
      state.recordPlaced = true;
      $("#turntable").classList.add("record-placed", "needle-down");
      $("#record-stack").classList.add("record-pulled");
      $("#return-record").disabled = false;
      $("#booth-caption").textContent = `Now playing · ${track.name}`;
      markActiveTrack(track.uri);
      $("#now-title").textContent = track.name;
      $("#now-artist").textContent = (track.artists || []).map((artist) => artist.name).join(", ");
      $("#now-cover").src = cover || "./assets/studio-gh-mark.svg";
      playTrack(track);
    });
    list.append(row);
  });
}

function markActiveTrack(uri) {
  document.querySelectorAll(".track-row").forEach((row) => {
    const index = Number(row.dataset.trackIndex);
    const active = state.currentTracks[index]?.uri === uri;
    row.classList.toggle("is-playing", active);
    const label = row.querySelector(".track-play");
    if (label) label.textContent = active ? "NOW PLAYING" : "PLAY ↗";
  });
}
function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function updateProgressUI() {
  const progress = $("#progress");
  if (!progress) return;
  const duration = state.playbackDuration || 0;
  const livePosition = state.playbackPosition + (!state.playbackPaused ? Date.now() - state.playbackUpdatedAt : 0);
  const position = Math.min(livePosition || 0, duration);
  progress.value = duration ? String(Math.round(position / duration * 1000)) : "0";
  $("#elapsed").textContent = formatTime(position);
  $("#duration").textContent = formatTime(duration);
}

function loadPlaybackSdk() {
  if (window.Spotify) return Promise.resolve();
  return new Promise((resolve) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.head.append(script);
  });
}
async function connectPlayer() {
  await loadPlaybackSdk();
  state.playerReady = new Promise((resolve) => { state.resolvePlayerReady = resolve; });
  const player = new Spotify.Player({
    name: "No.Skip.FM",
    volume: 0.78,
    getOAuthToken: async (callback) => {
      try { callback(await getAccessToken()); }
      catch (error) { setStatus(error.message, "error"); }
    }
  });
  player.addListener("ready", ({ device_id }) => {
    state.deviceId = device_id;
    state.resolvePlayerReady?.(device_id);
    state.resolvePlayerReady = null;
    $("#player-state").textContent = "PLAYER READY";
    setStatus("Turntable connected", "success");
  });
  player.addListener("not_ready", () => {
    state.deviceId = null;
    $("#player-state").textContent = "PLAYER OFFLINE";
  });
  player.addListener("player_state_changed", (playback) => {
    if (!playback) return;
    const track = playback.track_window.current_track;
    state.playbackDuration = playback.duration || 0;
    state.playbackPosition = playback.position || 0;
    state.playbackUpdatedAt = Date.now();
    state.playbackPaused = playback.paused;
    state.currentTrackIndex = state.currentTracks.findIndex((item) => item.uri === track.uri);
    state.selectedTrack = state.currentTracks[state.currentTrackIndex] || state.selectedTrack;
    $("#turntable").classList.toggle("is-playing", !playback.paused);
    $("#turntable").classList.toggle("needle-down", !playback.paused);
    $("#booth-caption").textContent = playback.paused ? "Paused · ready when you are." : "Now playing · enjoy the record.";
    markActiveTrack(track.uri);
    updateProgressUI();
    $("#now-title").textContent = track.name;
    $("#now-artist").textContent = track.artists.map((artist) => artist.name).join(", ");
    $("#now-cover").src = track.album.images?.[0]?.url || "./assets/studio-gh-mark.svg";
    $("#play-toggle").textContent = playback.paused ? "▶" : "Ⅱ";
  });
  player.addListener("initialization_error", ({ message }) => setStatus(message, "error"));
  player.addListener("authentication_error", ({ message }) => setStatus(message, "error"));
  player.addListener("account_error", ({ message }) => setStatus(message, "error"));
  player.addListener("playback_error", ({ message }) => setStatus(message, "error"));
  player.addListener("autoplay_failed", () => setStatus("Tap Play to start audio in this browser.", "error"));
  state.player = player;
  await player.connect();
}
async function playTrack(track) {
  try {
    if (!state.player) throw new Error("Spotify player is not connected yet.");
    if (!state.deviceId && state.playerReady) {
      await Promise.race([state.playerReady, new Promise((_, reject) => setTimeout(() => reject(new Error("The Spotify player is still connecting. Try again in a moment.")), 12000))]);
    }
    if (!state.deviceId) throw new Error("The Spotify player is offline. Reconnect Spotify and try again.");
    await state.player.activateElement();
    await spotify(`/me/player/play?device_id=${encodeURIComponent(state.deviceId)}`, {
      method: "PUT",
      body: JSON.stringify({ uris: [track.uri] })
    });
    $("#turntable").classList.add("record-placed", "needle-down", "is-playing");
    $("#play-toggle").textContent = "Ⅱ";
    markActiveTrack(track.uri);
    setStatus("Needle down. Enjoy the record.", "success");
  } catch (error) { setStatus(error.message, "error"); }
}
async function stepPlaylistTrack(direction) {
  if (!state.currentTracks.length) {
    if (direction < 0) state.player?.previousTrack();
    else state.player?.nextTrack();
    return;
  }
  const current = state.currentTrackIndex >= 0 ? state.currentTrackIndex : 0;
  const next = (current + direction + state.currentTracks.length) % state.currentTracks.length;
  state.currentTrackIndex = next;
  state.selectedTrack = state.currentTracks[next];
  markActiveTrack(state.selectedTrack.uri);
  await playTrack(state.selectedTrack);
}
async function togglePlayback() {
  try {
    if (!state.player) return;
    await state.player.activateElement();
    await state.player.togglePlay();
  } catch (error) { setStatus(error.message, "error"); }
}
function showConnected() {
  $("#connect-button").hidden = true;
  $("#disconnect-button").hidden = false;
  $("#library").hidden = false;
  $("#player").hidden = false;
}
async function boot() {
  $("#connect-button").addEventListener("click", login);
  $("#disconnect-button").addEventListener("click", () => {
    state.player?.disconnect();
    state.player = null;
    state.deviceId = null;
    clearTokens();
    $("#connect-button").hidden = false;
    $("#disconnect-button").hidden = true;
    $("#library").hidden = true;
    $("#player").hidden = true;
    setStatus("Spotify disconnected");
  });
  $("#play-toggle").addEventListener("click", togglePlayback);
  $("#progress").addEventListener("input", (event) => {
    if (!state.playbackDuration) return;
    const preview = Math.round((Number(event.target.value) / 1000) * state.playbackDuration);
    $("#elapsed").textContent = formatTime(preview);
  });
  $("#progress").addEventListener("change", async (event) => {
    if (!state.player || !state.playbackDuration) return;
    const target = Math.round((Number(event.target.value) / 1000) * state.playbackDuration);
    try { await state.player.seek(target); state.playbackPosition = target; updateProgressUI(); }
    catch (error) { setStatus(error.message, "error"); }
  });
  $("#return-record").addEventListener("click", () => {
    state.recordPlaced = false;
    $("#turntable").classList.remove("record-placed", "needle-down", "is-playing");
    $("#record-stack").classList.remove("record-pulled");
    $("#return-record").disabled = true;
    $("#booth-caption").textContent = "Record returned to its sleeve. Playback continues in the player below.";
  });
  document.querySelectorAll(".view-tab").forEach((tab) => tab.addEventListener("click", () => setCollectionView(tab.dataset.view)));
  const pile = $("#shelf");
  pile.addEventListener("pointerover", (event) => {
    if (state.collectionView !== "pile") return;
    const card = event.target.closest(".record-card");
    if (card) $("#pile-hover-label").textContent = card.dataset.name || "Your collection";
  });
  pile.addEventListener("pointerleave", () => { $("#pile-hover-label").textContent = "DRAG TO EXPLORE · SELECT A SLEEVE"; });
  pile.addEventListener("pointerdown", (event) => {
    if (state.collectionView !== "pile" || !event.isPrimary || event.button !== 0) return;
    state.pileDrag = {
      x: event.clientX,
      y: event.clientY,
      rotation: state.pileRotation,
      pointerId: event.pointerId,
      target: event.target.closest(".record-card")
    };
    state.pileMoved = false;
  });
  window.addEventListener("pointermove", (event) => {
    if (!state.pileDrag || event.pointerId !== state.pileDrag.pointerId) return;
    const dx = event.clientX - state.pileDrag.x;
    const dy = event.clientY - state.pileDrag.y;
    if (Math.hypot(dx, dy) > 7) state.pileMoved = true;
    if (state.pileMoved) {
      state.pileRotation = state.pileDrag.rotation + dx * 0.48;
      renderPileOrbit();
    }
  });
  window.addEventListener("pointerup", (event) => {
    if (!state.pileDrag || event.pointerId !== state.pileDrag.pointerId) return;
    if (state.pileMoved) {
      state.suppressPileClick = true;
      window.setTimeout(() => { state.suppressPileClick = false; }, 220);
    }
    state.pileDrag = null;
  });
  window.addEventListener("pointercancel", () => { state.pileDrag = null; });
  pile.addEventListener("wheel", (event) => {
    if (state.collectionView !== "pile") return;
    event.preventDefault();
    state.pileRotation += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * 0.12;
    renderPileOrbit();
  }, { passive: false });
  window.addEventListener("resize", () => { if (state.collectionView === "pile") renderPileOrbit(); });
  pile.addEventListener("keydown", (event) => {
    if (state.collectionView !== "pile") return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      state.pileRotation += event.key === "ArrowRight" ? -18 : 18;
      renderPileOrbit();
    }
  });
  $("#previous").addEventListener("click", () => stepPlaylistTrack(-1));
  $("#next").addEventListener("click", () => stepPlaylistTrack(1));
  $("#volume").addEventListener("input", (event) => state.player?.setVolume(Number(event.target.value) / 100));

  window.setInterval(() => { if (!state.playbackPaused) updateProgressUI(); }, 250);

  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const oauthError = params.get("error");
  if (oauthError) {
    history.replaceState({}, document.title, CONFIG.redirectUri);
    setStatus(oauthError === "access_denied" ? "Spotify access was cancelled." : oauthError, "error");
    return;
  }
  if (code) {
    try {
      setStatus("Finishing Spotify sign-in…");
      await exchangeCode(code);
      history.replaceState({}, document.title, CONFIG.redirectUri);
    } catch (error) {
      history.replaceState({}, document.title, CONFIG.redirectUri);
      setStatus(error.message, "error");
      return;
    }
  }
  if (localStorage.getItem(STORAGE.refresh)) {
    try {
      await getAccessToken();
      showConnected();
      await Promise.all([loadPlaylists(), connectPlayer()]);
    } catch (error) {
      setStatus(error.message, "error");
    }
  }
}
boot();
