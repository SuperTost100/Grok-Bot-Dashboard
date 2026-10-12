// Direct link to Todoist (API v1) so ticking a to-do is instant and Todoist stays the only list.

const BASE = "https://api.todoist.com/api/v1";

export interface Todo {
  id: string;
  content: string;
  /** 1 is the most urgent, like p1 in the Todoist app. */
  priority: number;
  /** YYYY-MM-DD or a full ISO datetime. Empty when the task has no date. */
  due: string;
  dueString: string;
  recurring: boolean;
  /** YYYY-MM-DD hard deadline. */
  deadline: string;
  project: string;
  url: string;
}

interface ApiTask {
  id: string;
  content: string;
  priority: number;
  project_id: string;
  due: { date: string; datetime?: string | null; string?: string; is_recurring?: boolean } | null;
  deadline: { date: string } | null;
}

type Fetch = typeof fetch;

export class Todoist {
  token: string;
  filter: string;
  fetch: Fetch;
  cache: { at: number; todos: Todo[] } | null = null;
  projects: { at: number; names: Map<string, string> } | null = null;

  constructor(token: string, filter = "", fetchImpl: Fetch = fetch) {
    this.token = token;
    this.filter = filter;
    this.fetch = fetchImpl;
  }

  async call(method: string, path: string, query: Record<string, string> = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? " Check TODOIST_TOKEN." : "";
      throw new Error(`Todoist answered ${res.status} on ${method} ${path}.${hint}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async paged(path: string, query: Record<string, string>) {
    const out: unknown[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const data = (await this.call("GET", path, { ...query, limit: "200", ...(cursor ? { cursor } : {}) })) as {
        results: unknown[];
        next_cursor: string | null;
      };
      out.push(...data.results);
      if (!data.next_cursor) break;
      cursor = data.next_cursor;
    }
    return out;
  }

  async projectNames(): Promise<Map<string, string>> {
    if (this.projects && Date.now() - this.projects.at < 10 * 60_000) return this.projects.names;
    const rows = (await this.paged("/projects", {})) as { id: string; name: string }[];
    const names = new Map(rows.map((p) => [p.id, p.name]));
    this.projects = { at: Date.now(), names };
    return names;
  }

  /** Active tasks, cached for a minute so the dashboard's polling doesn't hammer Todoist. */
  async list(force = false): Promise<Todo[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.todos;
    const [tasks, names] = await Promise.all([
      this.filter ? this.paged("/tasks/filter", { query: this.filter }) : this.paged("/tasks", {}),
      this.projectNames(),
    ]);
    const todos = (tasks as ApiTask[]).map((t) => ({
      id: t.id,
      content: t.content,
      // The API counts the other way round: 4 is p1.
      priority: 5 - t.priority,
      due: t.due ? (t.due.datetime ?? t.due.date) : "",
      dueString: t.due?.string ?? "",
      recurring: Boolean(t.due?.is_recurring),
      deadline: t.deadline?.date ?? "",
      project: names.get(t.project_id) ?? "",
      url: `https://app.todoist.com/app/task/${t.id}`,
    }));
    this.cache = { at: Date.now(), todos };
    return todos;
  }

  async close(id: string) {
    await this.call("POST", `/tasks/${encodeURIComponent(id)}/close`);
    this.cache = null;
  }

  async reopen(id: string) {
    await this.call("POST", `/tasks/${encodeURIComponent(id)}/reopen`);
    this.cache = null;
  }
}

/**
 * The to-dos worth showing today: overdue, due or with a deadline in the next 7 days,
 * plus anything p1 or p2. Sorted by the nearest date, then priority.
 */
export function pickTodos<T extends { due: string; deadline: string; priority: number }>(todos: T[], today: string, limit = 30) {
  const horizon = addDays(today, 7);
  const nearest = (t: T) => [t.due.slice(0, 10), t.deadline].filter(Boolean).sort()[0] ?? "";
  const shown = todos
    .filter((t) => {
      const d = nearest(t);
      return (d && d <= horizon) || t.priority <= 2;
    })
    .sort((a, b) => {
      const da = nearest(a) || "9999";
      const db = nearest(b) || "9999";
      return da === db ? a.priority - b.priority : da < db ? -1 : 1;
    });
  return { todos: shown.slice(0, limit), hidden: todos.length - Math.min(shown.length, limit) };
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
