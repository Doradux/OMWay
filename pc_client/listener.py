import os
import socket
import threading
import time
from typing import Any

import requests
from dotenv import load_dotenv
from PIL import Image, ImageDraw
import pystray

load_dotenv()

API_KEY = os.getenv("OMWAY_FIREBASE_API_KEY", "")
DB_URL = os.getenv("OMWAY_FIREBASE_DB_URL", "").rstrip("/")
EMAIL = os.getenv("OMWAY_EMAIL", "")
PASSWORD = os.getenv("OMWAY_PASSWORD", "")
PC_ID = os.getenv("OMWAY_PC_ID", "pc-main")
POLL_SECONDS = float(os.getenv("OMWAY_POLL_SECONDS", "3"))
HEARTBEAT_SECONDS = float(os.getenv("OMWAY_HEARTBEAT_SECONDS", "10"))
TEST_FILE_PATH = os.getenv(
    "OMWAY_TEST_FILE_PATH", r"C:\Users\kakyg\Desktop\prueba.txt"
)


class FirebaseSession:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self.id_token = ""
        self.refresh_token = ""
        self.uid = ""
        self._last_login_at = 0.0

    def login(self, email: str, password: str) -> None:
        url = (
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
            f"?key={self.api_key}"
        )
        payload = {
            "email": email,
            "password": password,
            "returnSecureToken": True,
        }
        res = requests.post(url, json=payload, timeout=15)
        self._raise_for_firebase_error(res)
        data = res.json()

        self.id_token = data["idToken"]
        self.refresh_token = data["refreshToken"]
        self.uid = data["localId"]
        self._last_login_at = time.time()

    def maybe_refresh(self) -> None:
        # Firebase ID token lasts about 1 hour.
        if time.time() - self._last_login_at < 45 * 60:
            return
        self.refresh()

    def refresh(self) -> None:
        if not self.refresh_token:
            return
        url = f"https://securetoken.googleapis.com/v1/token?key={self.api_key}"
        payload = {
            "grant_type": "refresh_token",
            "refresh_token": self.refresh_token,
        }
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
        self.fb = FirebaseSession(API_KEY)
        self.last_command_id = ""
        self.device_name = socket.gethostname()
        self.tray_icon: pystray.Icon | None = None

    def db_url(self, path: str) -> str:
        return f"{DB_URL}/{path}.json?auth={self.fb.id_token}"

    def run(self) -> None:
        self.validate_env()
        self.fb.login(EMAIL, PASSWORD)
        print(f"Logged in as uid={self.fb.uid} | pc_id={PC_ID}")

        worker = threading.Thread(target=self.worker_loop, daemon=True)
        worker.start()

        self.start_tray()

    def validate_env(self) -> None:
        missing = []
        for key, value in {
            "OMWAY_FIREBASE_API_KEY": API_KEY,
            "OMWAY_FIREBASE_DB_URL": DB_URL,
            "OMWAY_EMAIL": EMAIL,
            "OMWAY_PASSWORD": PASSWORD,
        }.items():
            if not value:
                missing.append(key)
        if missing:
            raise RuntimeError(f"Missing env vars: {', '.join(missing)}")

    def worker_loop(self) -> None:
        next_heartbeat_at = 0.0
        while not self.stop_event.is_set():
            try:
                self.fb.maybe_refresh()
                now = time.time()

                if now >= next_heartbeat_at:
                    self.send_heartbeat()
                    next_heartbeat_at = now + HEARTBEAT_SECONDS

                self.check_commands()
            except requests.RequestException as exc:
                print(f"Network/Firebase error: {exc}")
            except Exception as exc:
                print(f"Unexpected error: {exc}")

            time.sleep(POLL_SECONDS)

    def send_heartbeat(self) -> None:
        payload = {
            "pcId": PC_ID,
            "deviceName": self.device_name,
            "lastSeenAt": int(time.time() * 1000),
            "status": "online",
        }
        url = self.db_url(f"presence/{self.fb.uid}/{PC_ID}")
        requests.put(url, json=payload, timeout=10).raise_for_status()

    def check_commands(self) -> None:
        url = self.db_url(f"commands/{self.fb.uid}/{PC_ID}/latest")
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
        else:
            self.write_ack("ignored", f"Unknown command type: {cmd_type}")

    def open_test_file(self) -> None:
        if not os.path.exists(TEST_FILE_PATH):
            with open(TEST_FILE_PATH, "a", encoding="utf-8"):
                pass
        os.startfile(TEST_FILE_PATH)

    def write_ack(self, status: str, message: str) -> None:
        payload = {
            "status": status,
            "message": message,
            "at": int(time.time() * 1000),
        }
        url = self.db_url(f"commands/{self.fb.uid}/{PC_ID}/ack")
        requests.put(url, json=payload, timeout=10).raise_for_status()

    def start_tray(self) -> None:
        image = self.create_image()
        menu = pystray.Menu(
            pystray.MenuItem("Open test file", self.on_open_test_file),
            pystray.MenuItem("Exit", self.on_exit),
        )
        self.tray_icon = pystray.Icon("omway-listener", image, "Omway Listener", menu)
        self.tray_icon.run()

    def on_open_test_file(self, icon: pystray.Icon, item: pystray.MenuItem) -> None:
        del icon, item
        try:
            self.open_test_file()
        except Exception as exc:
            print(f"Error opening test file: {exc}")

    def on_exit(self, icon: pystray.Icon, item: pystray.MenuItem) -> None:
        del item
        self.stop_event.set()
        icon.stop()

    @staticmethod
    def create_image() -> Image.Image:
        width = 64
        height = 64
        image = Image.new("RGB", (width, height), "#0B1220")
        draw = ImageDraw.Draw(image)
        draw.ellipse((8, 8, 56, 56), fill="#0891B2")
        draw.rectangle((26, 18, 38, 46), fill="#FFFFFF")
        return image


def main() -> None:
    app = OmwayTrayListener()
    app.run()


if __name__ == "__main__":
    main()
