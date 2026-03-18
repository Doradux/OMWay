# Omway

Omway connects your iPhone and your gaming PC so you can prepare your setup remotely.

Current MVP features:
- Firebase Auth login (email/password) on mobile and PC listener
- Mobile friends system (send request, accept/reject, friend list)
- PC online presence detection per user account
- iOS command button (`Prueba`) to trigger an action on a selected PC
- Central API backend (`server/`) to broker mobile <-> PC messages
- Windows tray listener running in background (hidden icons)
- PC tray settings window (login/register/logout)
- Local session persistence on PC (keyring + local state)
- Discord link bootstrap from tray
- Optional modern desktop UI module (Electron + React + Tailwind) in `pc_desktop_app/`

## Project Status

This repository is in MVP stage and focused on validating:
1. Account-based pairing between mobile and PC
2. Real-time command delivery through Firebase Realtime Database
3. Reliable background listener behavior on Windows

## Architecture

- Mobile app (Expo React Native): `App.js`
- API backend (Express + WebSocket): `server/src/index.js`
- Firebase bootstrap: `src/firebase.js`
- Windows tray listener: `pc_client/listener.py`
- Desktop app runtime (PC websocket client): `pc_desktop_app/src/App.jsx`

Data paths:
- `presence/{uid}/{pcId}`: last seen/status for each PC
- `presenceChecks/{uid}/{pcId}`: on-demand ping request from mobile
- `commands/{uid}/{pcId}/latest`: latest command from mobile
- `commands/{uid}/{pcId}/ack`: command execution result

## Requirements

- Node.js 20+
- npm
- Python 3.13+ recommended
- Firebase project with:
  - Authentication (Email/Password)
  - Realtime Database

## Firebase Setup

1. Enable `Authentication -> Sign-in method -> Email/Password`.
2. Create at least one test user in `Authentication -> Users`.
3. Create Realtime Database.
4. Apply rules:

```json
{
  "rules": {
    "presence": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "commands": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "presenceChecks": {
      "$uid": {
        "$pcId": {
          ".read": "auth != null && auth.uid === $uid",
          ".write": "auth != null && auth.uid === $uid"
        }
      }
    },
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid",
        "friends": {
          "$friendUid": {
            ".read": "auth != null && (auth.uid === $uid || auth.uid === $friendUid)",
            ".write": "auth != null && (auth.uid === $uid || auth.uid === $friendUid)"
          }
        }
      }
    },
    "friendRequests": {
      "$uid": {
        "incoming": {
          "$fromUid": {
            ".read": "auth != null && (auth.uid === $uid || auth.uid === $fromUid)",
            ".write": "auth != null && (auth.uid === $uid || auth.uid === $fromUid)"
          }
        },
        "outgoing": {
          "$toUid": {
            ".read": "auth != null && (auth.uid === $uid || auth.uid === $toUid)",
            ".write": "auth != null && (auth.uid === $uid || auth.uid === $toUid)"
          }
        }
      }
    },
    "usernames": {
      "$username": {
        ".read": true,
        ".write": "auth != null && !data.exists()"
      }
    }
  }
}
```

## Environment Variables

Copy templates:
- `.env.example` -> `.env`
- `pc_client/.env.example` -> `pc_client/.env`
- `server/.env.example` -> `server/.env`

Fill values from your Firebase project:
- Mobile app uses `EXPO_PUBLIC_FIREBASE_*`
- Mobile app also needs `EXPO_PUBLIC_OMWAY_API_BASE_URL`
- PC listener uses `OMWAY_*`
- Desktop app needs `VITE_OMWAY_API_BASE_URL`
- Server uses `FIREBASE_*` service-account vars
- Discord secrets (`DISCORD_*`) live only in `server/.env`

## Run (Local)

### 1) Start backend API

```bash
cd server
npm install
npm run dev
```

Expected:
- API serves HTTP + WebSocket on `http://localhost:8080`

### 2) Start desktop app

```bash
cd pc_desktop_app
npm install
npm run dev
```

Expected:
- desktop app logs in and registers current PC socket to API
- app responds to on-demand presence checks from mobile

### 3) Start mobile app

```bash
npm install
npm start
```

Open in Expo Go on iPhone and log in with the same Firebase account used by desktop app.

## Security Notes

- Never commit `.env` files.
- API keys are project identifiers, but account credentials are sensitive.
- If a token/password was pasted in logs or chats, rotate credentials.
- Before production, move PC credential storage to secure local storage (not plain `.env`).

## Next Milestones

1. Complete Discord OAuth callback/token exchange backend
2. Auto-start listener on Windows startup
3. Device management (rename/remove PCs)
4. Discord voice actions and party intents
