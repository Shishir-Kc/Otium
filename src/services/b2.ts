export type B2Config = {
  endpoint: string;
  bucket: string;
  keyId: string;
  applicationKey: string;
  region: string;
};

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

function dateParts(date: Date) {
  const value = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: value, shortDate: value.slice(0, 8) };
}

function encodeKey(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function canonicalQuery(params: URLSearchParams) {
  return [...params.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => {
      const left = `${aKey}=${aValue}`;
      const right = `${bKey}=${bValue}`;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export async function signedObjectUrl(
  config: B2Config,
  key: string,
  method: "GET" | "PUT" | "DELETE",
  expiresIn = 3600,
) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("B2 endpoint must use HTTPS");
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) {
    throw new Error("B2 signed URL expiry must be between 1 and 604800 seconds");
  }
  const canonicalUri = `/${encodeURIComponent(config.bucket)}/${encodeKey(key)}`;
  const { amzDate, shortDate } = dateParts(new Date());
  const scope = `${shortDate}/${config.region}/s3/aws4_request`;
  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.keyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  const query = canonicalQuery(params);
  const canonicalRequest = [
    method,
    canonicalUri,
    query,
    `host:${endpoint.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256(canonicalRequest),
  ].join("\n");

  const dateKey = await hmac(encoder.encode(`AWS4${config.applicationKey}`), shortDate);
  const regionKey = await hmac(dateKey, config.region);
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  const url = new URL(`${canonicalUri}?${query}&X-Amz-Signature=${signature}`, endpoint);
  return url.toString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error ? error.cause : undefined;
    return `${error.message} ${cause === undefined ? "" : String(cause)}`;
  }
  return String(error);
}

function isTransientConnectionError(error: unknown) {
  return /network connection lost|connection reset|fetch failed/i.test(errorMessage(error));
}

export async function uploadObject(config: B2Config, key: string, file: File, contentType: string) {
  const url = await signedObjectUrl(config, key, "PUT");
  const maxAttempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const fixedLength = new FixedLengthStream(file.size);
      const [responseResult, streamResult] = await Promise.allSettled([
        fetch(url, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: fixedLength.readable,
        }),
        file.stream().pipeTo(fixedLength.writable),
      ]);
      if (responseResult.status === "rejected") throw responseResult.reason;
      const response = responseResult.value;
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`B2 upload failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      if (streamResult.status === "rejected") throw streamResult.reason;
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientConnectionError(error)) throw error;
      console.error(JSON.stringify({
        message: "B2 upload connection lost; retrying",
        key,
        attempt,
        error: errorMessage(error),
      }));
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  throw lastError;
}

export async function deleteObject(config: B2Config, key: string) {
  const url = await signedObjectUrl(config, key, "DELETE");
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`B2 delete failed with status ${response.status}`);
  }
}

export function b2ConfigFromEnv(env: {
  B2_ENDPOINT?: string;
  B2_BUCKET?: string;
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_REGION?: string;
}): B2Config {
  const required = <Key extends keyof typeof env>(name: Key) => {
    const value = env[name];
    if (!value) throw new Error(`Missing configuration: ${name}`);
    return value;
  };
  return {
    endpoint: required("B2_ENDPOINT"),
    bucket: required("B2_BUCKET"),
    keyId: required("B2_KEY_ID"),
    applicationKey: required("B2_APPLICATION_KEY"),
    region: required("B2_REGION"),
  };
}
