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

## PostgreSQL persistence

Accounts, sessions, bookings, reviews, feedback, and driver telemetry are stored
in PostgreSQL. The schema in `schema.sql` is applied automatically on boot (or on
the first request when running serverless), guarded by an advisory lock so
concurrent cold starts cannot collide.

1. Start a local PostgreSQL 16 instance and create the database referenced by
   `DATABASE_URL`, e.g.:

   ```bash
   docker run -d --name velofox-postgres \
     -e POSTGRES_USER=user \
     -e POSTGRES_PASSWORD=password \
     -e POSTGRES_DB=velofox \
     -p 5432:5432 postgres:16-alpine
   ```

2. Set `DATABASE_URL=postgres://user:password@localhost:5432/velofox` in `.env`.
3. Run `npm start`. `GET /api/health` reports `"database": "connected"` when the
   pool is reachable.

Session cookies store a random token; only its SHA-256 hash is written to the
`sessions` table, and expired sessions are pruned as new ones are created.

## Deploying to Vercel

`vercel.json` uses `@vercel/node` with `public/**` included in the function
bundle. The app exports the Express handler, so serverless invocations and
`node server.js` both work.

```bash
vercel login
vercel link
vercel env add DATABASE_URL production
vercel env add DISPATCHER_INVITE_CODE production
vercel env add APP_BASE_URL production   # https://<your-project>.vercel.app
vercel env add SESSION_TTL_HOURS production   # optional, defaults to 12
vercel --prod
```

Use a **pooled** PostgreSQL connection string (Neon `-pooler` host, Supabase
port `6543`, or Vercel Postgres) because serverless functions open many short
connections. `lib/db.js` caps the pool at one connection per instance when
`process.env.VERCEL` is set, and enables SSL automatically for any non-local
host. Re-run `vercel --prod` after changing environment variables so the new
values are baked into the deployment.

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

