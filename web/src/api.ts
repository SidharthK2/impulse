// REST client and the live websocket feed.

const KEY = "impulse.apiKey";
const ADMIN = "impulse.adminToken";

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function write(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // private mode: the session still works until reload
  }
}

let apiKey = read(KEY);
let adminToken = read(ADMIN) ?? "";

export const getKey = () => apiKey;
export const getAdminToken = () => adminToken;

export function setKey(k: string | null) {
  apiKey = k;
  write(KEY, k);
  live.auth(k);
}

export function setAdminToken(t: string) {
  adminToken = t;
  write(ADMIN, t);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { admin?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (opts.admin) headers["x-admin-token"] = adminToken;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

// ---------- websocket ----------

type Listener = (data: unknown) => void;

class Live {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private last = new Map<string, unknown>();
  private key: string | null = apiKey;
  private retry = 500;
  connected = false;
  private statusListeners = new Set<(c: boolean) => void>();

  constructor() {
    this.connect();
  }

  private connect() {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.setConnected(true);
      if (this.key) ws.send(JSON.stringify({ op: "auth", key: this.key }));
      for (const ch of this.listeners.keys()) ws.send(JSON.stringify({ op: "sub", ch }));
    };
    ws.onmessage = (ev) => {
      let msg: { ch: string; data: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.last.set(msg.ch, msg.data);
      for (const l of this.listeners.get(msg.ch) ?? []) l(msg.data);
    };
    ws.onclose = () => {
      this.setConnected(false);
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 8000);
    };
  }

  private setConnected(c: boolean) {
    this.connected = c;
    for (const l of this.statusListeners) l(c);
  }

  onStatus(l: (c: boolean) => void) {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  auth(key: string | null) {
    this.key = key;
    this.last.delete("account");
    this.send({ op: "auth", key });
  }

  subscribe(ch: string, l: Listener): () => void {
    let set = this.listeners.get(ch);
    if (!set) {
      set = new Set();
      this.listeners.set(ch, set);
      this.send({ op: "sub", ch });
    }
    set.add(l);
    if (this.last.has(ch)) l(this.last.get(ch));
    return () => {
      set.delete(l);
      if (set.size === 0) {
        this.listeners.delete(ch);
        this.last.delete(ch);
        this.send({ op: "unsub", ch });
      }
    };
  }
}

export const live = new Live();
