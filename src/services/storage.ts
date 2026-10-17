import { S3Client } from "bun";
import { unlink } from "node:fs/promises";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

const client = new S3Client({
  accessKeyId: env("B2_KEY_ID"),
  secretAccessKey: env("B2_APPLICATION_KEY"),
  bucket: env("B2_BUCKET"),
  endpoint: env("B2_ENDPOINT"),
  region: env("B2_REGION"),
});

export const audioKey = (id: string) => `songs/${id}.mp3`;
export const coverKey = (id: string) => `covers/${id}.jpg`;

async function uploadFile(key: string, path: string, type: string) {
  await client.write(key, Bun.file(path), { type });
}

export async function uploadSong(
  id: string,
  audioPath: string,
  thumbnailPath: string | null,
) {
  const audio = audioKey(id);
  const cover = thumbnailPath ? coverKey(id) : null;
  const audioFile = Bun.file(audioPath);
  if (audioFile.size > 100 * 1024 * 1024) throw new Error("Audio file exceeds the 100 MB limit");
  if (thumbnailPath && Bun.file(thumbnailPath).size > 10 * 1024 * 1024) {
    throw new Error("Thumbnail exceeds the 10 MB limit");
  }

  let audioUploaded = false;
  let coverUploaded = false;
  try {
    await uploadFile(audio, audioPath, "audio/mpeg");
    audioUploaded = true;
    if (thumbnailPath && cover) {
      await uploadFile(cover, thumbnailPath, "image/jpeg");
      coverUploaded = true;
    }
  } catch (error) {
    if (coverUploaded && cover) await client.delete(cover).catch(() => {});
    if (audioUploaded) await client.delete(audio).catch(() => {});
    throw error;
  }

  await Promise.all([
    unlink(audioPath).catch(() => {}),
    ...(thumbnailPath ? [unlink(thumbnailPath).catch(() => {})] : []),
  ]);
  return { audio, cover };
}

export async function deleteObject(key: string) {
  await client.delete(key);
}

export function signedUrl(key: string, expiresIn = 3600) {
  return client.presign(key, { expiresIn });
}
