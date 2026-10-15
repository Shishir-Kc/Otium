import { Hono } from 'hono'
import { cors } from 'hono/cors'
import music from "./routes/music.ts"


const app = new Hono<{ Bindings: CloudflareBindings }>()

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
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Range", "If-Range"],
  exposeHeaders: ["Accept-Ranges", "Content-Range", "ETag"],
}));

app.route("/music",music);

export default app
