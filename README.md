# Omway

Omway connects your iPhone and your gaming PC so you can prepare your setup remotely.

Current MVP features:
- Firebase Auth login (email/password) on mobile and PC listener
- PC online presence detection per user account
- iOS command button (`Prueba`) to trigger an action on a selected PC
- Windows tray listener running in background (hidden icons)

## Project Status

This repository is in MVP stage and focused on validating:
1. Account-based pairing between mobile and PC
2. Real-time command delivery through Firebase Realtime Database
3. Reliable background listener behavior on Windows

## Architecture

- Mobile app (Expo React Native): `App.js`
- Firebase bootstrap: `src/firebase.js`
- Windows tray listener: `pc_client/listener.py`

Data paths:
- `presence/{uid}/{pcId}`: heartbeat and online state
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
    }
  }
}
```

## Environment Variables

Copy templates:
- `.env.example` -> `.env`
- `pc_client/.env.example` -> `pc_client/.env`

Fill values from your Firebase project:
- Mobile app uses `EXPO_PUBLIC_FIREBASE_*`
- PC listener uses `OMWAY_*`

## Run (Local)

### 1) Start PC listener

```bash
cd pc_client
pip install -r requirements.txt
py listener.py
```

Expected:
- tray icon appears in Windows hidden icons
- listener sends presence heartbeat

### 2) Start mobile app

```bash
npm install
npm start
```

Open in Expo Go on iPhone and log in with the same Firebase account used by listener.

## Security Notes

- Never commit `.env` files.
- API keys are project identifiers, but account credentials are sensitive.
- If a token/password was pasted in logs or chats, rotate credentials.
- Before production, move PC credential storage to secure local storage (not plain `.env`).

## Next Milestones

1. PC tray settings window (login/register UI)
2. Auto-start listener on Windows startup
3. Device management (rename/remove PCs)
4. Discord account linking and voice actions
