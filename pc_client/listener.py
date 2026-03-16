import json
import os
import re
import secrets
import socket
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from PIL import Image, ImageDraw
import pystray
import tkinter as tk
from tkinter import messagebox

try:
    import keyring
except Exception:  # pragma: no cover
    keyring = None

load_dotenv()

DB_URL = os.getenv("OMWAY_FIREBASE_DB_URL", "").rstrip("/")
API_KEY = os.getenv("OMWAY_FIREBASE_API_KEY", "")
DEFAULT_PC_ID = os.getenv("OMWAY_PC_ID", "pc-main")
POLL_SECONDS = float(os.getenv("OMWAY_POLL_SECONDS", "3"))
HEARTBEAT_SECONDS = float(os.getenv("OMWAY_HEARTBEAT_SECONDS", "10"))
TEST_FILE_PATH = os.getenv("OMWAY_TEST_FILE_PATH", r"C:\Users\kakyg\Desktop\prueba.txt")
DISCORD_CLIENT_ID = os.getenv("OMWAY_DISCORD_CLIENT_ID", "")
DISCORD_REDIRECT_URI = os.getenv("OMWAY_DISCORD_REDIRECT_URI", "http://127.0.0.1:53682/callback")
DISCORD_SCOPES = os.getenv("OMWAY_DISCORD_SCOPES", "identify guilds")

APP_DIR = Path(__file__).resolve().parent
STATE_FILE = APP_DIR / ".omway_state.json"
KEYRING_SERVICE = "omway-listener"


class LocalState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.data = {
            "email": "",
            "pc_id": DEFAULT_PC_ID,
            "remember_login": True,
            "discord_last_link_at": 0,
        }
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                self.data.update(raw)
        except Exception:
            pass

    def save(self) -> None:
        self.path.write_text(json.dumps(self.data, indent=2), encoding="utf-8")

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value
        self.save()

    def get_password(self, email: str) -> str:
        if not email:
            return ""
        if keyring is None:
            return ""
        return keyring.get_password(KEYRING_SERVICE, email) or ""

    def set_password(self, email: str, password: str) -> None:
        if not email or keyring is None:
            return
        keyring.set_password(KEYRING_SERVICE, email, password)

    def delete_password(self, email: str) -> None:
        if not email or keyring is None:
            return
        try:
            keyring.delete_password(KEYRING_SERVICE, email)
        except Exception:
            pass


class FirebaseSession:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self.id_token = ""
        self.refresh_token = ""
        self.uid = ""
        self._last_login_at = 0.0

    def login(self, email: str, password: str) -> None:
        data = self._auth_request(
            "accounts:signInWithPassword",
            {"email": email, "password": password, "returnSecureToken": True},
        )
        self.id_token = data["idToken"]
        self.refresh_token = data["refreshToken"]
        self.uid = data["localId"]
        self._last_login_at = time.time()

    def register(self, email: str, password: str) -> dict[str, Any]:
        return self._auth_request(
            "accounts:signUp",
            {"email": email, "password": password, "returnSecureToken": True},
        )

    def _auth_request(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.api_key:
            raise RuntimeError("Missing OMWAY_FIREBASE_API_KEY.")
        url = f"https://identitytoolkit.googleapis.com/v1/{endpoint}?key={self.api_key}"
        res = requests.post(url, json=payload, timeout=15)
        self._raise_for_firebase_error(res)
        return res.json()

    def maybe_refresh(self) -> None:
        if not self.id_token:
            return
        if time.time() - self._last_login_at < 45 * 60:
            return
        self.refresh()

    def refresh(self) -> None:
        if not self.refresh_token:
            return
        url = f"https://securetoken.googleapis.com/v1/token?key={self.api_key}"
        payload = {"grant_type": "refresh_token", "refresh_token": self.refresh_token}
        res = requests.post(url, data=payload, timeout=15)
        self._raise_for_firebase_error(res)
        data = res.json()
        self.id_token = data["id_token"]
        self.refresh_token = data["refresh_token"]
        self._last_login_at = time.time()

    @staticmethod
    def _raise_for_firebase_error(res: requests.Response) -> None:
        if res.ok:
            return
        try:
            body = res.json()
            message = (
                body.get("error", {}).get("message")
                or body.get("error_description")
                or str(body)
            )
        except ValueError:
            message = res.text
        raise RuntimeError(f"Firebase auth error ({res.status_code}): {message}")


class OmwayTrayListener:
    def __init__(self) -> None:
        self.stop_event = threading.Event()
        self.session_lock = threading.Lock()
        self.fb = FirebaseSession(API_KEY)
        self.state = LocalState(STATE_FILE)
        self.last_command_id = ""
        self.device_name = socket.gethostname()
        self.tray_icon: pystray.Icon | None = None
        self.online = False

    @property
    def pc_id(self) -> str:
        return (self.state.get("pc_id") or DEFAULT_PC_ID).strip() or DEFAULT_PC_ID

    def db_url(self, path: str) -> str:
        return f"{DB_URL}/{path}.json?auth={self.fb.id_token}"

    @staticmethod
    def is_valid_username(username: str) -> bool:
        return bool(re.fullmatch(r"[a-zA-Z0-9_]{3,20}", username or ""))

    def run(self) -> None:
        self.validate_env()
        self.try_auto_login()
        worker = threading.Thread(target=self.worker_loop, daemon=True)
        worker.start()
        self.start_tray()

    def validate_env(self) -> None:
        missing = []
        for key, value in {"OMWAY_FIREBASE_API_KEY": API_KEY, "OMWAY_FIREBASE_DB_URL": DB_URL}.items():
            if not value:
                missing.append(key)
        if missing:
            raise RuntimeError(f"Missing env vars: {', '.join(missing)}")

    def try_auto_login(self) -> None:
        email = (self.state.get("email") or "").strip()
        remember = bool(self.state.get("remember_login", True))
        if not email or not remember:
            print("Auto login skipped (no remembered account).")
            return
        password = self.state.get_password(email)
        if not password:
            print("Auto login skipped (no saved password in keyring).")
            return
        try:
            self.login(email, password, remember_login=True)
            print(f"Auto login success: {email}")
        except Exception as exc:
            print(f"Auto login failed: {exc}")

    def login(self, email: str, password: str, remember_login: bool) -> None:
        email = email.strip()
        if not email or not password:
            raise RuntimeError("Email and password are required.")
        with self.session_lock:
            self.fb.login(email, password)
            self.last_command_id = ""
            self.online = True
            self.state.set("email", email)
            self.state.set("remember_login", remember_login)
            if remember_login:
                self.state.set_password(email, password)
            else:
                self.state.delete_password(email)
        print(f"Logged in as uid={self.fb.uid} | pc_id={self.pc_id}")

    def register(self, email: str, password: str, username: str) -> None:
        email = email.strip()
        username = username.strip()
        if not email or not password or not username:
            raise RuntimeError("Email, password and username are required.")
        if not self.is_valid_username(username):
            raise RuntimeError("Invalid username. Use 3-20 chars: letters, numbers, underscore.")

        username_key = username.lower()
        with self.session_lock:
            username_check_url = f"{DB_URL}/usernames/{username_key}.json"
            check_res = requests.get(username_check_url, timeout=10)
            check_res.raise_for_status()
            if check_res.json() is not None:
                raise RuntimeError("Username already in use.")

            sign_up_data = self.fb.register(email, password)
            uid = sign_up_data["localId"]
            id_token = sign_up_data["idToken"]
            users_url = f"{DB_URL}/users/{uid}.json?auth={id_token}"
            username_url = f"{DB_URL}/usernames/{username_key}.json?auth={id_token}"

            requests.put(
                users_url,
                json={"email": email, "username": username, "createdAt": int(time.time() * 1000)},
                timeout=10,
            ).raise_for_status()
            requests.put(username_url, json=uid, timeout=10).raise_for_status()

        print(f"Registered new Firebase user: {email} ({username})")

    def logout(self) -> None:
        with self.session_lock:
            email = (self.state.get("email") or "").strip()
            self.online = False
            self.fb.id_token = ""
            self.fb.refresh_token = ""
            self.fb.uid = ""
            if email and not self.state.get("remember_login", True):
                self.state.delete_password(email)

    def worker_loop(self) -> None:
        next_heartbeat_at = 0.0
        while not self.stop_event.is_set():
            try:
                with self.session_lock:
                    has_session = bool(self.fb.id_token and self.fb.uid)

                if not has_session:
                    time.sleep(POLL_SECONDS)
                    continue

                self.fb.maybe_refresh()
                now = time.time()
                if now >= next_heartbeat_at:
                    self.send_heartbeat()
                    next_heartbeat_at = now + HEARTBEAT_SECONDS
                self.check_commands()
            except requests.RequestException as exc:
                print(f"Network/Firebase error: {exc}")
                self.online = False
            except Exception as exc:
                print(f"Unexpected error: {exc}")
                self.online = False

            time.sleep(POLL_SECONDS)

    def send_heartbeat(self) -> None:
        payload = {
            "pcId": self.pc_id,
            "deviceName": self.device_name,
            "lastSeenAt": int(time.time() * 1000),
            "status": "online",
        }
        url = self.db_url(f"presence/{self.fb.uid}/{self.pc_id}")
        requests.put(url, json=payload, timeout=10).raise_for_status()
        self.online = True

    def check_commands(self) -> None:
        url = self.db_url(f"commands/{self.fb.uid}/{self.pc_id}/latest")
        res = requests.get(url, timeout=10)
        res.raise_for_status()
        cmd = res.json()
        if not cmd:
            return
        command_id = cmd.get("commandId", "")
        if not command_id or command_id == self.last_command_id:
            return
        self.last_command_id = command_id
        self.handle_command(cmd)

    def handle_command(self, cmd: dict[str, Any]) -> None:
        cmd_type = cmd.get("type")
        print(f"Command received: {cmd_type}")
        if cmd_type == "open_test_file":
            self.open_test_file()
            self.write_ack("ok", "Opened test file.")
            return
        self.write_ack("ignored", f"Unknown command type: {cmd_type}")

    def open_test_file(self) -> None:
        if not os.path.exists(TEST_FILE_PATH):
            with open(TEST_FILE_PATH, "a", encoding="utf-8"):
                pass
        os.startfile(TEST_FILE_PATH)

    def write_ack(self, status: str, message: str) -> None:
        payload = {"status": status, "message": message, "at": int(time.time() * 1000)}
        url = self.db_url(f"commands/{self.fb.uid}/{self.pc_id}/ack")
        requests.put(url, json=payload, timeout=10).raise_for_status()

    def start_tray(self) -> None:
        image = self.create_image()
        menu = pystray.Menu(
            pystray.MenuItem("Settings", self.on_settings),
            pystray.MenuItem("Link Discord", self.on_link_discord),
            pystray.MenuItem("Open test file", self.on_open_test_file),
            pystray.MenuItem("Exit", self.on_exit),
        )
        self.tray_icon = pystray.Icon("omway-listener", image, "Omway Listener", menu)
        self.tray_icon.run()

    def on_settings(self, icon: pystray.Icon, item: pystray.MenuItem) -> None:
        del icon, item
        self.open_settings_window()

    def on_link_discord(self, icon: pystray.Icon, item: pystray.MenuItem) -> None:
        del icon, item
        try:
            self.link_discord()
        except Exception as exc:
            print(f"Discord link error: {exc}")
            self.notify(f"Discord link error: {exc}")

    def link_discord(self) -> None:
        if not self.fb.uid or not self.fb.id_token:
            raise RuntimeError("Login required before linking Discord.")
        if not DISCORD_CLIENT_ID:
            raise RuntimeError("Missing OMWAY_DISCORD_CLIENT_ID in pc_client/.env")

        state = secrets.token_urlsafe(18)
        request_payload = {
            "state": state,
            "requestedAt": int(time.time() * 1000),
            "pcId": self.pc_id,
            "deviceName": self.device_name,
            "status": "pending_user_auth",
            "redirectUri": DISCORD_REDIRECT_URI,
            "scope": DISCORD_SCOPES,
        }
        url = self.db_url(f"integrations/discord/linkRequests/{self.fb.uid}/{self.pc_id}")
        requests.put(url, json=request_payload, timeout=10).raise_for_status()

        scopes = DISCORD_SCOPES.strip().replace(" ", "%20")
        redirect_uri = requests.utils.quote(DISCORD_REDIRECT_URI, safe="")
        oauth_url = (
            "https://discord.com/api/oauth2/authorize"
            f"?client_id={DISCORD_CLIENT_ID}"
            "&response_type=code"
            f"&redirect_uri={redirect_uri}"
            f"&scope={scopes}"
            f"&state={state}"
            "&prompt=consent"
        )
        webbrowser.open(oauth_url, new=2)
        self.state.set("discord_last_link_at", int(time.time() * 1000))
        self.notify("Discord auth opened in browser.")

    def on_open_test_file(self, icon: pystray.Icon, item: pystray.MenuItem) -> None:
        del icon, item
        try:
            self.open_test_file()
        except Exception as exc:
            print(f"Error opening test file: {exc}")
            self.notify(f"Error opening test file: {exc}")

    def on_exit(self, icon: pystray.Icon, item: pystray.MenuItem) -> None:
        del item
        self.stop_event.set()
        icon.stop()

    def open_settings_window(self) -> None:
        def run_window() -> None:
            root = tk.Tk()
            root.title("Omway Listener Settings")
            root.geometry("560x500")
            root.resizable(False, False)
            root.configure(bg="#E8F0FE")

            status_var = tk.StringVar(value=self.current_status_label())
            email_var = tk.StringVar(value=(self.state.get("email") or ""))
            password_var = tk.StringVar(value="")
            reg_email_var = tk.StringVar(value="")
            reg_password_var = tk.StringVar(value="")
            reg_repeat_var = tk.StringVar(value="")
            reg_username_var = tk.StringVar(value="")
            pc_id_var = tk.StringVar(value=self.pc_id)
            remember_var = tk.BooleanVar(value=bool(self.state.get("remember_login", True)))

            palette = {
                "bg": "#E8F0FE",
                "card": "#FFFFFF",
                "text": "#1F2937",
                "muted": "#6B7280",
                "blue": "#4285F4",
                "blue_dark": "#1A73E8",
                "green": "#34A853",
                "danger": "#EA4335",
                "line": "#D2E3FC",
            }

            frame = tk.Frame(root, padx=18, pady=18, bg=palette["bg"])
            frame.pack(fill=tk.BOTH, expand=True)

            card = tk.Frame(frame, bg=palette["card"], padx=22, pady=18, highlightthickness=1, highlightbackground=palette["line"])
            card.pack(fill=tk.BOTH, expand=True)

            tk.Label(
                card,
                text="Omway",
                bg=palette["card"],
                fg=palette["blue_dark"],
                font=("Segoe UI", 22, "bold"),
            ).pack(anchor="w")
            tk.Label(
                card,
                text="Controla tu listener de escritorio",
                bg=palette["card"],
                fg=palette["muted"],
                font=("Segoe UI", 10),
                pady=2,
            ).pack(anchor="w")

            def apply_pc_id() -> None:
                pc_id = pc_id_var.get().strip() or DEFAULT_PC_ID
                self.state.set("pc_id", pc_id)
                self.notify(f"PC ID saved: {pc_id}")

            def show_toast(title: str, body: str) -> None:
                toast = tk.Toplevel(root)
                toast.title("")
                toast.geometry("360x170")
                toast.resizable(False, False)
                toast.transient(root)
                toast.grab_set()
                wrap = tk.Frame(toast, padx=16, pady=14, bg="#ffffff")
                wrap.pack(fill=tk.BOTH, expand=True)
                tk.Label(
                    wrap,
                    text=title,
                    font=("Segoe UI", 13, "bold"),
                    bg="#ffffff",
                    fg=palette["text"],
                ).pack(anchor="w")
                tk.Label(
                    wrap,
                    text=body,
                    justify=tk.LEFT,
                    wraplength=320,
                    fg=palette["muted"],
                    bg="#ffffff",
                    pady=8,
                ).pack(anchor="w")
                tk.Button(
                    wrap,
                    text="OK",
                    width=10,
                    bg=palette["blue"],
                    fg="white",
                    relief=tk.FLAT,
                    activebackground=palette["blue_dark"],
                    activeforeground="white",
                    command=toast.destroy,
                ).pack(anchor="e", pady=(6, 0))

            def do_login() -> None:
                email = email_var.get().strip()
                password = password_var.get().strip()
                try:
                    apply_pc_id()
                    self.login(email, password, remember_var.get())
                    status_var.set(self.current_status_label())
                    refresh_auth_actions()
                    show_toast("Sesion iniciada", "Login correcto.")
                except Exception as exc:
                    messagebox.showerror("Login error", str(exc))

            def do_register() -> None:
                email = reg_email_var.get().strip()
                password = reg_password_var.get().strip()
                repeat_password = reg_repeat_var.get().strip()
                username = reg_username_var.get().strip()
                if not email or not password or not repeat_password or not username:
                    messagebox.showerror("Register error", "Completa todos los campos.")
                    return
                if len(password) < 6:
                    messagebox.showerror("Register error", "Password must be at least 6 characters.")
                    return
                if password != repeat_password:
                    messagebox.showerror("Register error", "Passwords do not match.")
                    return
                try:
                    self.register(email, password, username)
                    reg_email_var.set("")
                    reg_password_var.set("")
                    reg_repeat_var.set("")
                    reg_username_var.set("")
                    show_login_view()
                    show_toast("Cuenta creada", "Cuenta creada correctamente. Ya puedes iniciar sesion.")
                except Exception as exc:
                    messagebox.showerror("Register error", str(exc))

            def do_logout() -> None:
                self.logout()
                status_var.set(self.current_status_label())
                refresh_auth_actions()
                show_toast("Sesion cerrada", "Logout correcto.")

            def do_link_discord() -> None:
                try:
                    self.link_discord()
                    show_toast("Discord", "Discord OAuth opened in browser.\nFinish auth there.")
                except Exception as exc:
                    messagebox.showerror("Discord", str(exc))

            view_wrap = tk.Frame(card, bg=palette["card"])
            view_wrap.pack(fill=tk.BOTH, expand=True, pady=(14, 0))
            login_view = tk.Frame(view_wrap, bg=palette["card"])
            register_view = tk.Frame(view_wrap, bg=palette["card"])

            def clear_views() -> None:
                login_view.pack_forget()
                register_view.pack_forget()

            def show_login_view() -> None:
                clear_views()
                login_view.pack(fill=tk.BOTH, expand=True)

            def show_register_view() -> None:
                clear_views()
                register_view.pack(fill=tk.BOTH, expand=True)

            def create_field(parent: tk.Frame, row: int, label: str, variable: tk.StringVar, masked: bool = False) -> None:
                tk.Label(
                    parent,
                    text=label,
                    bg=palette["card"],
                    fg=palette["text"],
                    font=("Segoe UI", 10),
                ).grid(row=row, column=0, sticky="w", pady=(10, 0))
                tk.Entry(
                    parent,
                    width=38,
                    textvariable=variable,
                    show="*" if masked else "",
                    relief=tk.FLAT,
                    highlightthickness=1,
                    highlightbackground=palette["line"],
                    highlightcolor=palette["blue"],
                    bg="#F8FAFF",
                    fg=palette["text"],
                    insertbackground=palette["text"],
                    font=("Segoe UI", 10),
                ).grid(row=row, column=1, sticky="w", pady=(10, 0), ipady=4)

            tk.Label(login_view, text="Status", bg=palette["card"], fg=palette["text"], font=("Segoe UI", 10, "bold")).grid(row=0, column=0, sticky="w")
            tk.Label(login_view, textvariable=status_var, fg=palette["green"], bg=palette["card"], font=("Segoe UI", 10, "bold")).grid(
                row=0, column=1, sticky="w"
            )
            create_field(login_view, 1, "Email", email_var)
            create_field(login_view, 2, "Password", password_var, masked=True)
            create_field(login_view, 3, "PC ID", pc_id_var)
            tk.Checkbutton(
                login_view,
                text="Remember login on this PC",
                variable=remember_var,
                bg=palette["card"],
                fg=palette["muted"],
                activebackground=palette["card"],
                activeforeground=palette["muted"],
                selectcolor="#F8FAFF",
                font=("Segoe UI", 9),
            ).grid(row=4, column=1, sticky="w", pady=(10, 0))

            tk.Button(
                login_view,
                text="Iniciar sesion",
                width=16,
                bg=palette["blue"],
                fg="white",
                relief=tk.FLAT,
                activebackground=palette["blue_dark"],
                activeforeground="white",
                font=("Segoe UI", 10, "bold"),
                command=do_login,
            ).grid(
                row=5, column=1, sticky="w", pady=(14, 0)
            )
            register_link = tk.Label(
                login_view,
                text="Registrarse",
                fg=palette["blue_dark"],
                cursor="hand2",
                font=("Segoe UI", 9, "underline"),
                bg=palette["card"],
            )
            register_link.grid(row=6, column=1, sticky="w", pady=(8, 0))
            register_link.bind("<Button-1>", lambda _evt: show_register_view())

            login_bottom = tk.Frame(login_view, bg=palette["card"])
            login_bottom.grid(row=7, column=1, sticky="w", pady=(14, 0))
            auth_actions = tk.Frame(login_bottom, bg=palette["card"])
            logout_btn = tk.Button(
                auth_actions,
                text="Logout",
                width=10,
                bg=palette["danger"],
                fg="white",
                relief=tk.FLAT,
                activebackground="#D93025",
                activeforeground="white",
                font=("Segoe UI", 9, "bold"),
                command=do_logout,
            )
            logout_btn.pack(side=tk.LEFT)
            discord_btn = tk.Button(
                auth_actions,
                text="Link Discord",
                width=12,
                bg="#202124",
                fg="white",
                relief=tk.FLAT,
                activebackground="#111827",
                activeforeground="white",
                font=("Segoe UI", 9, "bold"),
                command=do_link_discord,
            )
            discord_btn.pack(side=tk.LEFT, padx=(8, 0))
            close_btn = tk.Button(
                login_bottom,
                text="Close",
                width=10,
                relief=tk.FLAT,
                bg="#DCE3F8",
                fg=palette["text"],
                activebackground="#C7D2FE",
                activeforeground=palette["text"],
                command=root.destroy,
            )
            close_btn.pack(side=tk.LEFT, padx=(8, 0))

            def refresh_auth_actions() -> None:
                is_logged = bool(self.fb.uid)
                if is_logged:
                    auth_actions.pack(side=tk.LEFT)
                    close_btn.pack_forget()
                    close_btn.pack(side=tk.LEFT, padx=(8, 0))
                else:
                    auth_actions.pack_forget()
                    close_btn.pack_forget()
                    close_btn.pack(side=tk.LEFT)

            back_link = tk.Label(
                register_view,
                text="Volver",
                fg=palette["blue_dark"],
                cursor="hand2",
                font=("Segoe UI", 9, "underline"),
                bg=palette["card"],
            )
            back_link.grid(row=0, column=1, sticky="w")
            back_link.bind("<Button-1>", lambda _evt: show_login_view())
            create_field(register_view, 1, "Email", reg_email_var)
            create_field(register_view, 2, "Password", reg_password_var, masked=True)
            create_field(register_view, 3, "Repetir password", reg_repeat_var, masked=True)
            create_field(register_view, 4, "Nombre usuario (unico)", reg_username_var)
            tk.Button(
                register_view,
                text="Registrar",
                width=16,
                bg=palette["blue"],
                fg="white",
                relief=tk.FLAT,
                activebackground=palette["blue_dark"],
                activeforeground="white",
                font=("Segoe UI", 10, "bold"),
                command=do_register,
            ).grid(
                row=5, column=1, sticky="w", pady=(14, 0)
            )
            tk.Button(
                register_view,
                text="Close",
                width=10,
                relief=tk.FLAT,
                bg="#DCE3F8",
                fg=palette["text"],
                activebackground="#C7D2FE",
                activeforeground=palette["text"],
                command=root.destroy,
            ).grid(
                row=6, column=1, sticky="w", pady=(10, 0)
            )

            refresh_auth_actions()
            show_login_view()

            root.mainloop()

        threading.Thread(target=run_window, daemon=True).start()

    def current_status_label(self) -> str:
        email = self.state.get("email") or "-"
        if self.fb.uid and self.online:
            return f"ONLINE as {email}"
        if self.fb.uid:
            return f"LOGGED as {email}"
        return "NOT LOGGED"

    def notify(self, message: str) -> None:
        print(message)
        if self.tray_icon:
            try:
                self.tray_icon.notify(message, "Omway")
            except Exception:
                pass

    @staticmethod
    def create_image() -> Image.Image:
        image = Image.new("RGB", (64, 64), "#0B1220")
        draw = ImageDraw.Draw(image)
        draw.ellipse((8, 8, 56, 56), fill="#0891B2")
        draw.rectangle((26, 18, 38, 46), fill="#FFFFFF")
        return image


def main() -> None:
    app = OmwayTrayListener()
    app.run()


if __name__ == "__main__":
    main()
