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
const state = { playlists: [], currentPlaylist: null, player: null, deviceId: null, currentTrack: null };

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
  setStatus(`${all.length} collections ready`, "success");
}
function imageFor(item) {
  return item?.images?.[0]?.url || "";
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
    card.style.setProperty("--tilt", `${(index % 5 - 2) * 1.4}deg`);
    card.innerHTML = `
      <span class="sleeve"><img src="${imageFor(playlist) || "./assets/studio-gh-mark.svg"}" alt="" loading="lazy"><span class="disc"></span></span>
      <span class="record-name"></span>
      <span class="record-meta">${playlist.items?.total ?? playlist.tracks?.total ?? "—"} tracks</span>`;
    card.querySelector(".record-name").textContent = playlist.name;
    card.addEventListener("click", () => openPlaylist(playlist));
    shelf.append(card);
  });
}
async function openPlaylist(playlist) {
  state.currentPlaylist = playlist;
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
      all.push(...(page.items || []).map((entry) => entry.item).filter((item) => item?.type === "track"));
      url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
    }
    $("#collection-subtitle").textContent = `${all.length} tracks · selected collection`;
    renderTracks(all);
  } catch (error) {
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
    row.addEventListener("click", () => playTrack(track));
    list.append(row);
  });
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
    $("#now-title").textContent = track.name;
    $("#now-artist").textContent = track.artists.map((artist) => artist.name).join(", ");
    $("#now-cover").src = track.album.images?.[0]?.url || "./assets/studio-gh-mark.svg";
    $("#play-toggle").textContent = playback.paused ? "PLAY" : "PAUSE";
  });
  player.addListener("initialization_error", ({ message }) => setStatus(message, "error"));
  player.addListener("authentication_error", ({ message }) => setStatus(message, "error"));
  player.addListener("account_error", ({ message }) => setStatus(message, "error"));
  player.addListener("playback_error", ({ message }) => setStatus(message, "error"));
  state.player = player;
  await player.connect();
}
async function playTrack(track) {
  try {
    if (!state.deviceId) throw new Error("The browser turntable is still connecting. Try again in a moment.");
    await state.player.activateElement();
    await spotify(`/me/player/play?device_id=${encodeURIComponent(state.deviceId)}`, {
      method: "PUT",
      body: JSON.stringify({ uris: [track.uri] })
    });
    setStatus("Needle down. Enjoy the record.", "success");
  } catch (error) { setStatus(error.message, "error"); }
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
  $("#previous").addEventListener("click", () => state.player?.previousTrack());
  $("#next").addEventListener("click", () => state.player?.nextTrack());
  $("#volume").addEventListener("input", (event) => state.player?.setVolume(Number(event.target.value) / 100));

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
