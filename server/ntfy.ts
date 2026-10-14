// Phone pings through ntfy (https://ntfy.sh). The ping never carries card content: ntfy.sh is a
// public server, so it only says how many urgent cards wait, and links to the dashboard.

type Fetch = typeof fetch;

export async function pingPhone(server: string, topic: string, count: number, link: string, fetchImpl: Fetch = fetch) {
  const url = `${server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Title: "Grok Dash",
      Priority: "high",
      Tags: "rotating_light",
      ...(link ? { Click: link } : {}),
    },
    body: count === 1 ? "1 urgent card on your dashboard" : `${count} urgent cards on your dashboard`,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}
