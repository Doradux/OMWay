# Omway Server

Central backend for Omway clients.

## Features

- Firebase ID token verification (Firebase Admin)
- REST API for:
  - profile (`/me`)
  - PC refresh check (`/pcs/refresh`)
  - send test command (`/commands/test`)
  - friends (`/friends`, `/friends/request`, `/friends/revoke`, `/friends/respond`)
- WebSocket `/ws/pc` for desktop PC presence checks

## Setup

1. Copy `.env.example` to `.env`.
2. Fill Firebase service account fields.
3. Fill Discord server-side secrets (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`).
3. Install and run:

```bash
npm install
npm run dev
```

Server listens on `http://localhost:8080` by default.
