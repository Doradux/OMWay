# PC Listener (Windows Tray)

This module runs a background listener in Windows system tray and executes commands from Firebase.

## What it does

- Authenticates with Firebase using email/password
- Sends heartbeat to `presence/{uid}/{pcId}`
- Polls `commands/{uid}/{pcId}/latest`
- Executes `open_test_file` command
- Writes ACK to `commands/{uid}/{pcId}/ack`

## Setup

1. Copy `pc_client/.env.example` to `pc_client/.env`.
2. Fill:

```env
OMWAY_FIREBASE_DB_URL=...
OMWAY_FIREBASE_API_KEY=...
OMWAY_EMAIL=...
OMWAY_PASSWORD=...
OMWAY_PC_ID=pc-main
OMWAY_POLL_SECONDS=3
OMWAY_HEARTBEAT_SECONDS=10
OMWAY_TEST_FILE_PATH=C:\Users\kakyg\Desktop\prueba.txt
```

3. Install dependencies:

```bash
pip install -r requirements.txt
```

4. Run:

```bash
py listener.py
```

## Tray usage

- Open Windows hidden icons (`^`)
- Right click `Omway Listener`
- Available options:
  - `Open test file`
  - `Exit`

## Troubleshooting

- `API key not valid`: wrong `OMWAY_FIREBASE_API_KEY`
- `404 on presence/...`: wrong database URL (use exact URL shown in Realtime Database)
- `Missing env vars`: required fields in `.env` are empty
