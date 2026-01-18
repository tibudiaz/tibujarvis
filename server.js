// server.js
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { google } from "googleapis";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json());
app.use(express.static("public"));

// Anti-cache global
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

// -------------------- OpenAI Realtime (mini) --------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Falta OPENAI_API_KEY en .env");
  process.exit(1);
}

const JARVIS_INSTRUCTIONS = `
Sos Jarvis, un asistente con tonada cordobesa (Argentina).
Siempre de buen humor, canchero, irónico y pícaro. Sarcasmo inteligente.
Cada tanto decís “culiado” de forma amistosa (nunca agresiva).

CONTEXTO:
- Ubicación: Río Cuarto, Córdoba, Argentina.
- Zona horaria: America/Argentina/Cordoba.
- Moneda: ARS.
- Para clima/lugares/indicaciones asumí Río Cuarto como punto de partida salvo que se indique otra ciudad.

AHORRO DE TOKENS:
- Para comandos (luces/música): 1 frase, corta.
- No repitas, no expliques lo obvio.

CUÁNDO EXPLAYAR:
- Solo si te piden explicación o es algo complejo.

IMPORTANTE:
- Nunca te auto-converses.
- Nunca respondas dos veces lo mismo.
`.trim();

app.post("/session", async (req, res) => {
  try {
    const offerSdp = req.body;
    if (!offerSdp || !offerSdp.includes("v=")) return res.status(400).send("Invalid SDP");

    const sessionConfig = {
      type: "realtime",
      model: "gpt-realtime-mini",
      audio: {
        output: { voice: "cedar" },
        input: {
          turn_detection: { type: "server_vad", create_response: true, interrupt_response: true }
        }
      },
      instructions: JARVIS_INSTRUCTIONS
    };

    const fd = new FormData();
    fd.set("sdp", offerSdp);
    fd.set("session", JSON.stringify(sessionConfig));

    const r = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: fd
    });

    const text = await r.text();
    if (!r.ok || !text.startsWith("v=")) {
      console.error("❌ OpenAI /realtime/calls:", r.status, text);
      return res.status(500).send(text);
    }

    res.setHeader("Content-Type", "application/sdp");
    res.send(text);
  } catch (e) {
    console.error("❌ /session error:", e);
    res.status(500).send(String(e?.message || e));
  }
});

// -------------------- Mercado Libre (actualizado) --------------------
app.get("/ml/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "8", 10), 1), 20);
    if (!q) return res.status(400).json({ ok: false, error: "Falta ?q=" });

    const url = new URL("https://api.mercadolibre.com/sites/MLA/search");
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(limit));

    const r = await fetch(url.toString(), {
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" }
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: "MercadoLibre API error", detail: data });

    const results = (data?.results || []).slice(0, limit).map((it) => ({
      id: it.id,
      title: it.title,
      price: it.price,
      currency_id: it.currency_id,
      permalink: it.permalink,
      thumbnail: it.thumbnail
    }));

    res.json({ ok: true, query: q, site: "MLA", fetchedAt: new Date().toISOString(), total: data?.paging?.total ?? null, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- YouTube OAuth Device Flow + Data API --------------------
const YT_CLIENT_ID = process.env.YT_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
const YT_TOKEN_URI = process.env.YT_TOKEN_URI || "https://oauth2.googleapis.com/token";
const YT_SCOPES = (process.env.YT_SCOPES || "https://www.googleapis.com/auth/youtube.readonly")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TOKEN_PATH = path.join(process.cwd(), "yt_tokens.json");
const oauth2Client = (YT_CLIENT_ID && YT_CLIENT_SECRET)
  ? new google.auth.OAuth2({ clientId: YT_CLIENT_ID, clientSecret: YT_CLIENT_SECRET })
  : null;

let deviceFlowState = null;

function ytReady() { return !!oauth2Client; }
function ytAuthed() {
  const c = oauth2Client?.credentials;
  return !!(c && (c.access_token || c.refresh_token));
}
function loadTokensIfAny() {
  try {
    if (fs.existsSync(TOKEN_PATH) && oauth2Client) {
      oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
      console.log("✅ YouTube tokens cargados");
    }
  } catch {}
}
loadTokensIfAny();

async function ytEnsureAccessToken() {
  const token = await oauth2Client.getAccessToken();
  if (!token?.token) throw new Error("No access token (falta refresh_token?)");
  return token.token;
}
function ytClient() { return google.youtube({ version: "v3", auth: oauth2Client }); }

app.get("/yt/status", (req, res) => {
  res.json({ ok: true, ready: ytReady(), authed: ytAuthed(), deviceFlowActive: !!deviceFlowState, scopes: YT_SCOPES });
});

app.post("/yt/device/start", async (req, res) => {
  try {
    if (!ytReady()) return res.status(500).json({ ok: false, error: "YouTube OAuth no configurado" });

    const deviceEndpoint = "https://oauth2.googleapis.com/device/code";
    const body = new URLSearchParams();
    body.set("client_id", YT_CLIENT_ID);
    body.set("scope", YT_SCOPES.join(" "));

    const r = await fetch(deviceEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(500).json({ ok: false, error: "Device start failed", detail: data });

    deviceFlowState = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_url: data.verification_url,
      expires_at: Date.now() + (data.expires_in * 1000),
      interval: Math.max(parseInt(data.interval || "5", 10), 1)
    };

    res.json({ ok: true, ...deviceFlowState, expires_in: data.expires_in });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/yt/device/poll", async (req, res) => {
  try {
    if (!ytReady()) return res.status(500).json({ ok: false, error: "YouTube OAuth no configurado" });
    if (!deviceFlowState) return res.status(400).json({ ok: false, error: "No hay device flow activo" });
    if (Date.now() > deviceFlowState.expires_at) {
      deviceFlowState = null;
      return res.status(400).json({ ok: false, error: "Device flow expiró" });
    }

    const body = new URLSearchParams();
    body.set("client_id", YT_CLIENT_ID);
    body.set("client_secret", YT_CLIENT_SECRET);
    body.set("device_code", deviceFlowState.device_code);
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");

    const r = await fetch(YT_TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = data?.error;
      if (err === "authorization_pending" || err === "slow_down") {
        return res.json({ ok: true, pending: true, error: err, interval: deviceFlowState.interval });
      }
      if (err === "access_denied" || err === "expired_token") {
        deviceFlowState = null;
        return res.status(400).json({ ok: false, error: err });
      }
      return res.status(500).json({ ok: false, error: "Token poll failed", detail: data });
    }

    oauth2Client.setCredentials(data);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
    deviceFlowState = null;

    res.json({ ok: true, authed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function requireYT(req, res, next) {
  if (!ytReady()) return res.status(500).json({ ok: false, error: "YT no configurado" });
  if (!ytAuthed()) return res.status(401).json({ ok: false, error: "YT no autorizado" });
  next();
}

// Search videos
app.get("/yt/search", requireYT, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "5", 10), 1), 10);
    if (!q) return res.status(400).json({ ok: false, error: "Falta ?q=" });

    await ytEnsureAccessToken();
    const youtube = ytClient();
    const r = await youtube.search.list({ part: ["snippet"], q, maxResults: limit, type: ["video"] });

    const results = (r.data.items || [])
      .map((it) => ({
        videoId: it.id?.videoId,
        title: it.snippet?.title,
        channelTitle: it.snippet?.channelTitle
      }))
      .filter((x) => x.videoId);

    res.json({ ok: true, q, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Playlists list (mine)
app.get("/yt/playlists", requireYT, async (req, res) => {
  try {
    await ytEnsureAccessToken();
    const youtube = ytClient();

    let pageToken = undefined;
    const out = [];
    for (let i = 0; i < 10; i++) {
      const r = await youtube.playlists.list({
        part: ["snippet", "contentDetails"],
        mine: true,
        maxResults: 50,
        pageToken
      });

      for (const p of (r.data.items || [])) {
        out.push({ id: p.id, title: p.snippet?.title || "", count: p.contentDetails?.itemCount ?? null });
      }
      pageToken = r.data.nextPageToken;
      if (!pageToken) break;
    }

    res.json({ ok: true, total: out.length, results: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Fuzzy match helpers ----
function normStr(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function levenshtein(a, b) {
  a = normStr(a); b = normStr(b);
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}
function similarityScore(query, title) {
  const q = normStr(query), t = normStr(title);
  if (!q || !t) return 0;
  const includesBonus = t.includes(q) ? 0.35 : 0;
  const dist = levenshtein(q, t);
  const maxLen = Math.max(q.length, t.length) || 1;
  const sim = 1 - (dist / maxLen);
  return Math.max(0, Math.min(1, sim + includesBonus));
}

app.get("/yt/playlist/resolve", requireYT, async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Falta ?name=" });

    // fetch playlists
    const r = await fetch(`http://localhost:${PORT}/yt/playlists`, { headers: { "Cache-Control":"no-store" } });
    const data = await r.json().catch(()=>({}));
    const items = data?.results || [];

    let best = null;
    for (const p of items) {
      const score = similarityScore(name, p.title);
      if (!best || score > best.score) best = { ...p, score };
    }

    if (!best || best.score < 0.45) return res.json({ ok: true, found: false, best: best || null });
    res.json({ ok: true, found: true, playlist: best });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- WebSocket Party Sync (prolijo) --------------------
const httpServer = app.listen(PORT, () => console.log(`🟢 Server: http://localhost:${PORT}`));
const wss = new WebSocketServer({ server: httpServer });

// Clientes: cada browser se identifica con clientId y name (PC/RPI)
const clients = new Map(); // ws -> { clientId, name, role, mode }

// Estado global de "casa"
const house = {
  mode: "local", // local | house
  track: null,   // { kind: "video"|"playlist", id: "...", title?:"" }
  playing: false,
  // reloj:
  t0Ms: 0,        // epoch ms when playback started/resumed
  baseSec: 0,     // base seek position at t0Ms
  // control:
  version: 0,
  lastCmdId: "",
};

function nowMs(){ return Date.now(); }
function targetSec(){
  if (!house.track) return 0;
  if (!house.playing) return house.baseSec;
  return house.baseSec + (nowMs() - house.t0Ms) / 1000;
}

function send(ws, obj){
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj){
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}
function broadcastToHouse(obj){
  const msg = JSON.stringify(obj);
  for (const [ws, meta] of clients.entries()) {
    if (ws.readyState !== 1) continue;
    if (meta.mode === "house") ws.send(msg);
  }
}
function dedupeCmd(cmdId){
  if (!cmdId) return false;
  if (cmdId === house.lastCmdId) return true;
  house.lastCmdId = cmdId;
  return false;
}

wss.on("connection", (ws) => {
  clients.set(ws, { clientId: "", name: "client", role: "client", mode: "local" });

  // estado inicial
  send(ws, {
    type: "house.state",
    house: {
      mode: house.mode,
      track: house.track,
      playing: house.playing,
      targetSec: targetSec(),
      version: house.version
    }
  });

  ws.on("close", () => clients.delete(ws));

  ws.on("message", (raw) => {
    const m = (() => { try { return JSON.parse(String(raw)); } catch { return null; } })();
    if (!m?.type) return;

    const meta = clients.get(ws) || { mode: "local" };

    if (m.type === "client.hello") {
      meta.clientId = String(m.clientId || "");
      meta.name = String(m.name || "client");
      meta.role = String(m.role || "client");
      meta.mode = m.mode === "house" ? "house" : "local";
      clients.set(ws, meta);

      send(ws, { type: "client.ack", ok: true, serverTimeMs: nowMs() });
      return;
    }

    if (m.type === "house.setMode") {
      if (dedupeCmd(m.cmdId)) return;
      const mode = m.mode === "house" ? "house" : "local";
      meta.mode = mode;
      clients.set(ws, meta);

      // NO cambiamos house.mode global acá: cada cliente decide si está en house o local.
      // Esto permite PC y RPI coexistan.
      send(ws, { type: "house.mode", mode: meta.mode, targetSec: targetSec(), track: house.track, playing: house.playing, version: house.version });
      return;
    }

    // Reproducir track en house: solo afecta a clientes en modo house
    if (m.type === "house.playTrack") {
      if (dedupeCmd(m.cmdId)) return;
      const track = m.track;
      if (!track?.id || !track?.kind) return;

      house.track = { kind: track.kind, id: track.id, title: track.title || "" };
      house.playing = true;
      house.baseSec = Math.max(0, Number(m.startAtSec || 0));
      house.t0Ms = nowMs();
      house.version++;

      broadcastToHouse({
        type: "house.playTrack",
        track: house.track,
        playing: true,
        targetSec: targetSec(),
        version: house.version
      });
      return;
    }

    if (m.type === "house.pause") {
      if (dedupeCmd(m.cmdId)) return;
      if (house.playing) {
        house.baseSec = targetSec();
        house.playing = false;
        house.version++;
      }
      broadcastToHouse({ type: "house.pause", targetSec: targetSec(), version: house.version });
      return;
    }

    if (m.type === "house.resume") {
      if (dedupeCmd(m.cmdId)) return;
      if (house.track) {
        house.t0Ms = nowMs();
        house.playing = true;
        house.version++;
      }
      broadcastToHouse({ type: "house.resume", targetSec: targetSec(), version: house.version });
      return;
    }

    if (m.type === "house.seek") {
      if (dedupeCmd(m.cmdId)) return;
      const sec = Math.max(0, Number(m.sec || 0));
      house.baseSec = sec;
      if (house.playing) house.t0Ms = nowMs();
      house.version++;
      broadcastToHouse({ type: "house.seek", targetSec: targetSec(), version: house.version });
      return;
    }

    if (m.type === "house.next") {
      if (dedupeCmd(m.cmdId)) return;
      house.version++;
      broadcastToHouse({ type: "house.next", version: house.version });
      return;
    }

    // Server tick request: devuelve targetSec actual (para corrección fina)
    if (m.type === "house.tick") {
      send(ws, { type: "house.tick", serverTimeMs: nowMs(), targetSec: targetSec(), playing: house.playing, track: house.track, version: house.version });
      return;
    }
  });
});
