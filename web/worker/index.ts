// The web app's Cloudflare Worker. Cloudflare serves the static files (web/dist) itself without running this code;
// only /api/* and /ws reach it (`run_worker_first` in wrangler.jsonc), and those are forwarded unchanged to the
// exchange on Fly. A websocket upgrade passes straight through: the 101 response carries the socket back.

interface Env {
  API_ORIGIN: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    return fetch(new Request(env.API_ORIGIN + url.pathname + url.search, request));
  },
};
