const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const admin = require("firebase-admin");
const { WebSocketServer } = require("ws");

dotenv.config();

const PORT = Number(process.env.PORT || 8080);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ONLINE_WINDOW_MS = 45_000;

function parsePrivateKey(raw) {
  return (raw || "").replace(/\\n/g, "\n");
}

function assertEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing env var: ${name}`);
  }
}

assertEnv("FIREBASE_PROJECT_ID");
assertEnv("FIREBASE_CLIENT_EMAIL");
assertEnv("FIREBASE_PRIVATE_KEY");
assertEnv("FIREBASE_DATABASE_URL");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: parsePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const rtdb = admin.database();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/pc" });

const pcConnections = new Map();
const discordLinkState = new Map();

function toPcKey(uid, pcId) {
  return `${uid}:${pcId}`;
}

function sanitizePcId(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "pc-main";
}

function parseBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return "";
  return token;
}

async function authMiddleware(req, res, next) {
  try {
    const idToken = parseBearerToken(req);
    if (!idToken) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid auth token", detail: error.message });
  }
}

app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: (origin, callback) => {
      if (CORS_ORIGINS.includes("*")) {
        callback(null, true);
        return;
      }
      if (!origin || CORS_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    }
  })
);

function sendWsJson(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function getDiscordConfig() {
  const clientId = process.env.DISCORD_CLIENT_ID || "";
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || "";
  const botToken = process.env.DISCORD_BOT_TOKEN || "";
  const redirectUri = process.env.DISCORD_REDIRECT_URI || `http://127.0.0.1:${PORT}/discord/callback`;
  const scopes = process.env.DISCORD_SCOPES || "identify guilds";
  if (!clientId || !clientSecret || !botToken) {
    throw new Error("Missing Discord env vars on server (DISCORD_CLIENT_ID/SECRET/BOT_TOKEN).");
  }
  return { clientId, clientSecret, botToken, redirectUri, scopes };
}

async function discordPublicApi(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API ${response.status}: ${text}`);
  }
  return response.json();
}

async function discordBotApi(pathname, options = {}) {
  const cfg = getDiscordConfig();
  const response = await fetch(`https://discord.com/api${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bot ${cfg.botToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API ${response.status}: ${text}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function upsertPresence(uid, pcId, deviceName, status = "online") {
  await rtdb.ref(`presence/${uid}/${pcId}`).update({
    pcId,
    deviceName,
    status,
    lastSeenAt: Date.now()
  });
}

async function upsertDevice(uid, pcId, appName, systemName) {
  await rtdb.ref(`users/${uid}/devices/${pcId}`).update({
    pcId,
    appName,
    systemName,
    updatedAt: Date.now()
  });
}

function toOnlineStatus(lastSeenAt, status) {
  if (status === "offline") return false;
  return Date.now() - Number(lastSeenAt || 0) <= ONLINE_WINDOW_MS;
}

async function composePcs(uid) {
  const [devicesSnap, presenceSnap] = await Promise.all([
    rtdb.ref(`users/${uid}/devices`).get(),
    rtdb.ref(`presence/${uid}`).get()
  ]);

  const devices = devicesSnap.val() || {};
  const presence = presenceSnap.val() || {};
  const byPc = new Map();

  Object.entries(devices).forEach(([pcId, data]) => {
    byPc.set(pcId, {
      pcId,
      deviceName: data?.appName || data?.systemName || pcId,
      status: "offline",
      lastSeenAt: 0,
      isOnline: false
    });
  });

  Object.entries(presence).forEach(([pcId, data]) => {
    const prev = byPc.get(pcId);
    const status = data?.status || "online";
    byPc.set(pcId, {
      pcId,
      deviceName: data?.deviceName || prev?.deviceName || pcId,
      status,
      lastSeenAt: Number(data?.lastSeenAt || 0),
      isOnline: toOnlineStatus(data?.lastSeenAt, status)
    });
  });

  return Array.from(byPc.values()).sort((a, b) => Number(b.lastSeenAt) - Number(a.lastSeenAt));
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "omway-server", at: Date.now() });
});

app.get("/me", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const snap = await rtdb.ref(`users/${uid}`).get();
  const value = snap.val() || {};
  res.json({
    uid,
    email: value.email || req.user.email || "",
    username: value.username || (req.user.email || "user").split("@")[0]
  });
});

app.post("/pcs/rename", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const pcId = sanitizePcId(req.body?.pcId);
  const appName = String(req.body?.appName || "").trim() || pcId;
  const systemName = String(req.body?.systemName || "").trim() || appName;

  await upsertDevice(uid, pcId, appName, systemName);
  await upsertPresence(uid, pcId, appName, "online");
  res.json({ ok: true, pcId, appName, systemName });
});

app.post("/pcs/refresh", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const requestId = crypto.randomUUID();
  const ownConnections = Array.from(pcConnections.values()).filter((item) => item.uid === uid);

  ownConnections.forEach((item) => {
    sendWsJson(item.ws, { type: "presence_check", requestId, at: Date.now() });
  });

  await new Promise((resolve) => setTimeout(resolve, 900));
  const pcs = await composePcs(uid);
  res.json({ ok: true, requestId, pcs });
});

app.post("/commands/test", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const pcId = sanitizePcId(req.body?.pcId);
  const payload = {
    type: "open_test_file",
    commandId: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    requestedAt: Date.now(),
    source: "ios_app"
  };
  await rtdb.ref(`commands/${uid}/${pcId}/latest`).set(payload);
  res.json({ ok: true, pcId, commandId: payload.commandId });
});

app.get("/friends", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const [friendsSnap, incomingSnap, outgoingSnap] = await Promise.all([
    rtdb.ref(`users/${uid}/friends`).get(),
    rtdb.ref(`friendRequests/${uid}/incoming`).get(),
    rtdb.ref(`friendRequests/${uid}/outgoing`).get()
  ]);

  const friendsRaw = friendsSnap.val() || {};
  const incomingRaw = incomingSnap.val() || {};
  const outgoingRaw = outgoingSnap.val() || {};

  const friends = Object.entries(friendsRaw)
    .map(([friendUid, data]) => ({
      uid: friendUid,
      username: data?.username || "Unknown",
      since: Number(data?.since || 0)
    }))
    .sort((a, b) => a.username.localeCompare(b.username));

  const incoming = Object.entries(incomingRaw)
    .map(([fromUid, data]) => ({
      fromUid,
      fromUsername: data?.fromUsername || "Unknown",
      status: data?.status || "pending",
      createdAt: Number(data?.createdAt || 0)
    }))
    .filter((item) => item.status === "pending")
    .sort((a, b) => a.fromUsername.localeCompare(b.fromUsername));

  const outgoing = Object.entries(outgoingRaw)
    .map(([targetUid, data]) => ({
      targetUid,
      toUsername: data?.toUsername || "Unknown",
      status: data?.status || "pending",
      createdAt: Number(data?.createdAt || 0)
    }))
    .sort((a, b) => a.toUsername.localeCompare(b.toUsername));

  res.json({ ok: true, friends, incoming, outgoing });
});

app.post("/friends/request", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const username = String(req.body?.username || "").trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    res.status(400).json({ error: "Invalid username format." });
    return;
  }

  const targetUidSnap = await rtdb.ref(`usernames/${username.toLowerCase()}`).get();
  if (!targetUidSnap.exists()) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const targetUid = String(targetUidSnap.val());
  if (targetUid === uid) {
    res.status(400).json({ error: "Cannot add yourself." });
    return;
  }

  const [selfSnap, targetSnap, existingFriendSnap, existingReqSnap] = await Promise.all([
    rtdb.ref(`users/${uid}`).get(),
    rtdb.ref(`users/${targetUid}`).get(),
    rtdb.ref(`users/${uid}/friends/${targetUid}`).get(),
    rtdb.ref(`friendRequests/${uid}/outgoing/${targetUid}`).get()
  ]);

  if (existingFriendSnap.exists()) {
    res.status(409).json({ error: "Already friends." });
    return;
  }

  if (existingReqSnap.exists() && existingReqSnap.val()?.status === "pending") {
    res.status(409).json({ error: "Request already pending." });
    return;
  }

  const selfProfile = selfSnap.val() || {};
  const targetProfile = targetSnap.val() || {};
  const payload = {
    fromUid: uid,
    fromUsername: selfProfile.username || "Unknown",
    toUid: targetUid,
    toUsername: targetProfile.username || username,
    status: "pending",
    createdAt: Date.now()
  };

  const updates = {};
  updates[`friendRequests/${targetUid}/incoming/${uid}`] = payload;
  updates[`friendRequests/${uid}/outgoing/${targetUid}`] = payload;
  await rtdb.ref().update(updates);

  res.json({ ok: true });
});

app.post("/friends/revoke", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const targetUid = String(req.body?.targetUid || "").trim();
  if (!targetUid) {
    res.status(400).json({ error: "targetUid is required." });
    return;
  }

  const updates = {};
  updates[`friendRequests/${uid}/outgoing/${targetUid}`] = null;
  updates[`friendRequests/${targetUid}/incoming/${uid}`] = null;
  await rtdb.ref().update(updates);

  res.json({ ok: true });
});

app.post("/friends/respond", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const fromUid = String(req.body?.fromUid || "").trim();
  const action = String(req.body?.action || "").trim();
  if (!fromUid || !["accept", "reject"].includes(action)) {
    res.status(400).json({ error: "fromUid and valid action are required." });
    return;
  }

  const [myProfileSnap, incomingSnap] = await Promise.all([
    rtdb.ref(`users/${uid}`).get(),
    rtdb.ref(`friendRequests/${uid}/incoming/${fromUid}`).get()
  ]);

  if (!incomingSnap.exists()) {
    res.status(404).json({ error: "Request not found." });
    return;
  }

  const request = incomingSnap.val() || {};
  const now = Date.now();
  const updates = {};

  if (action === "accept") {
    updates[`users/${uid}/friends/${fromUid}`] = {
      username: request.fromUsername || "Unknown",
      since: now
    };
    updates[`users/${fromUid}/friends/${uid}`] = {
      username: myProfileSnap.val()?.username || "Unknown",
      since: now
    };
    updates[`friendRequests/${uid}/incoming/${fromUid}/status`] = "accepted";
    updates[`friendRequests/${uid}/incoming/${fromUid}/respondedAt`] = now;
    updates[`friendRequests/${fromUid}/outgoing/${uid}/status`] = "accepted";
    updates[`friendRequests/${fromUid}/outgoing/${uid}/respondedAt`] = now;
  } else {
    updates[`friendRequests/${uid}/incoming/${fromUid}/status`] = "rejected";
    updates[`friendRequests/${uid}/incoming/${fromUid}/respondedAt`] = now;
    updates[`friendRequests/${fromUid}/outgoing/${uid}/status`] = "rejected";
    updates[`friendRequests/${fromUid}/outgoing/${uid}/respondedAt`] = now;
  }

  await rtdb.ref().update(updates);
  res.json({ ok: true });
});

app.post("/discord/link/start", authMiddleware, async (req, res) => {
  try {
    const cfg = getDiscordConfig();
    const uid = req.user.uid;
    const state = crypto.randomBytes(18).toString("hex");
    const expiresAt = Date.now() + 2 * 60 * 1000;
    discordLinkState.set(state, { uid, status: "pending", expiresAt });

    const scope = cfg.scopes.trim().replace(/\s+/g, " ");
    const authUrl =
      "https://discord.com/api/oauth2/authorize" +
      `?client_id=${cfg.clientId}` +
      "&response_type=code" +
      `&redirect_uri=${encodeURIComponent(cfg.redirectUri)}` +
      `&scope=${encodeURIComponent(scope)}` +
      `&state=${encodeURIComponent(state)}` +
      "&prompt=consent";

    res.json({ ok: true, state, url: authUrl, expiresAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/discord/link/status", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const state = String(req.query.state || "");
  const item = discordLinkState.get(state);
  if (!item || item.uid !== uid) {
    res.status(404).json({ error: "Link session not found." });
    return;
  }
  if (Date.now() > item.expiresAt) {
    discordLinkState.delete(state);
    res.json({ ok: true, status: "expired" });
    return;
  }
  res.json({ ok: true, status: item.status, linked: item.linked || null });
});

app.get("/discord/callback", async (req, res) => {
  try {
    const cfg = getDiscordConfig();
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    const error = String(req.query.error || "");

    if (error) {
      res.status(400).send("Discord authorization failed. You can close this tab.");
      return;
    }
    if (!state || !code) {
      res.status(400).send("Invalid callback. You can close this tab.");
      return;
    }

    const entry = discordLinkState.get(state);
    if (!entry) {
      res.status(400).send("Expired link session. You can close this tab.");
      return;
    }

    const tokenPayload = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      scope: cfg.scopes
    });

    const tokenData = await discordPublicApi("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenPayload.toString()
    });
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      throw new Error("Discord token exchange failed.");
    }

    const user = await discordPublicApi("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const linked = {
      id: user.id,
      username: user.username || "",
      globalName: user.global_name || "",
      avatar: user.avatar || null,
      linkedAt: Date.now()
    };

    await rtdb.ref(`users/${entry.uid}/discord`).set(linked);
    discordLinkState.set(state, { ...entry, status: "linked", linked });

    res.status(200).send("Discord linked successfully. You can close this tab.");
  } catch (error) {
    res.status(500).send(`Discord link failed: ${error.message}`);
  }
});

app.get("/discord/shared-guilds", authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const discordSnap = await rtdb.ref(`users/${uid}/discord`).get();
    const discordUserId = String(discordSnap.val()?.id || "");
    if (!discordUserId) {
      res.status(400).json({ error: "Discord account not linked." });
      return;
    }

    const botGuilds = await discordBotApi("/users/@me/guilds");
    const shared = [];
    for (const guild of botGuilds) {
      try {
        await discordBotApi(`/guilds/${guild.id}/members/${discordUserId}`);
        shared.push({
          id: guild.id,
          name: guild.name,
          icon: guild.icon || null,
          iconUrl: guild.icon
            ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`
            : null
        });
      } catch {
        // skip non-shared guilds
      }
    }

    shared.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, guilds: shared });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/discord/voice-channels", authMiddleware, async (req, res) => {
  try {
    const guildId = String(req.query.guildId || "").trim();
    if (!guildId) {
      res.status(400).json({ error: "guildId is required." });
      return;
    }

    const channels = await discordBotApi(`/guilds/${guildId}/channels`);
    const byId = new Map(channels.map((ch) => [ch.id, ch]));
    const VIEW_CHANNEL = 1n << 10n;
    const CONNECT = 1n << 20n;

    function everyoneCanAccessScope(scopeChannel) {
      if (!scopeChannel) return true;
      const overwrites = scopeChannel.permission_overwrites || [];
      const everyone = overwrites.find((ov) => String(ov.id) === String(guildId));
      if (!everyone) return true;
      const denyBits = BigInt(everyone.deny || "0");
      if ((denyBits & VIEW_CHANNEL) !== 0n) return false;
      if ((denyBits & CONNECT) !== 0n) return false;
      return true;
    }

    function isPublicVoiceChannel(channel) {
      const parent = channel.parent_id ? byId.get(channel.parent_id) : null;
      return everyoneCanAccessScope(parent) && everyoneCanAccessScope(channel);
    }

    const voiceChannels = channels
      .filter((channel) => channel.type === 2 && isPublicVoiceChannel(channel))
      .map((channel) => ({
        id: channel.id,
        name: channel.name
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ ok: true, channels: voiceChannels });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

wss.on("connection", async (ws, req) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const token = requestUrl.searchParams.get("token") || "";
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const pcId = sanitizePcId(requestUrl.searchParams.get("pcId"));
    const deviceName = (requestUrl.searchParams.get("deviceName") || pcId).trim() || pcId;

    const key = toPcKey(uid, pcId);
    const previous = pcConnections.get(key);
    if (previous?.ws && previous.ws.readyState === previous.ws.OPEN) {
      previous.ws.close(1000, "Replaced by new session");
    }

    pcConnections.set(key, { ws, uid, pcId, deviceName, connectedAt: Date.now() });

    await upsertDevice(uid, pcId, deviceName, deviceName);
    await upsertPresence(uid, pcId, deviceName, "online");

    sendWsJson(ws, { type: "connected", pcId, at: Date.now() });

    ws.on("message", async (raw) => {
      try {
        const payload = JSON.parse(String(raw));
        if (payload?.type === "presence_ready") {
          await upsertPresence(uid, pcId, deviceName, "online");
          return;
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", async () => {
      const current = pcConnections.get(key);
      if (current?.ws === ws) {
        pcConnections.delete(key);
        try {
          await upsertPresence(uid, pcId, deviceName, "offline");
        } catch {
          // ignore network errors on disconnect
        }
      }
    });
  } catch (error) {
    ws.close(1008, `Auth failed: ${error.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Omway server listening on http://localhost:${PORT}`);
});
