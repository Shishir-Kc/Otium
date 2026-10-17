# Otium API

Hono API running on Cloudflare Workers, with playlist and song metadata in D1 and song media in Backblaze B2 through its S3-compatible API. The local Bun download server uploads downloaded media directly to B2; the Worker then records the object keys in D1 and links the song to the selected playlist.

## Configure

For local development, put `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_ENDPOINT`, `B2_REGION`, and `B2_BUCKET` in the Otium root `.env`. Wrangler reads this file, and the download server loads it explicitly. Use a bucket-scoped B2 application key with read and write access to the bucket.

For deployment, configure `B2_KEY_ID` and `B2_APPLICATION_KEY` as Wrangler secrets and the endpoint, region, and bucket as Worker variables. The download server must also run somewhere the Worker can reach and have access to B2; a server bound to localhost is for local development only.

## Accounts and access

All accounts share the same playlists and music library. The API requires a valid account session for every music route other than `GET /music/ping` and the public authentication routes. The frontend checks the session before it loads playlist data. Sessions are held in secure, HTTP-only cookies; passwords are salted and derived with PBKDF2-SHA-256. Invite codes are stored as hashes and can be redeemed once.

Apply `migrations/0002_accounts.sql` to the same D1 database used by the Worker before deploying account features:

```sh
bunx wrangler d1 migrations apply otium-db --remote
```

Set the first-admin bootstrap secret before initial setup. Keep it private. The public sign-in screen no longer has a **First admin** tab; initialize the first administrator by sending one request to `POST /music/auth/bootstrap` with the code, username, password, and password confirmation. The database permits this only once.

```sh
bunx wrangler secret put BOOTSTRAP_ADMIN_CODE
```

Configure `FRONTEND_ORIGINS` as a comma-separated list of exact browser origins, including scheme and port where applicable, for example `https://music.example.com`. Localhost and loopback origins over HTTP or HTTPS are allowed automatically for development. The API uses credentialed CORS so the browser can send the session cookie; wildcard origins are not used. After initial bootstrap, remove or rotate the bootstrap secret as part of deployment operations; the database also prevents another bootstrap account from being created.

In the frontend, select **Sign up** and provide an administrator-generated invite code, a username (3–32 letters, numbers, periods, underscores, or hyphens; starting with a letter, number, or underscore), a password (12–128 characters), and its confirmation. Admins create member codes or administrator invite links from the account settings drawer and choose a finite expiry or **Permanent**. Permanent means no time expiry; every invite remains one-use. An administrator link opens the account form with its invite code filled in; redeeming it creates an administrator account. A code already redeemed, expired, or invalid is rejected. Username matching is case-insensitive. On another device, use **Log in** with the same username and password; no invite is needed to sign in. Failed sign-in attempts are rate-limited per client address.

Accounts currently share the global playlist and song tables. This provides a common library rather than per-account private playlists.

Apply the D1 migration to the intended database:

```sh
bunx wrangler d1 migrations apply otium-db --remote
```

Start the API with `bun run dev`. It listens on Wrangler's default local port `8787`. Start the downloader in another terminal with `cd download_server && bun run dev`; it listens on `127.0.0.1:3000`.

## API routes

All routes below are under `/music`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/ping` | Health check |
| `GET` | `/auth/session` | Return the current account or `{ "user": null }` |
| `POST` | `/auth/bootstrap` | Create the one-time first administrator using the configured bootstrap code, username, password, and confirmation |
| `POST` | `/auth/redeem` | Redeem an unused invite and create a member account |
| `POST` | `/auth/login` | Start a session using username and password |
| `POST` | `/auth/logout` | Revoke the current session |
| `POST` | `/auth/invites` | Admin-only; create an invite with `{ "expiresInHours": 24, "role": "member" }` or `{ "expiresInHours": null, "role": "admin" }` for a permanent admin invite |
| `GET` | `/library/metadata` | Public playlist and song titles, cover URLs, and audio availability for sign-in prefetch |
| `GET` | `/playlists` | List playlists with song counts |
| `POST` | `/playlists` | Create a playlist with `{ "name": "..." }` |
| `GET` | `/playlists/:playlistId` | Get a playlist and its songs |
| `DELETE` | `/playlists/:playlistId` | Admin-only; delete a playlist |
| `POST` | `/playlists/:playlistId/songs` | Add an existing song using `{ "songId": "uuid" }` |
| `DELETE` | `/playlists/:playlistId/songs/:songId` | Admin-only; unlink a song from a playlist |
| `DELETE` | `/songs/:songId` | Admin-only; delete a song from the shared library, its playlist links, and its B2 audio and cover objects |
| `POST` | `/songs/download` | Admin-only; download a video URL, upload its media to B2, and register/link the song |
| `POST` | `/songs/upload` | Authenticated member or admin; upload a song and optional thumbnail as multipart form data |
| `GET` | `/songs/:songId/media/cover` | Public cover image |
| `GET` | `/songs/:songId/media/audio` | Authenticated audio stream with range support |

`POST /songs/download` accepts `{ "url": "https://...", "playlistId": "uuid" }` (the playlist ID is optional). The Worker asks the local download server to download and upload the audio and thumbnail to B2. The Worker then stores the returned object keys in D1 and links the song to `playlistId` when provided. Audio is limited to 100 MB and thumbnails to 10 MB.

`POST /songs/upload` accepts `title`, `audio`, and optional `thumbnail`, `sourceUrl`, and `playlistId` as multipart form data. Any signed-in member or administrator can upload a local audio file to the shared library and optionally link it to a playlist. When `sourceUrl` is omitted, Otium creates a unique internal source identifier. Songs can belong to more than one playlist; removing a song from a playlist does not delete its media. Audio is limited to 100 MB and thumbnails to 10 MB. Playlist metadata and cover images are public for prefetching; audio streams and all write operations require a valid session. URL-based video downloads and library deletion remain administrator-only. Browser clients must enable credentials for auth and music requests.

The music routes allow browser CORS requests. A deployed Worker cannot reach a downloader running only on `localhost`; configure `DOWNLOAD_SERVER_URL` to a downloader URL the Worker can reach.
