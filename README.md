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
vercel env add DATABASE_URL --environment production
vercel env add DATABASE_URL_UNPOOLED --environment production
vercel env add DISPATCHER_INVITE_CODE --environment production
vercel env add APP_BASE_URL --environment production   # https://<your-project>.vercel.app
vercel env add SESSION_TTL_HOURS --environment production   # optional, defaults to 12
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
- **Dispatch command console** (`public/js/voice-command.js`): type an action in
  plain English and it runs against the board. Try `assign VF-1001 to 1a2b3c4d`,
  `set ride 1a2b3c4d to en route`, `show me all unassigned rides`,
  `text the client on ride 1a2b3c4d that we're on the way`, `ping the fleet`,
  or `help`. The parser runs entirely in the browser; no microphone or external
  service is involved.
- **Live Leaflet fleet map** (`public/js/telemetry-map.js`): plots real chauffeur
  GPS fixes from `/api/telemetry` on OpenStreetMap tiles, with trip and speed
  details in each marker.
- **Client preferences**: reservations preserve passenger contact details,
  luggage, beverage, preferred-chauffeur, and accessibility/special requests.
  The same details appear in dispatcher, client, and assigned-driver views.
- **Light and dark themes** (`public/js/theme.js`): every page follows the saved
  user preference, with a persistent theme switcher and system-theme fallback.
- **Pricing and analytics**: bookings carry a point-to-point or hourly quote
  (`lib/pricing.js`) with base rate, gratuity, and deposit in integer cents.
  `GET /api/analytics/summary?range=7d|30d|90d|all` powers the financial panel.
  Dispatchers can load demo history from the empty reporting state; the
  `POST /api/demo/history` endpoint is disabled in production unless
  `ALLOW_DEMO_SEED=1`.
- Bookings without a quote receive a vehicle-class default fare so the reporting
  view is never blank.


## Chauffeur access codes and assignment conflicts

Chauffeurs sign in with their Driver ID plus a private access code. Codes are
issued or rotated from `/drivers-admin.html` (or automatically generated when a
chauffeur self-registers), stored only as salted scrypt hashes, and delivered as
an HTTP-only `velofox_driver` cookie backed by the `driver_sessions` table. A
chauffeur session can only read that chauffeur's own manifest and advance that
chauffeur's own rides; dispatcher accounts keep access to the dispatch desk.

- `POST /api/driver/login`, `GET /api/driver/session`, `POST /api/driver/logout`
- `POST /api/admin/drivers/:id/access-code`,
  `POST /api/admin/drivers/:id/revoke-access`

Assigning a chauffeur or vehicle that overlaps another open ride's service
window returns `409` with the conflicting rides. The dispatch board asks for
confirmation and retries with `force: true`; direct API clients can do the same.
The scheduling rules live in `lib/dispatch.js` and are covered by tests.

Booking search and CSV export are available above the bookings table. Ride
lifecycle emails (request received, chauffeur assigned, en route, completed,
cancelled) use the same Resend configuration as sign-in codes.
