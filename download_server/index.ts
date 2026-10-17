import express from "express";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import { downloadSong } from "./yt-downloader.ts";
import { uploadSong } from "../src/services/storage.ts";

const app = express();
app.use(express.json());
type DownloadStatus = "downloading" | "preparing" | "uploading" | "complete" | "error";
type DownloadProgress = { percentage: number; status: DownloadStatus; updatedAt: number };
const downloadProgress = new Map<string, DownloadProgress>();

function setDownloadProgress(downloadId: string, percentage: number, status: DownloadStatus) {
  const entry = { percentage: Math.max(0, Math.min(100, Math.round(percentage))), status, updatedAt: Date.now() };
  downloadProgress.set(downloadId, entry);
  if (status === "complete" || status === "error") {
    setTimeout(() => {
      if (downloadProgress.get(downloadId)?.updatedAt === entry.updatedAt) downloadProgress.delete(downloadId);
    }, 120_000).unref?.();
  }
}

app.use((req, _res, next) => {
  console.log(`${req.method}  ${req.url}`);
  next();
});
app.get("/", (_req, res) => {
  res.send("Server is running!");
});
app.get("/progress/:downloadId", (req, res) => {
  const progress = downloadProgress.get(req.params.downloadId);
  if (!progress) {
    res.status(404).json({ error: "Download progress not found" });
    return;
  }
  res.json({ percentage: progress.percentage, status: progress.status });
});

app.post("/download", async (req, res) => {
  if (typeof req.body?.url !== "string") {
    res.status(400).json({ error: "A URL is required" });
    return;
  }
  const downloadId = typeof req.body.downloadId === "string" ? req.body.downloadId : randomUUID();
  const songId = req.body.songId;
  if (typeof songId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(songId)) {
    res.status(400).json({ error: "A valid song ID is required" });
    return;
  }

  setDownloadProgress(downloadId, 0, "downloading");
  let downloaded: { audio: string; thumbnail: string | null } | null = null;
  try {
    downloaded = await downloadSong(req.body.url, (percentage) => {
      setDownloadProgress(downloadId, percentage * 0.95, "downloading");
    });
    setDownloadProgress(downloadId, 97, "preparing");
    const title = basename(downloaded.audio, extname(downloaded.audio));
    setDownloadProgress(downloadId, 98, "uploading");
    const stored = await uploadSong(songId, downloaded.audio, downloaded.thumbnail);
    setDownloadProgress(downloadId, 100, "complete");
    res.status(200).json({ id: songId, title, audio: stored.audio, cover: stored.cover });
  } catch (error) {
    setDownloadProgress(downloadId, downloadProgress.get(downloadId)?.percentage ?? 0, "error");
    if (downloaded) {
      await unlink(downloaded.audio).catch(() => {});
      if (downloaded.thumbnail) await unlink(downloaded.thumbnail).catch(() => {});
    }
    const message = error instanceof Error ? error.message : "Download failed";
    console.error(JSON.stringify({ message: "download or B2 upload failed", songId, error: message }));
    res.status(502).json({ error: message });
  }
});

app.listen(3000, "127.0.0.1", () => {
  console.log("Server is running on http://127.0.0.1:3000");
});
