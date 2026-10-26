import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export type TwitchRole = "bot" | "broadcaster";

const TokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
  userId: z.string(),
  login: z.string(),
});
const TokenFileSchema = z.object({ bot: TokenSchema.optional(), broadcaster: TokenSchema.optional() });
type Token = z.infer<typeof TokenSchema>;
type TokenFile = z.infer<typeof TokenFileSchema>;

const tokenPath = path.resolve("data/tokens.json");
const states = new Map<string, { role: TwitchRole; expiresAt: number }>();
const refreshes = new Map<TwitchRole, Promise<Token>>();
const scopes: Record<TwitchRole, string[]> = {
  bot: ["user:read:chat", "user:write:chat", "user:bot"],
  broadcaster: ["channel:bot", "clips:edit"],
};

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function readTokens(): Promise<TokenFile> {
  try {
    return TokenFileSchema.parse(JSON.parse(await readFile(tokenPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Token file is invalid. Remove data/tokens.json and authorize again.");
  }
}

async function writeToken(role: TwitchRole, token: Token): Promise<void> {
  const tokens = await readTokens();
  tokens[role] = token;
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function expectedLogin(role: TwitchRole): string {
  return setting(role === "bot" ? "BOT_LOGIN" : "BROADCASTER_LOGIN").toLowerCase();
}

async function validate(accessToken: string): Promise<{ userId: string; login: string; scopes: string[] }> {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Twitch token validation failed (${response.status}).`);
  const data = z.object({ user_id: z.string(), login: z.string(), scopes: z.array(z.string()) }).parse(await response.json());
  return { userId: data.user_id, login: data.login.toLowerCase(), scopes: data.scopes };
}

export function createAuthorizationUrl(role: TwitchRole): string {
  const state = randomBytes(24).toString("hex");
  states.set(state, { role, expiresAt: Date.now() + 10 * 60_000 });
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: setting("TWITCH_CLIENT_ID"),
    redirect_uri: process.env.TWITCH_REDIRECT_URI ?? "http://localhost:3000/auth/callback",
    response_type: "code",
    scope: scopes[role].join(" "),
    state,
    force_verify: "true",
  }).toString();
  return url.toString();
}

export async function completeAuthorization(state: string, code: string): Promise<TwitchRole> {
  const pending = states.get(state);
  states.delete(state);
  if (!pending || pending.expiresAt < Date.now()) throw new Error("Login expired or state was invalid. Start login again.");

  const body = new URLSearchParams({
    client_id: setting("TWITCH_CLIENT_ID"),
    client_secret: setting("TWITCH_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: process.env.TWITCH_REDIRECT_URI ?? "http://localhost:3000/auth/callback",
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Twitch token exchange failed (${response.status}).`);
  const token = z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() }).parse(await response.json());
  const identity = await validate(token.access_token);
  if (identity.login !== expectedLogin(pending.role)) {
    throw new Error(`Signed in as ${identity.login}; expected the ${pending.role} account ${expectedLogin(pending.role)}. Start login again and switch Twitch accounts.`);
  }
  const missing = scopes[pending.role].filter((scope) => !identity.scopes.includes(scope));
  if (missing.length) throw new Error(`Twitch did not grant required ${pending.role} permissions: ${missing.join(", ")}. Reauthorize and approve them.`);
  await writeToken(pending.role, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: identity.scopes,
    userId: identity.userId,
    login: identity.login,
  });
  return pending.role;
}

async function refreshToken(role: TwitchRole): Promise<Token> {
  const existing = (await readTokens())[role];
  if (!existing) throw new Error(`Authorize the ${role} account at /auth/${role} first.`);
  if (existing.expiresAt > Date.now() + 60_000) return existing;

  const active = refreshes.get(role);
  if (active) return active;
  const refreshing = (async () => {
    const body = new URLSearchParams({
      client_id: setting("TWITCH_CLIENT_ID"),
      client_secret: setting("TWITCH_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: existing.refreshToken,
    });
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`Twitch ${role} token refresh failed (${response.status}); authorize again.`);
    const result = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number() }).parse(await response.json());
    const identity = await validate(result.access_token);
    if (identity.login !== existing.login) throw new Error(`Twitch ${role} token identity changed; authorize again.`);
    const next: Token = {
      ...existing,
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? existing.refreshToken,
      expiresAt: Date.now() + result.expires_in * 1000,
      scopes: identity.scopes,
    };
    await writeToken(role, next);
    return next;
  })();
  refreshes.set(role, refreshing);
  try {
    return await refreshing;
  } finally {
    refreshes.delete(role);
  }
}

export async function getAccessToken(role: TwitchRole): Promise<string> {
  return (await refreshToken(role)).accessToken;
}

export async function getAccount(role: TwitchRole): Promise<Pick<Token, "userId" | "login" | "scopes"> | null> {
  const token = (await readTokens())[role];
  return token ? { userId: token.userId, login: token.login, scopes: token.scopes } : null;
}

export async function clearTokens(): Promise<void> {
  await writeFile(tokenPath, JSON.stringify({}), { mode: 0o600 });
}
