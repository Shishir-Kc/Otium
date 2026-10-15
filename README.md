# Otium API

Hono API running on Cloudflare Workers, with playlist and song metadata in D1 and song media in Backblaze B2 through its S3-compatible API. The local Bun download server uploads downloaded media directly to B2; the Worker then records the object keys in D1 and links the song to the selected playlist.

## Configure

For local development, put `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_ENDPOINT`, `B2_REGION`, and `B2_BUCKET` in the Otium root `.env`. Wrangler reads this file, and the download server loads it explicitly. Use a bucket-scoped B2 application key with read and write access to the bucket.

For deployment, configure `B2_KEY_ID` and `B2_APPLICATION_KEY` as Wrangler secrets and the endpoint, region, and bucket as Worker variables. The download server must also run somewhere the Worker can reach and have access to B2; a server bound to localhost is for local development only.

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
| `GET` | `/playlists` | List playlists with song counts |
| `POST` | `/playlists` | Create a playlist with `{ "name": "..." }` |
| `GET` | `/playlists/:playlistId` | Get a playlist and its songs |
| `DELETE` | `/playlists/:playlistId` | Delete a playlist |
| `POST` | `/playlists/:playlistId/songs` | Add an existing song using `{ "songId": "uuid" }` |
| `DELETE` | `/playlists/:playlistId/songs/:songId` | Remove a song from a playlist |
| `POST` | `/songs/download` | Download a video URL, upload its media to B2, and register/link the song |
| `POST` | `/songs/upload` | Upload a song and optional thumbnail as multipart form data |

`POST /songs/download` accepts `{ "url": "https://...", "playlistId": "uuid" }` (the playlist ID is optional). The Worker asks the local download server to download and upload the audio and thumbnail to B2. The Worker then stores the returned object keys in D1 and links the song to `playlistId` when provided. Audio is limited to 100 MB and thumbnails to 10 MB.

`POST /songs/upload` accepts `title`, `sourceUrl`, `audio`, and optional `thumbnail` as multipart form data. Songs can belong to more than one playlist; removing a song from a playlist does not delete its media.

The music routes allow browser CORS requests. A deployed Worker cannot reach a downloader running only on `localhost`; configure `DOWNLOAD_SERVER_URL` to a downloader URL the Worker can reach.
