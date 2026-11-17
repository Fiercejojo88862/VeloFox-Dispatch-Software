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

The current Express prototype keeps accounts, sessions, bookings, reviews, and
feedback in memory until PostgreSQL is wired into `server.js`; restarting the
server clears those runtime records. `schema.sql` contains the matching durable
database structures.
