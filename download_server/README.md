# Otium download server

This local Bun service downloads audio, uploads audio and an optional thumbnail directly to B2, and reports download/upload progress to Otium's Worker.

The service reads the B2 settings from the parent Otium `.env` file. Run it from this directory with:

```sh
bun install
bun run dev
```

It listens on `127.0.0.1:3000`. The Otium Worker must also be running locally. For a deployed Worker, configure a reachable downloader URL and provide B2 credentials to that downloader process.
