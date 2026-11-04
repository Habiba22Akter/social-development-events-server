# Utsho API server

Express + BetterAuth + MongoDB. This server owns authentication and the events
API for the Utsho Next.js app. The Next app proxies `/api/auth/*` and
`/api/events/*` here, so the browser keeps its session cookie on the Next.js
domain.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
npm start              # http://localhost:8000
```

`npm run dev` starts it with `node --watch`.

### Environment

| Variable              | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `MONGODB_URL`         | MongoDB / Atlas connection string                                |
| `MONGODB_DB`          | Database name (default `utsho`)                                  |
| `PORT`                | Port to listen on (default `8000`)                               |
| `BETTER_AUTH_URL`     | Public URL of the **Next.js app**, e.g. `http://localhost:3000`  |
| `BETTER_AUTH_SECRET`  | Long random string used to sign sessions                         |
| `GOOGLE_CLIENT_ID`    | Optional — Google login                                          |
| `GOOGLE_CLIENT_SECRET`| Optional — Google login                                          |
| `GITHUB_CLIENT_ID`    | Optional — GitHub login                                          |
| `GITHUB_CLIENT_SECRET`| Optional — GitHub login                                          |
| `CORS_ORIGINS`        | Extra origins allowed to call this API directly (comma separated)|

### Google login

1. Create an OAuth client at
   <https://console.cloud.google.com/apis/credentials>.
2. Add the authorised redirect URI:
   - `http://localhost:3000/api/auth/callback/google`
   - your deployed equivalent, e.g. `https://your-app.vercel.app/api/auth/callback/google`
3. Put the client id and secret in `.env` and restart the server.
4. Keep `NEXT_PUBLIC_AUTH_PROVIDERS=google` in the Next app.

GitHub works the same way with `/api/auth/callback/github`; add `github` to
`NEXT_PUBLIC_AUTH_PROVIDERS` once the credentials are set.

## Routes

- `GET /` — server status
- `GET /health` — database ping
- `ALL /api/auth/*` — BetterAuth handler (sign up, sign in, session, OAuth…)
- `GET /api/events?limit=6` — upcoming events (public, sorted by date)
- `GET /api/events/joined` — events the signed-in user joined (session required, sorted by date)
- `GET /api/events/mine` — events the signed-in user created (session required, sorted by date)
- `GET /api/events/:id` — one upcoming event (public, includes `joinedByViewer`)
- `POST /api/events` — create an event (session required)
- `PATCH /api/events/:id` — update an event (session required, organiser only)
- `DELETE /api/events/:id` — delete an event (session required, organiser only)
- `POST /api/events/:id/join` — join an event (session required, idempotent)

## Thumbnails

`image` accepts a direct image URL, a Google Drive share link, or a normal web
page URL. For a page, the server reads its `og:image` / `twitter:image` preview
and stores that as the thumbnail. If a page has no usable preview image (some
sites serve a bot-protection shell), the event is still saved with the default
community photo and the response includes a `notice` explaining that.

## Password rule

At least 6 characters with one uppercase and one lowercase letter. It is
enforced in the Next.js form and again in `src/auth.js` for direct API calls.

Email verification and password reset are intentionally not enabled.
