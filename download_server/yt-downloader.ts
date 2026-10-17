import { join } from "path";

const DOWNLOAD_DIR = "./downloads";

export async function downloadSong(url: string, onProgress?: (percentage: number) => void) {
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
      "--newline",
      "--print", "after_move:filepath",
      "-o", output,
      url,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  let stderr = "";
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    (async () => {
      const chunks: string[] = [];
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let latestPercentage = 0;
      while (true) {
        const { value, done } = await reader.read();
        const chunk = decoder.decode(value, { stream: !done });
        chunks.push(chunk);
        pending += chunk;
        const lines = pending.split(/[\r\n]+/);
        pending = done ? "" : lines.pop() ?? "";
        for (const line of lines) {
          const match = /\[download\]\s+([\d.]+)%/.exec(line);
          const percentage = match ? Number(match[1]) : NaN;
          if (Number.isFinite(percentage) && percentage > latestPercentage) {
            latestPercentage = percentage;
            onProgress?.(percentage);
          }
        }
        if (done) break;
      }
      stderr = chunks.join("");
    })(),
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
