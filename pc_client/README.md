# PC Listener (Windows Tray)

The listener runs in Windows tray and keeps the PC connected to Omway.

## Features

- Tray app with background worker
- Settings window from tray icon
- Login and register with Firebase Auth (email/password)
- Session persistence using local state + Windows keyring
- Presence heartbeat to Realtime Database
- Command execution (`open_test_file`)
- Discord link bootstrap (opens OAuth URL + stores link request metadata)

## Setup

1. Copy `pc_client/.env.example` to `pc_client/.env`.
2. Fill at least:

```env
OMWAY_FIREBASE_DB_URL=...
OMWAY_FIREBASE_API_KEY=...
```

Optional:

```env
OMWAY_PC_ID=pc-main
OMWAY_POLL_SECONDS=3
OMWAY_HEARTBEAT_SECONDS=10
OMWAY_TEST_FILE_PATH=C:\Users\kakyg\Desktop\prueba.txt
OMWAY_DISCORD_CLIENT_ID=
OMWAY_DISCORD_REDIRECT_URI=http://127.0.0.1:53682/callback
OMWAY_DISCORD_SCOPES=identify guilds
```

3. Install dependencies:

```bash
pip install -r requirements.txt
```

4. Run:

```bash
py listener.py
```

## Usage

1. Open Windows hidden icons (`^`).
2. Right click `Omway Listener`.
3. Click `Settings`.
4. Use:
   - `Login`
   - `Register`
   - `Logout`
   - `Link Discord`

## Local storage

- `.omway_state.json` stores non-sensitive state (email, pc_id, preferences).
- Password is stored via Windows keyring (if available).

## Troubleshooting

- `API key not valid`: wrong `OMWAY_FIREBASE_API_KEY`
- `404 on presence/...`: wrong database URL
- `Login required before linking Discord`: login first in settings window
