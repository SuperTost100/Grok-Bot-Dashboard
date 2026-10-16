// The few GitHub calls a store needs. Public repos only, no token: GitHub allows 60 calls an hour,
// and the dashboard makes a handful a day.

type Fetch = typeof fetch;

export interface RepoRef {
  repo: string; // owner/name
  branch: string;
  path: string; // folder inside the repo, "" for the root
}

/** "owner/repo[/folder]", a github.com repo link, or a link to a folder in one (…/tree/<branch>/<path>). */
export function parseRepoRef(input: string): RepoRef {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  // owner/repo, or owner/repo/folder as the store page names its entries.
  const short = /^([\w.-]+)\/([\w.-]+)((?:\/[\w.-]+)*)$/.exec(s);
  if (short) return { repo: `${short[1]}/${short[2]}`, branch: "", path: short[3].replace(/^\//, "") };
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+?))?$/.exec(s);
  if (!m) throw new Error(`Not a GitHub repo or folder link: ${input}`);
  const rest = m[3] ?? "";
  const [branch, ...folder] = rest.split("/");
  return { repo: `${m[1]}/${m[2]}`, branch: branch ?? "", path: folder.join("/") };
}

export class GitHub {
  fetch: Fetch;
  constructor(fetchImpl: Fetch = fetch) {
    this.fetch = fetchImpl;
  }

  async json(url: string): Promise<unknown> {
    const res = await this.fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "grok-bot-dashboard" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url.replace(/^https:\/\/[^/]+/, "")}`);
    return res.json();
  }

  async defaultBranch(repo: string): Promise<string> {
    return ((await this.json(`https://api.github.com/repos/${repo}`)) as { default_branch: string }).default_branch;
  }

  /** The newest commit on a branch, or the newest one that touched a folder. */
  async latest(repo: string, branch: string, folder = ""): Promise<{ sha: string; message: string; date: string }> {
    const list = (await this.commits(repo, branch, folder, 1));
    if (!list.length) throw new Error(`No commits in ${repo}${folder ? `/${folder}` : ""}`);
    return list[0];
  }

  async commits(repo: string, branch: string, folder: string, n: number) {
    const q = new URLSearchParams({ sha: branch, per_page: String(n) });
    if (folder) q.set("path", folder);
    const list = (await this.json(`https://api.github.com/repos/${repo}/commits?${q}`)) as { sha: string; commit: { message: string; committer: { date: string } } }[];
    return list.map((c) => ({ sha: c.sha, message: c.commit.message.split("\n")[0], date: c.commit.committer.date }));
  }

  async file(repo: string, sha: string, file: string): Promise<string> {
    const res = await this.fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${file}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${file}`);
    return res.text();
  }

  async tarball(repo: string, sha: string): Promise<Buffer> {
    const res = await this.fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the ${repo} archive`);
    return Buffer.from(await res.arrayBuffer());
  }
}
