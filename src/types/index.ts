import { z } from "zod";

export const CreatePlaylistSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const AddSongSchema = z.object({
  songId: z.string().uuid(),
});

export const SongSchema = z.object({
  title: z.string().trim().min(1).max(300),
  sourceUrl: z.string().url(),
});

export const MusicDownloadSchema = z.object({
  url: z.string().url(),
  downloadId: z.string().uuid().optional(),
  playlistId: z.string().uuid().optional(),
});
