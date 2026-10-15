import { S3Client } from "bun";

const client = new S3Client({
  accessKeyId: process.env.B2_KEY_ID!,
  secretAccessKey: process.env.B2_APPLICATION_KEY!,
  bucket: process.env.B2_BUCKET!,
  endpoint: process.env.B2_ENDPOINT!,
  region: process.env.B2_REGION!,
});

// the stray otium.bucket/ folder is from the run with the wrong endpoint
const prefixes = ["songs/", "covers/", "otium.bucket/"];

async function listAll(prefix: string) {
  const keys: string[] = [];
  let startAfter: string | undefined;

  while (true) {
    const page = await client.list({ prefix, maxKeys: 1000, startAfter });
    const batch = (page.contents ?? []).map((o) => o.key);
    keys.push(...batch);
    if (!page.isTruncated || batch.length === 0) break;
    startAfter = batch[batch.length - 1];
  }
  return keys;
}

const keys = (await Promise.all(prefixes.map(listAll))).flat();
console.log(`Found ${keys.length} files in ${process.env.B2_BUCKET}`);

if (keys.length === 0) process.exit(0);

if (!process.argv.includes("--yes")) {
  console.log(keys.slice(0, 10));
  console.log("Dry run only. Re-run with --yes to delete.");
  process.exit(0);
}

let deleted = 0;
for (const key of keys) {
  await client.delete(key);
  deleted++;
}
console.log(`Deleted ${deleted} files`);
