import { useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  signInWithEmailAndPassword
} from "firebase/auth";
import { get, ref, set } from "firebase/database";
import { getOmwayAuth, getOmwayDb } from "./lib/firebase";
import Toast from "./components/Toast";

export default function App() {
  const API_BASE = (import.meta.env.VITE_OMWAY_API_BASE_URL || "").replace(/\/$/, "");
  const [initError] = useState(() => {
    const required = [
      "VITE_FIREBASE_API_KEY",
      "VITE_FIREBASE_AUTH_DOMAIN",
      "VITE_FIREBASE_DATABASE_URL",
      "VITE_FIREBASE_PROJECT_ID",
      "VITE_FIREBASE_STORAGE_BUCKET",
      "VITE_FIREBASE_MESSAGING_SENDER_ID",
      "VITE_FIREBASE_APP_ID"
    ];
    const missing = required.filter((key) => !import.meta.env[key]);
    if (missing.length > 0) {
      return `Missing env vars in pc_desktop_app/.env: ${missing.join(", ")}`;
    }
    if (!API_BASE) {
      return "Missing env var in pc_desktop_app/.env: VITE_OMWAY_API_BASE_URL";
    }
    return "";
  });

  const auth = useMemo(() => (initError ? null : getOmwayAuth()), [initError]);
  const db = useMemo(() => (initError ? null : getOmwayDb()), [initError]);

  const [mode, setMode] = useState("login");
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [serversOpen, setServersOpen] = useState(false);
  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);
  const serversRef = useRef(null);
  const serversButtonRef = useRef(null);
  const wsRef = useRef(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regRepeatPassword, setRegRepeatPassword] = useState("");
  const [regUsername, setRegUsername] = useState("");

  const [sessionUser, setSessionUser] = useState(null);
  const [sessionUsername, setSessionUsername] = useState("");
  const [appPcName, setAppPcName] = useState("");
  const [pcNameDraft, setPcNameDraft] = useState("");
  const [savePcState, setSavePcState] = useState("idle");
  const [toast, setToast] = useState({ title: "", message: "" });
  const [linkedDiscord, setLinkedDiscord] = useState(null);
  const [sharedGuilds, setSharedGuilds] = useState([]);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [voiceChannels, setVoiceChannels] = useState([]);
  const [discordLoading, setDiscordLoading] = useState(false);
  const [channelsLoading, setChannelsLoading] = useState(false);

  const systemPcName = (window.omwayDesktop?.pcName || "PC").trim() || "PC";
  const pcId = useMemo(() => toPcId(systemPcName), [systemPcName]);

  useEffect(() => {
    if (!auth || !db) return undefined;
    const unsub = onAuthStateChanged(auth, async (user) => {
      setSessionUser(user || null);
      setMenuOpen(false);
      if (!user) {
        setSessionUsername("");
        setAppPcName(systemPcName);
        setPcNameDraft(systemPcName);
        return;
      }
      try {
        const profile = await get(ref(db, `users/${user.uid}`));
        const value = profile.val() || {};
        setSessionUsername(value.username || user.email || "User");
        setLinkedDiscord(value.discord || null);

        const deviceSnap = await get(ref(db, `users/${user.uid}/devices/${pcId}`));
        const deviceValue = deviceSnap.val() || {};
        const resolvedName = (deviceValue.appName || systemPcName).trim() || systemPcName;
        setAppPcName(resolvedName);
        setPcNameDraft(resolvedName);
      } catch {
        setSessionUsername(user.email || "User");
        setLinkedDiscord(null);
        setAppPcName(systemPcName);
        setPcNameDraft(systemPcName);
      }
    });
    return () => unsub();
  }, [auth, db, pcId, systemPcName]);

  useEffect(() => {
    if (!sessionUser || !API_BASE) return undefined;
    let cancelled = false;

    async function connectPcSocket() {
      try {
        const idToken = await sessionUser.getIdToken();
        if (cancelled) return;

        const wsBase = API_BASE.replace(/^http/i, "ws");
        const socketUrl =
          `${wsBase}/ws/pc` +
          `?token=${encodeURIComponent(idToken)}` +
          `&pcId=${encodeURIComponent(pcId)}` +
          `&deviceName=${encodeURIComponent(appPcName || systemPcName)}`;

        const socket = new WebSocket(socketUrl);
        wsRef.current = socket;

        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data || "{}");
            if (message?.type === "presence_check") {
              socket.send(
                JSON.stringify({
                  type: "presence_ready",
                  requestId: message.requestId || "",
                  at: Date.now()
                })
              );
            }
          } catch {
            // ignore malformed payloads
          }
        };
      } catch (error) {
        showToast("PC link error", error.message || String(error));
      }
    }

    connectPcSocket();
    return () => {
      cancelled = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sessionUser, API_BASE, pcId, appPcName, systemPcName]);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function handlePointerDown(event) {
      const target = event.target;
      const clickedMenu = menuRef.current?.contains(target);
      const clickedButton = menuButtonRef.current?.contains(target);
      if (!clickedMenu && !clickedButton) {
        setMenuOpen(false);
      }

      const clickedServers = serversRef.current?.contains(target);
      const clickedServersButton = serversButtonRef.current?.contains(target);
      if (!clickedServers && !clickedServersButton) {
        setServersOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  function showToast(title, message) {
    setToast({ title, message });
  }

  async function apiFetch(pathname, options = {}) {
    if (!auth?.currentUser) {
      throw new Error("Session required.");
    }
    const idToken = await auth.currentUser.getIdToken();
    const response = await fetch(`${API_BASE}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error || `API ${response.status}`);
    }
    return body;
  }

  async function onLogin(event) {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      showToast("Missing fields", "Enter email and password.");
      return;
    }

    try {
      setBusy(true);
      await signInWithEmailAndPassword(auth, email.trim(), password);
      showToast("Session started", "Login successful.");
      setPassword("");
    } catch (error) {
      showToast("Login error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRegister(event) {
    event.preventDefault();
    const nextEmail = regEmail.trim();
    const nextPassword = regPassword.trim();
    const nextRepeat = regRepeatPassword.trim();
    const nextUsername = regUsername.trim();
    const usernameKey = nextUsername.toLowerCase();

    if (!nextEmail || !nextPassword || !nextRepeat || !nextUsername) {
      showToast("Missing fields", "Complete all fields.");
      return;
    }
    if (nextPassword.length < 6) {
      showToast("Invalid password", "Password must have at least 6 characters.");
      return;
    }
    if (nextPassword !== nextRepeat) {
      showToast("Password mismatch", "Passwords do not match.");
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(nextUsername)) {
      showToast("Invalid username", "Use 3-20 chars: letters, numbers or _.");
      return;
    }

    try {
      setBusy(true);
      const usernameRef = ref(db, `usernames/${usernameKey}`);
      const usernameSnap = await get(usernameRef);
      if (usernameSnap.exists()) {
        showToast("Username taken", "Try another username.");
        return;
      }

      const cred = await createUserWithEmailAndPassword(auth, nextEmail, nextPassword);
      const uid = cred.user.uid;
      await set(ref(db, `users/${uid}`), {
        email: nextEmail,
        username: nextUsername,
        createdAt: Date.now()
      });
      await set(usernameRef, uid);

      setMode("login");
      setRegEmail("");
      setRegPassword("");
      setRegRepeatPassword("");
      setRegUsername("");
      showToast("Account created", "Now you can sign in.");
    } catch (error) {
      showToast("Register error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function onFetchSharedGuilds() {
    if (!sessionUser || discordLoading) return;
    try {
      setDiscordLoading(true);
      const response = await apiFetch("/discord/shared-guilds", { method: "GET" });
      setSharedGuilds(response.guilds || []);
      setSelectedGuildId("");
      setVoiceChannels([]);
    } catch (error) {
      showToast("Discord error", error.message || String(error));
    } finally {
      setDiscordLoading(false);
    }
  }

  async function onSelectGuild(guildId) {
    setSelectedGuildId(guildId);
    setServersOpen(false);
    if (!guildId) {
      setVoiceChannels([]);
      return;
    }
    try {
      setChannelsLoading(true);
      const response = await apiFetch(`/discord/voice-channels?guildId=${encodeURIComponent(guildId)}`, {
        method: "GET"
      });
      setVoiceChannels(response.channels || []);
    } catch (error) {
      showToast("Discord error", error.message || String(error));
    } finally {
      setChannelsLoading(false);
    }
  }

  async function onLogout() {
    try {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      await signOut(auth);
      setMenuOpen(false);
      showToast("Logged out", "Session closed.");
    } catch (error) {
      showToast("Logout error", error.message);
    }
  }

  function onMinimizeToTray() {
    window.omwayDesktop?.minimizeToTray?.();
    setMenuOpen(false);
  }

  function onQuitApp() {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    window.omwayDesktop?.quitApp?.();
    setMenuOpen(false);
  }

  async function onSavePcName() {
    if (!sessionUser || savePcState === "loading") return;
    const nextName = (pcNameDraft || "").trim() || systemPcName;

    try {
      setSavePcState("loading");
      const devicePayload = {
        appName: nextName,
        systemName: systemPcName,
        pcId,
        updatedAt: Date.now()
      };
      await set(ref(db, `users/${sessionUser.uid}/devices/${pcId}`), devicePayload);
      await apiFetch("/pcs/rename", {
        method: "POST",
        body: JSON.stringify({
          pcId,
          appName: nextName,
          systemName: systemPcName
        })
      });
      setAppPcName(nextName);
      setSavePcState("success");
      setTimeout(() => {
        setSavePcState("idle");
      }, 1800);
    } catch (error) {
      showToast("Save error", error.message);
      setSavePcState("idle");
    }
  }

  async function onLinkDiscordAccount() {
    if (!sessionUser || discordLoading) return;
    try {
      setDiscordLoading(true);
      const start = await apiFetch("/discord/link/start", { method: "POST", body: "{}" });
      if (!start?.url || !start?.state) {
        throw new Error("Invalid link session response.");
      }

      if (window.omwayDesktop?.openExternal) {
        await window.omwayDesktop.openExternal(start.url);
      } else {
        window.open(start.url, "_blank", "noopener,noreferrer");
      }

      const startedAt = Date.now();
      let linked = null;
      while (Date.now() - startedAt < 120_000) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const status = await apiFetch(
          `/discord/link/status?state=${encodeURIComponent(start.state)}`,
          { method: "GET" }
        );
        if (status.status === "linked") {
          linked = status.linked;
          break;
        }
        if (status.status === "expired") {
          throw new Error("Discord link session expired. Try again.");
        }
      }
      if (!linked?.id) {
        throw new Error("Discord link timed out.");
      }
      setLinkedDiscord(linked);
      setSharedGuilds([]);
      setSelectedGuildId("");
      setVoiceChannels([]);
    } catch (error) {
      showToast("Discord link error", error.message || String(error));
    } finally {
      setDiscordLoading(false);
    }
  }

  if (initError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#1e1f22] p-8 text-[#f2f3f5]">
        <div className="w-full max-w-[760px] rounded-2xl border border-white/10 bg-[#313338] p-6 shadow-float">
          <h1 className="text-2xl font-semibold">Desktop UI config error</h1>
          <p className="mt-3 text-sm leading-6 text-[#c4c9ce]">{initError}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-transparent text-[#f2f3f5]">
      <section className="mx-auto flex min-h-screen w-full max-w-[760px] items-center justify-center px-5">
        <div
          className="w-full rounded-2xl border border-white/10 bg-[#313338]/95 px-8 py-6 shadow-float"
          style={{ WebkitAppRegion: "drag" }}
        >
          <div className="mb-2 h-2 w-full" style={{ WebkitAppRegion: "drag" }} />

          {!sessionUser ? (
            <>
              <div className="mb-4">
                <p className="text-[11px] uppercase tracking-[0.22em] text-[#b5bac1]">Omway</p>
                <h1 className="mt-2 text-4xl font-semibold leading-tight text-[#f2f3f5]">Welcome back</h1>
                <p className="mt-2 text-sm text-[#b5bac1]">Login to continue</p>
              </div>

              <div
                className={`no-drag mt-4 flip-scene transition-all duration-500 ${
                  mode === "register" ? "h-[430px]" : "h-[260px]"
                }`}
                style={{ WebkitAppRegion: "no-drag" }}
              >
                <div className={`flip-card ${mode === "register" ? "is-flipped" : ""}`}>
                  <form onSubmit={onLogin} className="flip-face flip-front space-y-4" aria-hidden={mode !== "login"}>
                    <FloatingField label="Email" value={email} onChange={setEmail} />
                    <FloatingField label="Password" type="password" value={password} onChange={setPassword} />
                    <button
                      disabled={busy}
                      className="mt-2 w-full rounded-md bg-[#5865f2] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#4752c4] disabled:opacity-60"
                      type="submit"
                    >
                      Log In
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("register")}
                      className="ml-auto block text-sm font-medium text-white underline underline-offset-4 transition hover:text-[#00a8fc]"
                    >
                      Register
                    </button>
                  </form>

                  <form onSubmit={onRegister} className="flip-face flip-back space-y-4" aria-hidden={mode !== "register"}>
                    <FloatingField label="Email" value={regEmail} onChange={setRegEmail} />
                    <FloatingField label="Password" type="password" value={regPassword} onChange={setRegPassword} />
                    <FloatingField
                      label="Repeat password"
                      type="password"
                      value={regRepeatPassword}
                      onChange={setRegRepeatPassword}
                    />
                    <FloatingField label="Username (unique)" value={regUsername} onChange={setRegUsername} />
                    <button
                      disabled={busy}
                      className="mt-2 w-full rounded-md bg-[#5865f2] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#4752c4] disabled:opacity-60"
                      type="submit"
                    >
                      Create account
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("login")}
                      className="ml-auto block text-sm font-medium text-[#9ca3af] underline underline-offset-4 transition hover:text-white"
                    >
                      Back to login
                    </button>
                  </form>
                </div>
              </div>
            </>
          ) : (
            <div
              className="no-drag relative mt-2 max-h-[520px] overflow-y-auto pr-1"
              style={{ WebkitAppRegion: "no-drag" }}
            >
              <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-[#b5bac1]">Omway</p>
                  <h1 className="mt-2 text-3xl font-semibold text-[#f2f3f5]">Hi, {sessionUsername}</h1>
                </div>
                <button
                  ref={menuButtonRef}
                  type="button"
                  onClick={() => setMenuOpen((prev) => !prev)}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#1e1f22] text-sm font-semibold text-[#f2f3f5] hover:bg-[#232428]"
                  title="Session menu"
                >
                  {(sessionUsername?.[0] || "U").toUpperCase()}
                </button>
              </div>

              <div className="mb-4 rounded-md border border-white/10 bg-[#1e1f22] p-3">
                <p className="mb-2 text-xs uppercase tracking-wider text-[#949ba4]">Discord account</p>
                {linkedDiscord ? (
                  <p className="mb-2 text-sm text-[#f2f3f5]">
                    Linked: {linkedDiscord.globalName || linkedDiscord.username} ({linkedDiscord.id})
                  </p>
                ) : (
                  <p className="mb-2 text-sm text-[#949ba4]">Not linked yet.</p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onLinkDiscordAccount}
                    disabled={discordLoading}
                    className="rounded-md bg-[#5865f2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4752c4] disabled:opacity-60"
                  >
                    {discordLoading ? "Linking..." : linkedDiscord ? "Relink Discord Account" : "Link Discord Account"}
                  </button>
                  <button
                    type="button"
                    onClick={onFetchSharedGuilds}
                    disabled={discordLoading || !linkedDiscord?.id}
                    className="rounded-md bg-[#3ba55d] px-4 py-2 text-sm font-semibold text-white hover:bg-[#2d7d46] disabled:opacity-60"
                  >
                    Load shared servers
                  </button>
                </div>
              </div>

              <div className="mb-4 rounded-md border border-white/10 bg-[#1e1f22] p-3">
                <p className="mb-2 text-xs uppercase tracking-wider text-[#949ba4]">Shared servers</p>
                <div className="relative">
                  <button
                    ref={serversButtonRef}
                    type="button"
                    onClick={() => setServersOpen((prev) => !prev)}
                    className="flex w-full items-center justify-between rounded-md border border-[#111214] bg-[#111214] px-3 py-2 text-sm text-[#f2f3f5] hover:border-[#5865f2]"
                  >
                    <span className="flex items-center gap-2">
                      {selectedGuildId ? (
                        <>
                          <ServerIcon guild={sharedGuilds.find((g) => g.id === selectedGuildId)} />
                          {sharedGuilds.find((g) => g.id === selectedGuildId)?.name || "Select shared server..."}
                        </>
                      ) : (
                        "Select shared server..."
                      )}
                    </span>
                    <span className="text-[#949ba4]">{serversOpen ? "▴" : "▾"}</span>
                  </button>

                  {serversOpen && (
                    <div
                      ref={serversRef}
                      className="absolute z-20 mt-1 max-h-44 w-full overflow-auto rounded-md border border-white/10 bg-[#111214] shadow-float"
                    >
                      {sharedGuilds.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-[#949ba4]">No shared servers loaded.</p>
                      ) : (
                        sharedGuilds.map((guild) => (
                          <button
                            key={guild.id}
                            type="button"
                            onClick={() => onSelectGuild(guild.id)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#f2f3f5] hover:bg-[#232428]"
                          >
                            <ServerIcon guild={guild} />
                            {guild.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="mb-4 rounded-md border border-white/10 bg-[#1e1f22] p-3">
                <p className="mb-2 text-xs uppercase tracking-wider text-[#949ba4]">Voice channels</p>
                {channelsLoading ? (
                  <div className="flex items-center gap-2 px-1 py-2 text-xs text-[#949ba4]">
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.35" strokeWidth="3" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    Loading voice channels...
                  </div>
                ) : (
                  <select
                    className="w-full rounded-md border border-[#111214] bg-[#111214] px-3 py-2 text-sm text-[#f2f3f5] outline-none focus:border-[#5865f2]"
                    disabled={voiceChannels.length === 0}
                  >
                    <option value="">
                      {voiceChannels.length === 0
                        ? "Select a server first..."
                        : "Select voice channel..."}
                    </option>
                    {voiceChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                )}
                <p className="mt-3 text-xs text-[#949ba4]">
                  Voice moderation is handled automatically by the bot workflow.
                </p>
              </div>

              <button
                type="button"
                className="mb-4 w-full rounded-md bg-[#4e5058] px-4 py-3 text-sm font-semibold text-[#f2f3f5] opacity-80"
              >
                Soon
              </button>

              <div className="mb-4 rounded-md border border-white/10 bg-[#1e1f22] p-3">
                <p className="mb-2 text-xs uppercase tracking-wider text-[#949ba4]">Rename this PC (app only)</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={pcNameDraft}
                    onChange={(event) => setPcNameDraft(event.target.value)}
                    className="w-full rounded-md border border-[#111214] bg-[#111214] px-3 py-2 text-sm text-[#f2f3f5] outline-none focus:border-[#5865f2]"
                  />
                  <button
                    type="button"
                    onClick={onSavePcName}
                    disabled={savePcState === "loading"}
                    className="flex min-w-[80px] items-center justify-center rounded-md bg-[#3ba55d] px-4 py-2 text-sm font-semibold text-white hover:bg-[#2d7d46] disabled:opacity-60"
                  >
                    {savePcState === "loading" ? (
                      <svg
                        className="h-4 w-4 animate-spin"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.35" strokeWidth="3" />
                        <path
                          d="M21 12a9 9 0 0 0-9-9"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                        />
                      </svg>
                    ) : savePcState === "success" ? (
                      <svg
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M5 12.5L10 17L19 8"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      "Save"
                    )}
                  </button>
                </div>
              </div>

              {menuOpen && (
                <div
                  ref={menuRef}
                  className="absolute right-0 top-14 z-20 w-64 rounded-md border border-white/10 bg-[#1e1f22] p-2 shadow-float"
                >
                  <button
                    type="button"
                    onClick={onLogout}
                    className="w-full rounded px-3 py-2 text-left text-sm text-[#f2f3f5] hover:bg-[#2b2d31]"
                  >
                    Log out
                  </button>
                  <button
                    type="button"
                    onClick={onMinimizeToTray}
                    className="mt-1 w-full rounded px-3 py-2 text-left text-sm text-[#f2f3f5] hover:bg-[#2b2d31]"
                  >
                    Minimize to tray
                  </button>
                  <button
                    type="button"
                    onClick={onQuitApp}
                    className="mt-1 w-full rounded px-3 py-2 text-left text-sm text-[#ed4245] hover:bg-[#2b2d31]"
                  >
                    Quit app
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <Toast title={toast.title} message={toast.message} onClose={() => setToast({ title: "", message: "" })} />
    </main>
  );
}

function ServerIcon({ guild }) {
  const fallback = (guild?.name || "?").trim()[0]?.toUpperCase() || "?";
  if (guild?.iconUrl) {
    return (
      <img
        src={guild.iconUrl}
        alt=""
        className="h-5 w-5 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#5865f2] text-[10px] font-semibold text-white">
      {fallback}
    </span>
  );
}

function toPcId(name) {
  const normalized = (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "pc-main";
}

function FloatingField({ label, value, onChange, type = "text" }) {
  const [focused, setFocused] = useState(false);
  const active = focused || Boolean(value);
  return (
    <label className="block no-drag">
      <div className="relative rounded-md border border-[#1e1f22] bg-[#1e1f22] px-0 pb-2 pt-5 transition focus-within:border-[#5865f2]">
        <span
          className={`pointer-events-none absolute left-3 transition-all duration-200 ${
            active
              ? "top-1 text-[10px] uppercase tracking-wider text-[#949ba4]"
              : "top-1/2 -translate-y-1/2 text-sm text-[#949ba4]"
          }`}
        >
          {label}
        </span>
        <input
          type={type}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => onChange(event.target.value)}
          className="w-full border-none bg-transparent px-3 pt-2 text-sm text-[#f2f3f5] outline-none"
        />
      </div>
    </label>
  );
}
