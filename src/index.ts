import { Hono } from 'hono'
import { cors } from 'hono/cors'
import music from "./routes/music.ts"
import type { OtiumBindings } from "./types/bindings.ts"


const app = new Hono<{ Bindings: OtiumBindings }>()

function isAllowedFrontendOrigin(origin: string, bindings: OtiumBindings) {
  const configured = (bindings.FRONTEND_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

app.onError((error, c) => {
  console.error(JSON.stringify({
    message: "request failed",
    error: error instanceof Error ? error.message : String(error),
    path: c.req.path,
  }));
  return c.json({ error: "Internal server error" }, 500);
});

app.get('/', (c) => {
  return c.text('Initiating Otium')
})

app.use("/music/*", cors({
  origin: (origin, c) => isAllowedFrontendOrigin(origin, c.env) ? origin : undefined,
  credentials: true,
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Range", "If-Range"],
  exposeHeaders: ["Accept-Ranges", "Content-Range", "ETag"],
}));

app.route("/music",music);

export default app
