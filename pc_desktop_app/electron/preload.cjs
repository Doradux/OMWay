const { contextBridge, ipcRenderer } = require("electron");
let pcName = "PC";
try {
  const os = require("node:os");
  pcName = os.hostname() || process.env.COMPUTERNAME || "PC";
} catch {}

contextBridge.exposeInMainWorld("omwayDesktop", {
  platform: process.platform,
  pcName,
  openExternal: (url) => ipcRenderer.invoke("omway:openExternal", url),
  minimizeToTray: () => ipcRenderer.invoke("omway:minimizeToTray"),
  quitApp: () => ipcRenderer.invoke("omway:quit"),
  discordLinkAccount: () => ipcRenderer.invoke("omway:discordLinkAccount"),
  discordSharedGuilds: (discordUserId) => ipcRenderer.invoke("omway:discordSharedGuilds", discordUserId),
  discordVoiceChannels: (guildId) => ipcRenderer.invoke("omway:discordVoiceChannels", guildId),
  discordVoiceAction: (payload) => ipcRenderer.invoke("omway:discordVoiceAction", payload)
});
