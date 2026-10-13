import path from "node:path";

export type AuthMode = "tailscale" | "none";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  authMode: AuthMode;
  ownerLogin: string;
  botToken: string;
  todoistToken: string;
  todoistFilter: string;
  /** areadidattica, the local PoliTO service. Empty turns PoliTO off. */
  areadidatticaUrl: string;
  areadidatticaToken: string;
  undoSeconds: number;
  archiveDays: number;
  tz: string;
  /** Allow webhooks to private or tailnet addresses. Off by default so a bot can't make the server call itself. */
  webhookAllowPrivate: boolean;
  backupDays: number;
  publicDir: string;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE ?? "tailscale") as AuthMode;
  if (authMode !== "tailscale" && authMode !== "none") {
    throw new Error(`AUTH_MODE must be "tailscale" or "none", got "${authMode}"`);
  }
  const ownerLogin = (env.OWNER_LOGIN ?? "").trim().toLowerCase();
  if (authMode === "tailscale" && !ownerLogin) {
    throw new Error("OWNER_LOGIN is required when AUTH_MODE=tailscale. Set it to your Tailscale login, like you@gmail.com.");
  }
  const botToken = (env.BOT_TOKEN ?? "").trim();
  if (botToken.length < 8) {
    throw new Error("BOT_TOKEN is required (at least 8 characters). Generate one with: openssl rand -hex 24");
  }
  const areadidatticaUrl = (env.AREADIDATTICA_URL ?? "").trim();
  const areadidatticaToken = (env.AREADIDATTICA_TOKEN ?? "").trim();
  if (areadidatticaUrl && !/^https?:\/\/[^\s]+$/i.test(areadidatticaUrl)) {
    throw new Error(`AREADIDATTICA_URL must be an http:// or https:// address, got "${areadidatticaUrl}"`);
  }
  if (areadidatticaUrl && !areadidatticaToken) {
    throw new Error("AREADIDATTICA_TOKEN is required with AREADIDATTICA_URL. Use the API_TOKEN from areadidattica's .env.");
  }
  const tz = (env.TZ ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error(`TZ must be a time zone like Europe/Rome, got "${tz}"`);
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port: int(env, "PORT", 8787, 1, 65535),
    dataDir: path.resolve(env.DATA_DIR ?? "data"),
    authMode,
    ownerLogin,
    botToken,
    todoistToken: (env.TODOIST_TOKEN ?? "").trim(),
    todoistFilter: (env.TODOIST_FILTER ?? "").trim(),
    areadidatticaUrl,
    areadidatticaToken,
    undoSeconds: int(env, "UNDO_SECONDS", 5, 0, 60),
    archiveDays: int(env, "ARCHIVE_DAYS", 30, 1, 365),
    tz,
    webhookAllowPrivate: env.WEBHOOK_ALLOW_PRIVATE === "1",
    backupDays: int(env, "BACKUP_DAYS", 7, 0, 90),
    publicDir: path.resolve(import.meta.dirname, "../public"),
  };
}
