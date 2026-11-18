import { Hono } from 'hono';
import { apiRoutes } from './routes/api.ts';
import { relayRoutes } from './relay.ts';
import type { Env } from './types.ts';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (context, next) => {
  await next();
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Referrer-Policy', 'no-referrer');
  context.header('X-Frame-Options', 'DENY');
  if (context.req.path.startsWith('/api/')) context.header('Cache-Control', 'no-store');
});

app.route('/', apiRoutes());
app.route('/', relayRoutes());

app.notFound((context) => context.json(
  { error: { code: 'NOT_FOUND', message: 'Unknown API route.' } },
  404,
));

export default app;
