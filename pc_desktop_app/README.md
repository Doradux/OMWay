# Omway Desktop UI

Modern desktop panel for Omway built with Electron + React + Tailwind.

## What you get

- Attractive login/register flow
- Distinct views:
  - Login: email/password + `Registrarse` link
  - Register: volver + email/password/repeat/username + register button
- Username uniqueness check (`/usernames/{username}`)
- Success/error feedback via modal toast
- Logged-in state actions:
  - `Link Discord`
  - `Logout`
- Tray behavior:
  - close window -> app stays in tray
  - reopen from tray icon

## Setup

1. Copy `.env.example` to `.env`.
2. Fill Firebase, API and Discord values.
3. Install dependencies:

```bash
npm install
```

4. Run dev:

```bash
npm run dev
```

## Notes

- This module is separate from the existing Python listener.
- Presence availability is now connected to `server/` through WebSocket (`/ws/pc`).
- Required env: `VITE_OMWAY_API_BASE_URL` (example: `http://127.0.0.1:8080`).

## Discord note

Discord secrets are no longer required in desktop `.env`.
OAuth + bot actions are handled by `server/` using server-side env vars.
