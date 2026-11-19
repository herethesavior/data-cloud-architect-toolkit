import app from './index.ts';
import { PAGE_SEO, SITE_URL, seoPageFromPath, seoPath } from '../../web/src/lib/seoPages.ts';
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function replaceAttribute(html: string, attribute: 'name' | 'property', key: string, value: string): string {
  const pattern = new RegExp(`(<meta\\s+${attribute}="${key}"\\s+content=")[^"]*(")`, 'i');
  return html.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${escapeHtml(value)}${suffix}`);
}

/**
 * The SPA sets page tags after hydration, which social scrapers and other
 * non-rendering clients never see. Patch the shell at the edge so every real
 * path arrives with its own title, description, and canonical URL.
 */
function applyPageMetadata(html: string, pathname: string): string {
  const page = seoPageFromPath(pathname);
  if (!page) return html;
  const { title, description } = PAGE_SEO[page];
  const canonical = `${SITE_URL}${seoPath(page)}`;

  let result = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  result = replaceAttribute(result, 'name', 'description', description);
  result = replaceAttribute(result, 'property', 'og:title', title);
  result = replaceAttribute(result, 'property', 'og:description', description);
  result = replaceAttribute(result, 'property', 'og:url', canonical);
  result = replaceAttribute(result, 'name', 'twitter:title', title);
  result = replaceAttribute(result, 'name', 'twitter:description', description);
  result = replaceAttribute(result, 'name', 'twitter:url', canonical);
  return result.replace(
    /(<link\s+rel="canonical"\s+href=")[^"]*(")/i,
    (_match, prefix: string, suffix: string) => `${prefix}${escapeHtml(canonical)}${suffix}`,
  );
}

async function serveShell(request: Request, env: PagesEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status !== 200 || !contentType.includes('text/html')) return response;

  const html = applyPageMetadata(await response.text(), new URL(request.url).pathname);
  const headers = new Headers(response.headers);
  // The patched shell has a different length and entity tag than the asset.
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Cloudflare Pages advanced-mode entry point. Pages serves the built SPA when
 * this Worker delegates to ASSETS, and routes same-origin /api/* through the
 * same Hono application used by the standalone Worker.
 */
export default {
  async fetch(request: Request, env: PagesEnv, context: AppFetchContext): Promise<Response> {
    if (isApiRequest(request)) return withSecurityHeaders(await app.fetch(request, env, context));
    return withSecurityHeaders(await serveShell(request, env));
  },
};
