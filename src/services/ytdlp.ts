import { join } from "path";

const DOWNLOAD_DIR = "./downloads";

export async function downloadSong(url: string) {
  const output = join(DOWNLOAD_DIR, "%(title)s.%(ext)s");

  const proc = Bun.spawn(
    [
      "yt-dlp",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--no-playlist",
      "--write-thumbnail",
      "--convert-thumbnails", "jpg",
      "--print", "after_move:filepath",
      "-o", output,
      url,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "yt-dlp failed");
  }

  const audio = stdout.trim().split("\n").pop()!;
  const thumbnail = audio.replace(/\.mp3$/, ".jpg");

  return {
    audio,
    thumbnail: (await Bun.file(thumbnail).exists()) ? thumbnail : null,
  };
}
