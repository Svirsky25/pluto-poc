# Pluto 🐶 — Family Dog Status POC

Monolithic **installable PWA**: an Express + TypeScript + SQLite server that also
serves the compiled React (Vite + TypeScript) client and sends **Web Push**
notifications to the family's phones.

```
pluto-poc/
├── server/   # Express + TypeScript + SQLite (better-sqlite3) + web-push
│   └── src/  # index.ts (API + cron + push triggers), db.ts, push.ts, types.ts
├── client/   # React + Vite + TypeScript PWA (builds to client/dist)
│   ├── public/  # PWA icons + favicon
│   └── src/  # App.tsx, sw.ts (service worker), push.ts, main.tsx, types.ts
├── nixpacks.toml    # Railway build/start config
└── package.json     # root convenience scripts
```

## Setup

```bash
npm run install:all          # installs server + client deps
npm run generate:vapid       # prints a VAPID key pair (for push)
```

Create `server/.env` from `server/.env.example` and paste in the generated keys:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
REMINDER_LEAD_MINUTES=15     # lower (e.g. 1) to demo the reminder quickly
```

> Without VAPID keys the app still runs — push is just disabled (logged at startup).

## Run for review (production-style: server serves the built client)

```bash
npm run build                # installs + builds client -> client/dist, then compiles server
npm start                    # -> http://localhost:3001
```

Open **http://localhost:3001**. `localhost` is a secure context, so the service
worker + push work on desktop Chrome/Edge without HTTPS. Click the address-bar
**install** icon to install the PWA, then **קבל התראות 🔔** to enable push.

## Dev mode (hot reload, two processes)

```bash
npm run dev:server           # Express on :3001 (ts-node-dev)
npm run dev:client           # Vite on :5173, proxies /api -> :3001
```

Open **http://localhost:5173** during development (the SW runs in dev too).

## Features

**Data (SQLite)**
- `dog_status` — singleton row (`id = 1`): `current_status`, `last_update_time`,
  `garden_available_until`, `reminder_sent`.
- `walk_actions` — history log of every action.
- `push_subscriptions` — stored Web Push subscriptions.

**API**
- `GET /api/status` → `current_status`, `last_update_time`,
  `garden_available_until`, computed `remaining_seconds`.
- `POST /api/action` → body `{ "action_type": "PEE_ONLY" | "PEE_AND_POOP" }`.
- `GET /api/vapid-public-key` → public key for the client PushManager.
- `POST /api/subscribe` / `POST /api/unsubscribe` → manage push subscriptions.

**Business logic**
- `PEE_ONLY` → status `PEE_ONLY`, clears the garden window, immediate alert + push.
- `PEE_AND_POOP` → status `READY_FOR_GARDEN`, `garden_available_until` = now + 5h
  (a new press overrides/resets it), immediate alert + push.
- Background job (every 15s):
  - a **reminder** push `REMINDER_LEAD_MINUTES` before the window closes (once);
  - when the window elapses → status `NEEDS_WALK` + delayed **needs-walk** push.

**Notifications (Web Push)** — three triggers: every action, a pre-expiry
reminder, and needs-a-walk. Delivered via the service worker (`client/src/sw.ts`)
so they arrive even when the app is closed.

**Frontend** — single responsive RTL page whose background changes by status
(🟢 READY_FOR_GARDEN / 🟡 PEE_ONLY / 🔴 NEEDS_WALK), a live countdown during the
5-hour window, an enable-notifications button, and two buttons: **רק פיפי** and
**פיפי + קקי**.

## Deploy to Railway

Railway provides the HTTPS domain that Web Push requires on mobile.

1. Push this repo to GitHub and create a Railway project from it (Nixpacks picks
   up `nixpacks.toml` — one service, builds client + server, runs the server).
2. In the service **Variables**, set:
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   - `DATABASE_PATH=/data/pluto.db`
   - optionally `REMINDER_LEAD_MINUTES`
   - (`PORT` is injected by Railway automatically.)
3. Add a **Volume** mounted at `/data` so SQLite (and push subscriptions)
   survive redeploys.
4. Open the generated `https://…up.railway.app` URL on your phone.

**iOS note:** Web Push only works for an **installed** PWA — open the URL in
Safari, **Share → Add to Home Screen**, launch it from the home screen, then tap
**קבל התראות** and allow. Requires iOS 16.4+.
