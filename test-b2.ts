import { S3Client } from "bun";

const client = new S3Client({
  accessKeyId: process.env.B2_KEY_ID!,
  secretAccessKey: process.env.B2_APPLICATION_KEY!,
  bucket: process.env.B2_BUCKET!,
  endpoint: process.env.B2_ENDPOINT!,
  region: process.env.B2_REGION!,
});

const key = "test/hello.txt";

await client.write(key, "hello from otium", { type: "text/plain" });
console.log("uploaded");

console.log("exists:", await client.exists(key));
console.log("content:", await client.file(key).text());

await client.delete(key);
console.log("deleted");
