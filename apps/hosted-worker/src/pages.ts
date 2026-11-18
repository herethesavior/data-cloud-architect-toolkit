import app from './index.ts';
import type { AssetFetcher, Env } from './types.ts';

type PagesEnv = Env & { ASSETS: AssetFetcher };
type AppFetchContext = Parameters<typeof app.fetch>[2];

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isApiRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Cloudflare Pages advanced-mode entry point. Pages serves the built SPA when
 * this Worker delegates to ASSETS, and routes same-origin /api/* through the
 * same Hono application used by the standalone Worker.
 */
export default {
  async fetch(request: Request, env: PagesEnv, context: AppFetchContext): Promise<Response> {
    if (isApiRequest(request)) return withSecurityHeaders(await app.fetch(request, env, context));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
