import { next } from '@vercel/functions';
import {
  getWebhookRouteKind,
  isAllowedPlexEvent,
  peekPlexWebhookEvent,
  plexWebhookIgnoredResponse,
} from './app/lib/plex-webhook-ingress.js';

export const config = {
  matcher: ['/webhook', '/webhook/:path*'],
};

/**
 * Thin Plex webhook ingress: parse only the event type from a cloned body and
 * return early for irrelevant events without invoking React Router / Letterboxd.
 */
export default async function middleware(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return next();
  }

  const routeKind = getWebhookRouteKind(new URL(request.url).pathname);
  if (!routeKind) {
    return next();
  }

  try {
    const event = await peekPlexWebhookEvent(request);

    if (event && !isAllowedPlexEvent(event, routeKind)) {
      console.log(`[webhook ingress] ignored ${event} on ${routeKind} route`);
      return plexWebhookIgnoredResponse(event);
    }
  } catch (error) {
    console.error('[webhook ingress] peek failed, forwarding to route handler:', error);
  }

  return next();
}
