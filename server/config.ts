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
  undoSeconds: number;
  archiveDays: number;
  publicDir: string;
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
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8787),
    dataDir: path.resolve(env.DATA_DIR ?? "data"),
    authMode,
    ownerLogin,
    botToken,
    todoistToken: (env.TODOIST_TOKEN ?? "").trim(),
    todoistFilter: (env.TODOIST_FILTER ?? "").trim(),
    undoSeconds: Number(env.UNDO_SECONDS ?? 5),
    archiveDays: Number(env.ARCHIVE_DAYS ?? 30),
    publicDir: path.resolve(import.meta.dirname, "../public"),
  };
}
