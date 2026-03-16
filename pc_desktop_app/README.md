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
2. Fill Firebase and Discord values.
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
- Next integration step: connect this UI to the listener runtime/config directly.

## Discord env vars

Use these keys in `pc_desktop_app/.env`:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` (default: `http://127.0.0.1:53682/callback`)
- `DISCORD_SCOPES` (default: `identify guilds`)

The app links the signed-in Omway user to their Discord account via OAuth, then uses:
- linked Discord user id
- bot token

to:
- load guilds shared with that linked user
- list voice channels in a selected guild
- send mute/deafen actions to that member
