import { Hono, type Context, type MiddlewareHandler } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { OtiumBindings } from "../types/bindings.ts";

export interface Account {
  id: string;
  username: string;
  role: "admin" | "member";
}

type AuthEnv = {
  Bindings: OtiumBindings;
  Variables: { account: Account };
};

const SESSION_COOKIE = "otium_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
// Cloudflare Workers Web Crypto limits PBKDF2 to 100,000 iterations per derivation.
const PASSWORD_ITERATIONS = 100_000;
const INVITE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CredentialsSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, "Use 3–32 letters, numbers, periods, underscores, or hyphens"),
  password: z.string().min(12).max(128),
  confirmPassword: z.string().min(12).max(128),
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});
const RedeemSchema = CredentialsSchema.extend({
  code: z.string().trim().min(8).max(80),
});
const BootstrapSchema = RedeemSchema;
const LoginSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(1).max(128),
});
const CreateInviteSchema = z.object({
  expiresInHours: z.number().int().min(1).max(8760).nullable(),
  role: z.enum(["admin", "member"]).default("member"),
});

const auth = new Hono<AuthEnv>();

function jsonError(message: string, status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503) {
  return Response.json({ error: message }, { status });
}

function normalizeCode(value: string) {
  return value.toUpperCase().replace(/[\s-]/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteCount: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string, saltHex: string) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

async function usernameExists(db: D1Database, username: string) {
  return Boolean(await db.prepare("SELECT 1 AS found FROM account WHERE username = ? COLLATE NOCASE")
    .bind(username).first());
}

function isUsernameConflict(error: unknown) {
  return error instanceof Error && /unique constraint failed: account\.username/i.test(error.message);
}

function makeSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function makeInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const characters = Array.from(bytes, (byte) => INVITE_ALPHABET[byte & 31]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4, 8).join("")}-${characters.slice(8).join("")}`;
}

function cookieValue(cookieHeader: string | undefined, name: string) {
  for (const part of cookieHeader?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function setSessionCookie(c: Context<AuthEnv>, token: string) {
  c.header("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${SESSION_TTL_SECONDS}`);
}

function clearSessionCookie(c: Context<AuthEnv>) {
  c.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
}

async function currentAccount(c: Context<AuthEnv>) {
  const token = cookieValue(c.req.header("cookie"), SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await c.env.otium_db.prepare(`
    SELECT a.id, a.username, a.role
    FROM auth_session s
    INNER JOIN account a ON a.id = s.account_id
    WHERE s.token_hash = ? AND datetime(s.expires_at) > CURRENT_TIMESTAMP
  `).bind(tokenHash).first<Account>();
  return row ?? null;
}

function publicAuthRequest(method: string, path: string) {
  const endpoint = path.replace(/^.*\/auth(?=\/|$)/, "/auth");
  return (method === "POST" && ["/auth/redeem", "/auth/bootstrap", "/auth/login", "/auth/logout"].includes(endpoint))
    || (method === "GET" && endpoint === "/auth/session");
}

function publicLibraryRequest(method: string, path: string) {
  return (method === "GET" && path === "/music/library/metadata")
    || (method === "GET" && /^\/music\/songs\/[^/]+\/media\/cover$/.test(path));
}

export const requireLogin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (publicAuthRequest(c.req.method, c.req.path)) {
    c.header("Cache-Control", "private, no-store, max-age=0");
    return next();
  }
  if (publicLibraryRequest(c.req.method, c.req.path)) return next();
  c.header("Cache-Control", "private, no-store, max-age=0");
  const account = await currentAccount(c);
  if (!account) return jsonError("Sign in with a valid invitation code to continue", 401);
  c.set("account", account);
  return next();
};

export const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const account = c.get("account");
  if (account.role !== "admin") return jsonError("Administrator access is required", 403);
  return next();
};

auth.get("/session", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.json({ user: null });
  return c.json({ user: { id: account.id, username: account.username, role: account.role } });
});

auth.post("/redeem", zValidator("json", RedeemSchema), async (c) => {
  const { code, username: rawUsername, password } = c.req.valid("json");
  const codeHash = await sha256(normalizeCode(code));
  const invite = await c.env.otium_db.prepare(`
    SELECT id, account_role FROM account_invite
    WHERE code_hash = ? AND redeemed_by IS NULL
      AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
  `).bind(codeHash).first<{ id: string; account_role: Account["role"] }>();
  if (!invite) return jsonError("That invitation code is invalid, expired, or already used", 401);

  const accountId = crypto.randomUUID();
  const username = normalizeUsername(rawUsername);
  if (await usernameExists(c.env.otium_db, username)) return jsonError("That username is already taken", 409);
  const passwordSalt = randomHex(16);
  const passwordHash = await hashPassword(password, passwordSalt);
  const token = makeSessionToken();
  const tokenHash = await sha256(token);
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  let results: Awaited<ReturnType<OtiumBindings["otium_db"]["batch"]>>;
  try {
    results = await c.env.otium_db.batch([
    c.env.otium_db.prepare(`
      INSERT INTO account (id, username, password_salt, password_hash, role)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM account_invite
        WHERE code_hash = ? AND redeemed_by IS NULL
          AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
      )
    `).bind(accountId, username, passwordSalt, passwordHash, invite.account_role, codeHash),
    c.env.otium_db.prepare(`
      UPDATE account_invite
      SET redeemed_by = ?, redeemed_at = CURRENT_TIMESTAMP
      WHERE code_hash = ? AND redeemed_by IS NULL
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
        AND EXISTS (SELECT 1 FROM account WHERE id = ?)
      RETURNING id
    `).bind(accountId, codeHash, accountId),
    c.env.otium_db.prepare(`
      INSERT INTO auth_session (token_hash, account_id, expires_at)
      SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM account WHERE id = ?)
        AND EXISTS (SELECT 1 FROM account_invite WHERE code_hash = ? AND redeemed_by = ?)
    `).bind(tokenHash, accountId, sessionExpiresAt, accountId, codeHash, accountId),
    ]);
  } catch (error) {
    if (isUsernameConflict(error)) return jsonError("That username is already taken", 409);
    throw error;
  }

  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) {
    return jsonError("That invitation code is invalid, expired, or already used", 401);
  }

  setSessionCookie(c, token);
  return c.json({ user: { id: accountId, username, role: invite.account_role }, expiresAt: sessionExpiresAt }, 201);
});

auth.post("/bootstrap", zValidator("json", BootstrapSchema), async (c) => {
  const configuredCode = c.env.BOOTSTRAP_ADMIN_CODE;
  if (!configuredCode) return jsonError("First-admin setup is not configured on this server", 503);

  const { code, username: rawUsername, password } = c.req.valid("json");
  const suppliedHash = await sha256(normalizeCode(code));
  const configuredHash = await sha256(normalizeCode(configuredCode));
  if (!constantTimeEqual(suppliedHash, configuredHash)) return jsonError("The first-admin setup code is invalid", 401);

  const accountId = crypto.randomUUID();
  const username = normalizeUsername(rawUsername);
  if (await usernameExists(c.env.otium_db, username)) return jsonError("That username is already taken", 409);
  const passwordSalt = randomHex(16);
  const passwordHash = await hashPassword(password, passwordSalt);
  const token = makeSessionToken();
  const tokenHash = await sha256(token);
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  let results: Awaited<ReturnType<OtiumBindings["otium_db"]["batch"]>>;
  try {
    results = await c.env.otium_db.batch([
    c.env.otium_db.prepare(`
      UPDATE admin_bootstrap SET consumed_at = CURRENT_TIMESTAMP, consumed_by = ?
      WHERE id = 1 AND consumed_at IS NULL AND NOT EXISTS (SELECT 1 FROM account WHERE role = 'admin')
      RETURNING id
    `).bind(accountId),
    c.env.otium_db.prepare(`
      INSERT INTO account (id, username, password_salt, password_hash, role)
      SELECT ?, ?, ?, ?, 'admin' WHERE EXISTS (SELECT 1 FROM admin_bootstrap WHERE id = 1 AND consumed_by = ?)
    `).bind(accountId, username, passwordSalt, passwordHash, accountId),
    c.env.otium_db.prepare(`
      INSERT INTO auth_session (token_hash, account_id, expires_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM account WHERE id = ?)
    `).bind(tokenHash, accountId, sessionExpiresAt, accountId),
    ]);
  } catch (error) {
    if (isUsernameConflict(error)) return jsonError("That username is already taken", 409);
    throw error;
  }

  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) {
    return jsonError("First-admin setup has already been completed", 409);
  }

  setSessionCookie(c, token);
  return c.json({ user: { id: accountId, username, role: "admin" }, expiresAt: sessionExpiresAt }, 201);
});

auth.post("/login", zValidator("json", LoginSchema), async (c) => {
  const { username: rawUsername, password } = c.req.valid("json");
  const username = normalizeUsername(rawUsername);
  const clientHash = await sha256(c.req.header("CF-Connecting-IP") ?? "unknown-client");
  const rateLimit = await c.env.otium_db.prepare(`
    SELECT blocked_until FROM auth_login_attempt
    WHERE client_hash = ? AND blocked_until IS NOT NULL AND datetime(blocked_until) > CURRENT_TIMESTAMP
  `).bind(clientHash).first<{ blocked_until: string }>();
  if (rateLimit) return jsonError("Too many unsuccessful sign-in attempts. Try again in 15 minutes.", 429);

  const account = await c.env.otium_db.prepare(
    "SELECT id, username, password_salt, password_hash, role FROM account WHERE username = ? COLLATE NOCASE",
  ).bind(username).first<Account & { password_salt: string; password_hash: string }>();

  const passwordHash = await hashPassword(password, account?.password_salt ?? "00000000000000000000000000000000");
  if (!account || !constantTimeEqual(passwordHash, account.password_hash)) {
    await c.env.otium_db.prepare(`
      INSERT INTO auth_login_attempt (client_hash, failed_attempts, window_started_at, blocked_until)
      VALUES (?, 1, CURRENT_TIMESTAMP, NULL)
      ON CONFLICT(client_hash) DO UPDATE SET
        failed_attempts = CASE
          WHEN datetime(auth_login_attempt.window_started_at) <= datetime('now', '-15 minutes') THEN 1
          ELSE auth_login_attempt.failed_attempts + 1
        END,
        window_started_at = CASE
          WHEN datetime(auth_login_attempt.window_started_at) <= datetime('now', '-15 minutes') THEN CURRENT_TIMESTAMP
          ELSE auth_login_attempt.window_started_at
        END,
        blocked_until = CASE
          WHEN datetime(auth_login_attempt.window_started_at) <= datetime('now', '-15 minutes') THEN NULL
          WHEN auth_login_attempt.failed_attempts + 1 >= 8 THEN datetime('now', '+15 minutes')
          ELSE auth_login_attempt.blocked_until
        END
    `).bind(clientHash).run();
    return jsonError("Username or password is incorrect", 401);
  }

  await c.env.otium_db.prepare("DELETE FROM auth_login_attempt WHERE client_hash = ?").bind(clientHash).run();
  const token = makeSessionToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await c.env.otium_db.prepare(
    "INSERT INTO auth_session (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
  ).bind(tokenHash, account.id, expiresAt).run();
  setSessionCookie(c, token);
  return c.json({ user: { id: account.id, username: account.username, role: account.role }, expiresAt });
});

auth.post("/logout", async (c) => {
  const token = cookieValue(c.req.header("cookie"), SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256(token);
    await c.env.otium_db.prepare("DELETE FROM auth_session WHERE token_hash = ?").bind(tokenHash).run();
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

auth.post("/invites", zValidator("json", CreateInviteSchema), async (c) => {
  const account = c.get("account");
  if (account.role !== "admin") return jsonError("Administrator access is required", 403);

  const { expiresInHours, role } = c.req.valid("json");
  const code = makeInviteCode();
  const codeHash = await sha256(normalizeCode(code));
  const expiresAt = expiresInHours === null ? null : new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
  await c.env.otium_db.prepare(
    "INSERT INTO account_invite (id, code_hash, created_by, account_role, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), codeHash, account.id, role, expiresAt).run();
  return c.json({ code, expiresAt }, 201);
});

export default auth;
