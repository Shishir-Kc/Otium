import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { AddSongSchema, CreatePlaylistSchema, MusicDownloadSchema, SongSchema } from "../types/index.ts";
import { b2ConfigFromEnv, deleteObject, signedObjectUrl, uploadObject } from "../services/b2.ts";

type PlaylistRow = {
  id: string;
  name: string;
  playlist_image_url: string | null;
  created_at: string;
};

type SongRow = {
  id: string;
  title: string;
  source_url: string;
  image_url: string | null;
  audio: string | null;
  created_at: string;
};

const music = new Hono<{ Bindings: CloudflareBindings }>();

function b2Config(env: CloudflareBindings) {
  return b2ConfigFromEnv(env);
}

function jsonError(message: string, status: 400 | 404 | 409 | 413 | 415 | 502 | 500) {
  return Response.json({ error: message }, { status });
}

function playlistMediaUrl(requestUrl: string, songId: string, kind: "audio" | "cover") {
  const request = new URL(requestUrl);
  const apiPath = request.pathname.replace(/\/playlists\/[^/]+$/, "");
  return `${request.origin}${apiPath}/songs/${encodeURIComponent(songId)}/media/${kind}`;
}

async function ensurePlaylistSong(db: CloudflareBindings["otium_db"], playlistId: string, songId: string) {
  const existing = await db.prepare(
    "SELECT 1 AS found FROM playlist_song WHERE playlist_id = ? AND song_id = ?",
  ).bind(playlistId, songId).first();
  if (existing) return "existing" as const;

  const count = await db.prepare(
    "SELECT COUNT(*) AS count FROM playlist_song WHERE playlist_id = ?",
  ).bind(playlistId).first<{ count: number }>();
  if ((count?.count ?? 0) >= 49) return "full" as const;

  await db.prepare(
    "INSERT INTO playlist_song (playlist_id, song_id) VALUES (?, ?)",
  ).bind(playlistId, songId).run();
  return "added" as const;
}

music.use("*", async (c, next) => {
  const startedAt = Date.now();
  await next();
  console.log(JSON.stringify({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  }));
});

music.get("/ping", (c) => c.json({ message: "server is alive" }));

music.get("/playlists", async (c) => {
  const result = await c.env.otium_db.prepare(`
    SELECT p.id, p.name, p.playlist_image_url, p.created_at,
      COUNT(ps.song_id) AS song_count
    FROM playlist p
    LEFT JOIN playlist_song ps ON ps.playlist_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all<PlaylistRow & { song_count: number }>();
  return c.json({ playlists: result.results });
});

music.post("/playlists", zValidator("json", CreatePlaylistSchema), async (c) => {
  const { name } = c.req.valid("json");
  const id = crypto.randomUUID();
  await c.env.otium_db.prepare(
    "INSERT INTO playlist (id, name) VALUES (?, ?)",
  ).bind(id, name).run();
  return c.json({ id, name, songs: [] }, 201);
});

music.get("/playlists/:playlistId", async (c) => {
  const { playlistId } = c.req.param();
  const playlist = await c.env.otium_db.prepare(
    "SELECT id, name, playlist_image_url, created_at FROM playlist WHERE id = ?",
  ).bind(playlistId).first<PlaylistRow>();
  if (!playlist) return jsonError("Playlist not found", 404);

  const result = await c.env.otium_db.prepare(`
    SELECT s.id, s.title, s.source_url, s.image_url, s.audio, s.created_at
    FROM song s
    INNER JOIN playlist_song ps ON ps.song_id = s.id
    WHERE ps.playlist_id = ?
    ORDER BY ps.added_at ASC
  `).bind(playlistId).all<SongRow>();

  const songs = result.results.map((song) => ({
    id: song.id,
    title: song.title,
    sourceUrl: song.source_url,
    coverUrl: song.image_url ? playlistMediaUrl(c.req.url, song.id, "cover") : null,
    audioUrl: song.audio ? playlistMediaUrl(c.req.url, song.id, "audio") : null,
    createdAt: song.created_at,
  }));
  return c.json({ ...playlist, songs });
});

music.get("/songs/:songId/media/:kind", async (c) => {
  const { songId, kind } = c.req.param();
  if (kind !== "audio" && kind !== "cover") return jsonError("Unknown media type", 404);

  const song = await c.env.otium_db.prepare(
    "SELECT audio, image_url FROM song WHERE id = ?",
  ).bind(songId).first<{ audio: string | null; image_url: string | null }>();
  if (!song) return jsonError("Song not found", 404);

  const objectKey = kind === "audio" ? song.audio : song.image_url;
  if (!objectKey) return jsonError("Song media not found", 404);

  try {
    const sourceUrl = await signedObjectUrl(b2Config(c.env), objectKey, "GET");
    const requestHeaders = new Headers();
    const range = c.req.header("range");
    const ifRange = c.req.header("if-range");
    if (range) requestHeaders.set("Range", range);
    if (ifRange) requestHeaders.set("If-Range", ifRange);

    const source = await fetch(sourceUrl, { headers: requestHeaders });
    if (!source.ok && source.status !== 206) {
      console.error(JSON.stringify({ message: "B2 media request failed", songId, kind, status: source.status }));
      return jsonError("Could not load media from storage", 502);
    }

    const headers = new Headers();
    for (const name of ["content-type", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = source.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", kind === "audio" ? "audio/mpeg" : "image/jpeg");
    }
    headers.set("cache-control", "private, max-age=300");
    headers.set("access-control-expose-headers", "Accept-Ranges, Content-Range, ETag");
    return new Response(source.body, { status: source.status, headers });
  } catch (error) {
    console.error(JSON.stringify({ message: "B2 media proxy failed", songId, kind, error: error instanceof Error ? error.message : String(error) }));
    return jsonError("Could not load media from storage", 502);
  }
});

music.delete("/playlists/:playlistId", async (c) => {
  const { playlistId } = c.req.param();
  const result = await c.env.otium_db.prepare(
    "DELETE FROM playlist WHERE id = ?",
  ).bind(playlistId).run();
  if (!result.meta.changes) return jsonError("Playlist not found", 404);
  return c.body(null, 204);
});

music.post("/playlists/:playlistId/songs", zValidator("json", AddSongSchema), async (c) => {
  const { playlistId } = c.req.param();
  const { songId } = c.req.valid("json");
  const db = c.env.otium_db;
  const playlist = await db.prepare("SELECT id FROM playlist WHERE id = ?").bind(playlistId).first();
  if (!playlist) return jsonError("Playlist not found", 404);
  const song = await db.prepare("SELECT id FROM song WHERE id = ?").bind(songId).first();
  if (!song) return jsonError("Song not found", 404);

  const result = await ensurePlaylistSong(db, playlistId, songId);
  if (result === "full") return jsonError("A playlist can contain at most 49 songs", 409);
  if (result === "existing") return c.json({ playlistId, songId, added: false });
  return c.json({ playlistId, songId, added: true }, 201);
});

music.delete("/playlists/:playlistId/songs/:songId", async (c) => {
  const { playlistId, songId } = c.req.param();
  const result = await c.env.otium_db.prepare(
    "DELETE FROM playlist_song WHERE playlist_id = ? AND song_id = ?",
  ).bind(playlistId, songId).run();
  if (!result.meta.changes) return jsonError("Song is not in this playlist", 404);
  return c.body(null, 204);
});

music.get("/songs/download/:downloadId/progress", async (c) => {
  const { downloadId } = c.req.param();
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(downloadId)) {
    return jsonError("Invalid download ID", 400);
  }
  const downloadServerUrl = c.env.DOWNLOAD_SERVER_URL || "http://127.0.0.1:3000/download";
  const progressUrl = new URL(downloadServerUrl);
  const basePath = progressUrl.pathname.replace(/\/download\/?$/, "").replace(/\/$/, "");
  progressUrl.pathname = `${basePath}/progress/${downloadId}`;

  try {
    const response = await fetch(progressUrl);
    if (!response.ok) return jsonError("Download progress not found", 404);
    const payload = await response.json();
    return c.json(payload);
  } catch (error) {
    console.error(JSON.stringify({ message: "download progress request failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonError("Could not reach the local download server", 502);
  }
});

music.post("/songs/download", zValidator("json", MusicDownloadSchema), async (c) => {
  const { url: sourceUrl, downloadId: requestedDownloadId, playlistId } = c.req.valid("json");
  const downloadId = requestedDownloadId ?? crypto.randomUUID();
  if (playlistId) {
    const playlist = await c.env.otium_db.prepare(
      "SELECT id FROM playlist WHERE id = ?",
    ).bind(playlistId).first();
    if (!playlist) return jsonError("Playlist not found", 404);
  }
  const duplicate = await c.env.otium_db.prepare(
    "SELECT id, title FROM song WHERE source_url = ?",
  ).bind(sourceUrl).first<{ id: string; title: string }>();
  if (duplicate) {
    if (playlistId) {
      const link = await ensurePlaylistSong(c.env.otium_db, playlistId, duplicate.id);
      if (link === "full") return jsonError("A playlist can contain at most 49 songs", 409);
    }
    return c.json({ id: duplicate.id, title: duplicate.title, sourceUrl, reused: true });
  }
  if (playlistId) {
    const count = await c.env.otium_db.prepare(
      "SELECT COUNT(*) AS count FROM playlist_song WHERE playlist_id = ?",
    ).bind(playlistId).first<{ count: number }>();
    if ((count?.count ?? 0) >= 49) return jsonError("A playlist can contain at most 49 songs", 409);
  }

  const id = crypto.randomUUID();
  const downloadServerUrl = c.env.DOWNLOAD_SERVER_URL || "http://127.0.0.1:3000/download";
  let downloadResponse: Response;
  try {
    downloadResponse = await fetch(downloadServerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: sourceUrl, downloadId, songId: id }),
    });
  } catch (error) {
    console.error(JSON.stringify({ message: "download server request failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonError("Could not reach the local download server", 502);
  }
  if (!downloadResponse.ok) {
    let detail = `Download server returned ${downloadResponse.status}`;
    try {
      const payload = await downloadResponse.json() as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.trim()) detail = payload.error.trim().slice(0, 300);
    } catch {
      // Keep the HTTP status when the download server does not return JSON.
    }
    return jsonError(`Could not download and upload the song: ${detail}`, 502);
  }

  let savedMedia: { title: string; audio: string; cover: string | null };
  try {
    const payload = await downloadResponse.json() as {
      id?: unknown;
      title?: unknown;
      audio?: unknown;
      cover?: unknown;
    };
    const expectedAudio = `songs/${id}.mp3`;
    const expectedCover = `covers/${id}.jpg`;
    if (payload.id !== id || payload.audio !== expectedAudio || (payload.cover !== null && payload.cover !== expectedCover)) {
      throw new Error("Download server returned invalid saved media metadata");
    }
    if (typeof payload.title !== "string" || !payload.title.trim() || payload.title.length > 300) {
      throw new Error("Download server returned an invalid song title");
    }
    savedMedia = { title: payload.title.trim(), audio: expectedAudio, cover: payload.cover as string | null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "invalid saved media response", error: detail }));
    return jsonError(detail, 502);
  }

  const config = b2Config(c.env);
  let songInserted = false;
  let saveStage = "database insert";
  try {
    await c.env.otium_db.prepare(
      "INSERT INTO song (id, title, source_url, image_url, audio) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, savedMedia.title, sourceUrl, savedMedia.cover, savedMedia.audio).run();
    songInserted = true;
    if (playlistId) {
      saveStage = "playlist link";
      const link = await ensurePlaylistSong(c.env.otium_db, playlistId, id);
      if (link === "full") {
        await c.env.otium_db.prepare("DELETE FROM song WHERE id = ?").bind(id).run().catch(() => {});
        if (savedMedia.cover) await deleteObject(config, savedMedia.cover).catch(() => {});
        await deleteObject(config, savedMedia.audio).catch(() => {});
        return jsonError("A playlist can contain at most 49 songs", 409);
      }
    }
  } catch (error) {
    if (songInserted) await c.env.otium_db.prepare("DELETE FROM song WHERE id = ?").bind(id).run().catch(() => {});
    if (savedMedia.cover) await deleteObject(config, savedMedia.cover).catch(() => {});
    await deleteObject(config, savedMedia.audio).catch(() => {});
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "downloaded song save failed", stage: saveStage, error: detail }));
    return jsonError(`Could not save the downloaded song during ${saveStage}`, 502);
  }
  return c.json({ id, title: savedMedia.title, sourceUrl }, 201);
});

music.post("/songs/upload", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return jsonError("Expected multipart form data", 400);
  }
  const title = form.get("title");
  const sourceUrl = form.get("sourceUrl");
  const audio = form.get("audio");
  const thumbnail = form.get("thumbnail");
  const parsed = SongSchema.safeParse({ title, sourceUrl });
  if (!parsed.success) return jsonError("A valid title and sourceUrl are required", 400);
  if (!(audio instanceof File)) return jsonError("An audio file is required", 400);
  if (audio.size > 100 * 1024 * 1024) return jsonError("Audio file exceeds the 100 MB limit", 413);
  if (!audio.type.startsWith("audio/")) return jsonError("Audio file must have an audio MIME type", 415);
  if (thumbnail !== null && !(thumbnail instanceof File)) return jsonError("Thumbnail must be a file", 400);
  if (thumbnail instanceof File && thumbnail.size > 10 * 1024 * 1024) return jsonError("Thumbnail exceeds the 10 MB limit", 413);
  if (thumbnail instanceof File && !thumbnail.type.startsWith("image/")) return jsonError("Thumbnail must have an image MIME type", 415);

  const existing = await c.env.otium_db.prepare(
    "SELECT id FROM song WHERE source_url = ?",
  ).bind(parsed.data.sourceUrl).first<{ id: string }>();
  if (existing) return jsonError("A song with this source URL already exists", 409);

  const id = crypto.randomUUID();
  const audioKey = `songs/${id}.${audio.type === "audio/mpeg" ? "mp3" : "audio"}`;
  const coverKey = thumbnail instanceof File ? `covers/${id}` : null;
  const config = b2Config(c.env);
  let audioUploaded = false;
  let coverUploaded = false;
  try {
    await uploadObject(config, audioKey, audio, audio.type);
    audioUploaded = true;
    if (thumbnail instanceof File && coverKey) {
      await uploadObject(config, coverKey, thumbnail, thumbnail.type);
      coverUploaded = true;
    }
    await c.env.otium_db.prepare(
      "INSERT INTO song (id, title, source_url, image_url, audio) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, parsed.data.title, parsed.data.sourceUrl, coverKey, audioKey).run();
  } catch (error) {
    if (coverUploaded && coverKey) await deleteObject(config, coverKey).catch(() => {});
    if (audioUploaded) await deleteObject(config, audioKey).catch(() => {});
    console.error(JSON.stringify({ message: "song upload failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonError("Could not save the song and its media", 502);
  }

  return c.json({ id, title: parsed.data.title, sourceUrl: parsed.data.sourceUrl }, 201);
});

export default music;
