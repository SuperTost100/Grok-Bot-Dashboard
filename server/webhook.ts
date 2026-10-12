import dns from "node:dns/promises";
import net from "node:net";

// Bots choose their webhook URL, so the server must not let one point it at itself,
// the local network or the tailnet. Only public https destinations are allowed by default.

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4ToInt(ip: string) {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") ||
    v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff") || v6.startsWith("fd7a:115c:a1e0");
}

/** Shape check when a bot registers a URL. Returns an error message, or "" when it's fine. */
export function checkWebhookUrl(raw: string, allowPrivate: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "webhookUrl is not a valid URL";
  }
  if (u.protocol !== "https:" && !allowPrivate) return "webhookUrl must use https";
  if (u.username || u.password) return "webhookUrl must not contain a user name or password";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".ts.net") || (net.isIP(host) && isPrivateAddress(host)))) {
    return "webhookUrl must be a public address, not this machine, your LAN or your tailnet";
  }
  return "";
}

/** Resolve the host right before calling it, so a DNS name can't quietly point at a private address. */
export async function assertPublicDestination(raw: string, allowPrivate: boolean) {
  const shape = checkWebhookUrl(raw, allowPrivate);
  if (shape) throw new Error(shape);
  if (allowPrivate) return;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`${host} resolves to a private address`);
}
