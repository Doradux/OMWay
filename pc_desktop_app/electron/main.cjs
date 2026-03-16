const { app, BrowserWindow, Menu, Tray, shell, nativeImage, ipcMain } = require("electron");
const path = require("node:path");
const dotenv = require("dotenv");
const http = require("node:http");
const crypto = require("node:crypto");

dotenv.config({ path: path.join(process.cwd(), ".env") });

let mainWindow = null;
let tray = null;
let shouldQuit = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 660,
    minWidth: 760,
    maxWidth: 760,
    minHeight: 660,
    maxHeight: 660,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    title: "Omway",
    frame: false,
    backgroundColor: "#00000000",
    transparent: true,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (event) => {
    if (!shouldQuit) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function hideToTray() {
  if (mainWindow) {
    mainWindow.hide();
  }
}

function quitApp() {
  shouldQuit = true;
  app.quit();
}

function createTray() {
  const iconDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABr0lEQVR4nK2TPUsCURTHf+fM3VEktHQSXfQf6A9ob2ggIaW1hYaGhoZgJ6fY2Nho2wgpLcEk6S2Cw0A6CQtFSVZG5h/OvWdx3s0QnS6cc+4533POeQ7S8w8Qh6NQKpWq+YjH47iSyeQnALfbbY6iKD4B/AtwF7Cj0+n6wM1m81VQFAW8Xq8WwDd1XQf8A+gD2N1uN3G73SY8Hic4jmM4HA5xvV7j8XjA6/UKx3EwHA6x2+0iDEN4PB6w2WwQj8cRj8cRj8fR6XQYhoHRaITVaoXdbodQKIRarQbL5RJBEGC1WuF0OsFut0O/38f1eh2lUgkcx0Gv14PdbofD4YDb7Qar1QqVSoVUKhVQq9VQKpXQarVQq9Ww2+0QBAF+v18YhoHZbIYwDEOhUGA4HAa9Xo9Go0GxWASLxQKXywVBEJDNZgM4jiMWiwUOhwMKhQJ4nken0wFnWQYIgoDVaoXBYIDT6QQAYLfbwePxwOl0QqPRiN1uF8MwsNls4nQ6QRAEJpMJ3W4Xg8EA5XI5xONxQRAE7XY7k8kEhmHweDwwGAzQaDRQKpXw+/2w2WzgcrnA5XKJdDqN5/MZfN8H5psh6xE2k+8AAAAASUVORK5CYII=";
  tray = new Tray(nativeImage.createFromDataURL(iconDataUrl));
  tray.setToolTip("Omway Desktop");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Omway",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: "Quit",
      click: () => {
        shouldQuit = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getBotToken() {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) {
    throw new Error("Missing DISCORD_BOT_TOKEN in pc_desktop_app/.env");
  }
  return token;
}

function getOauthConfig() {
  const clientId = process.env.DISCORD_CLIENT_ID || "";
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || "";
  const redirectUri = process.env.DISCORD_REDIRECT_URI || "http://127.0.0.1:53682/callback";
  const scopes = process.env.DISCORD_SCOPES || "identify guilds";
  const missing = [];
  if (!clientId) missing.push("DISCORD_CLIENT_ID");
  if (!clientSecret) missing.push("DISCORD_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new Error(`Missing Discord OAuth env vars: ${missing.join(", ")}`);
  }
  return { clientId, clientSecret, redirectUri, scopes };
}

function waitForOauthCode(expectedState, redirectUri) {
  return new Promise((resolve, reject) => {
    const redirect = new URL(redirectUri);
    const timeoutMs = 2 * 60 * 1000;

    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url || "/", redirect.origin);
      if (requestUrl.pathname !== redirect.pathname) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const state = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        res.statusCode = 400;
        res.end("Discord authorization failed. You can close this tab.");
        cleanup();
        reject(new Error(`Discord OAuth error: ${error}`));
        return;
      }
      if (!code || state !== expectedState) {
        res.statusCode = 400;
        res.end("Invalid callback. You can close this tab.");
        cleanup();
        reject(new Error("Invalid Discord callback (state/code mismatch)."));
        return;
      }

      res.statusCode = 200;
      res.end("Discord linked successfully. You can close this tab.");
      cleanup();
      resolve(code);
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Discord auth timed out."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try {
        server.close();
      } catch {}
    }

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });

    server.listen(Number(redirect.port || 80), redirect.hostname);
  });
}

async function discordApiPublic(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API ${response.status}: ${text}`);
  }
  return response.json();
}

async function linkDiscordAccount() {
  const cfg = getOauthConfig();
  const state = crypto.randomBytes(18).toString("hex");
  const scope = cfg.scopes.trim().replace(/\s+/g, " ");
  const authUrl =
    "https://discord.com/api/oauth2/authorize" +
    `?client_id=${cfg.clientId}` +
    "&response_type=code" +
    `&redirect_uri=${encodeURIComponent(cfg.redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(state)}` +
    "&prompt=consent";

  const codePromise = waitForOauthCode(state, cfg.redirectUri);
  await shell.openExternal(authUrl);
  const code = await codePromise;

  const tokenPayload = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    scope
  });

  const tokenData = await discordApiPublic("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenPayload.toString()
  });
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    throw new Error("Discord token exchange failed.");
  }

  const user = await discordApiPublic("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name || "",
    avatar: user.avatar || null
  };
}

async function discordApi(pathname, options = {}) {
  const token = getBotToken();
  const response = await fetch(`https://discord.com/api${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
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

async function getSharedGuilds(discordUserId) {
  const userId = (discordUserId || "").trim();
  if (!userId) {
    throw new Error("Discord User ID is required.");
  }
  const botGuilds = await discordApi("/users/@me/guilds");
  const shared = [];
  for (const guild of botGuilds) {
    try {
      await discordApi(`/guilds/${guild.id}/members/${userId}`);
      shared.push({
        id: guild.id,
        name: guild.name,
        icon: guild.icon || null,
        iconUrl: guild.icon
          ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`
          : null
      });
    } catch {
      // Not shared / inaccessible member endpoint.
    }
  }
  return shared.sort((a, b) => a.name.localeCompare(b.name));
}

async function getGuildVoiceChannels(guildId) {
  const channels = await discordApi(`/guilds/${guildId}/channels`);
  const byId = new Map(channels.map((ch) => [ch.id, ch]));
  const VIEW_CHANNEL = 1n << 10n;
  const CONNECT = 1n << 20n;

  function everyoneCanAccessScope(scopeChannel) {
    if (!scopeChannel) return true;
    const overwrites = scopeChannel.permission_overwrites || [];
    const everyone = overwrites.find((ov) => String(ov.id) === String(guildId));
    if (!everyone) return true;
    const allowBits = BigInt(everyone.allow || "0");
    const denyBits = BigInt(everyone.deny || "0");
    if ((denyBits & VIEW_CHANNEL) !== 0n) return false;
    if ((denyBits & CONNECT) !== 0n) return false;
    // if explicitly allowed, definitely public for everyone on this scope
    if ((allowBits & VIEW_CHANNEL) !== 0n && (allowBits & CONNECT) !== 0n) return true;
    // if not explicitly denied and not explicitly allowed, inherit/public by default
    return true;
  }

  function isFullyPublicVoiceChannel(channel) {
    const parent = channel.parent_id ? byId.get(channel.parent_id) : null;
    return everyoneCanAccessScope(parent) && everyoneCanAccessScope(channel);
  }

  const voiceChannels = [];
  for (const channel of channels) {
    if (channel.type !== 2) continue; // Guild voice
    if (!isFullyPublicVoiceChannel(channel)) continue; // Strict public-only filter
    let inviteUrl = null;
    try {
      const invite = await discordApi(`/channels/${channel.id}/invites`, {
        method: "POST",
        body: JSON.stringify({
          max_age: 0,
          max_uses: 0,
          temporary: false,
          unique: false
        })
      });
      if (invite?.code) {
        inviteUrl = `https://discord.gg/${invite.code}`;
      }
    } catch {
      // Bot may lack create invite permission.
    }
    voiceChannels.push({
      id: channel.id,
      name: channel.name,
      inviteUrl
    });
  }
  return voiceChannels.sort((a, b) => a.name.localeCompare(b.name));
}

async function patchMemberVoice({ guildId, userId, mute, deaf }) {
  const body = {};
  if (typeof mute === "boolean") body.mute = mute;
  if (typeof deaf === "boolean") body.deaf = deaf;
  await discordApi(`/guilds/${guildId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
  return true;
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  ipcMain.handle("omway:minimizeToTray", () => {
    hideToTray();
    return true;
  });

  ipcMain.handle("omway:quit", () => {
    quitApp();
    return true;
  });

  ipcMain.handle("omway:discordSharedGuilds", async (_event, discordUserId) => {
    return getSharedGuilds(discordUserId);
  });

  ipcMain.handle("omway:discordLinkAccount", async () => {
    return linkDiscordAccount();
  });

  ipcMain.handle("omway:discordVoiceChannels", async (_event, guildId) => {
    return getGuildVoiceChannels(guildId);
  });

  ipcMain.handle("omway:discordVoiceAction", async (_event, payload) => {
    return patchMemberVoice(payload);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on("window-all-closed", () => {});
