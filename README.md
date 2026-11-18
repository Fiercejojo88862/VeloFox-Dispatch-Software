# VeloFox Dispatch Software

## Local access setup

Copy the environment template before starting the app:

```bash
cp .env.example .env
```

Set `DISPATCHER_INVITE_CODE` in `.env` to a long private value shared only with
authorized dispatch staff, then start the server:

```bash
npm start
```

Open `/login.html` and choose a role. Client accounts can be created directly.
Dispatcher account creation requires the configured invite code.

Dispatcher password resets are requested from `/forgot-password.html`. In local
development, the one-time reset link is printed in the terminal running the
server. Set `APP_BASE_URL` when the app is not served from `http://localhost:3000`.

The current Express prototype keeps accounts, sessions, bookings, reviews, and
feedback in memory until PostgreSQL is wired into `server.js`; restarting the
server clears those runtime records. `schema.sql` contains the matching durable
database structures.

## Dispatch dashboard features

- **Interface audio** (`public/js/audio-fx.js`): Web Audio chimes for dispatch,
  arrival, completion, and errors. The topbar toggle persists the mute state.
- **Voice commands** (`public/js/voice-command.js`): experimental Web Speech API
  control. Say or type `assign VF-1001 to 1a2b3c4d`, `set ride 1a2b3c4d to en
  route`, `show pending`, `how many completed`, or `help`. Chromium browsers get
  the microphone; Firefox falls back to typed commands using the same parser.
- **Live telemetry radar** (`public/js/telemetry-canvas.js`): relative plot of
  chauffeur GPS fixes from `/api/telemetry`, with active-trip bearings. Arcs are
  directional because pickup/drop-off are free-text addresses.
- **Pricing and analytics**: bookings carry a point-to-point or hourly quote
  (`lib/pricing.js`) with base rate, gratuity, and deposit in integer cents.
  `GET /api/analytics/summary?range=7d|30d|90d|all` powers the financial panel.
  Dispatchers can load demo history from the empty reporting state; the
  `POST /api/demo/history` endpoint is disabled in production unless
  `ALLOW_DEMO_SEED=1`.
- Bookings without a quote receive a vehicle-class default fare so the reporting
  view is never blank.

