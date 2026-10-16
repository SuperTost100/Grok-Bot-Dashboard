// The dashboard's side of the runner (runner/server.mjs), which starts apps' containers.

import type { Runner } from "./manager.ts";
import { runnerToken } from "../../runner/validate.mjs";

export async function createRunnerClient(base: string, botToken: string, fetchImpl: typeof fetch = fetch): Promise<Runner> {
  const auth = `Bearer ${await runnerToken(botToken)}`;
  async function call(method: string, path: string, body?: unknown, timeoutMs = 20 * 60_000): Promise<string> {
    const res = await fetchImpl(base.replace(/\/+$/, "") + path, {
      method,
      headers: { Authorization: auth, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as { output?: string; error?: string };
    if (!res.ok) throw new Error(data.error ?? `the runner answered ${res.status}`);
    return data.output ?? "";
  }
  return {
    deploy: (id, compose, files, env) => call("PUT", `/apps/${id}`, { compose, files, env }),
    down: (id, purge) => call("DELETE", `/apps/${id}${purge ? "?purge=1" : ""}`),
    status: (id) => call("GET", `/apps/${id}`, undefined, 30_000),
    logs: (id) => call("GET", `/apps/${id}/logs`, undefined, 30_000),
  };
}
