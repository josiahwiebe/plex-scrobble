import { parseMultipartRequest } from '@remix-run/multipart-parser';
import type { PlexWebhookEvent } from '../../types.js';

/** Plex events handled by `/webhook` (lookup by Plex account id). */
export const PLEX_ID_WEBHOOK_EVENTS = ['media.scrobble', 'media.rate'] as const;

/** Plex events handled by `/webhook/:token` (includes Telegram on create). */
export const TOKEN_WEBHOOK_EVENTS = ['media.scrobble', 'media.rate', 'webhook.created'] as const;

export type PlexWebhookRouteKind = 'plex-id' | 'token';

/**
 * Classifies a webhook pathname into a route kind, or null when not a webhook path.
 */
export function getWebhookRouteKind(pathname: string): PlexWebhookRouteKind | null {
  if (pathname === '/webhook') {
    return 'plex-id';
  }

  if (pathname.startsWith('/webhook/') && pathname.length > '/webhook/'.length) {
    return 'token';
  }

  return null;
}

/**
 * Returns allowed Plex event names for the given webhook route kind.
 */
export function getAllowedPlexEvents(routeKind: PlexWebhookRouteKind): readonly string[] {
  return routeKind === 'token' ? TOKEN_WEBHOOK_EVENTS : PLEX_ID_WEBHOOK_EVENTS;
}

/**
 * Returns true when Plex sent an event this route will never handle.
 */
export function isAllowedPlexEvent(event: string, routeKind: PlexWebhookRouteKind): boolean {
  return getAllowedPlexEvents(routeKind).includes(event);
}

/**
 * Standard 200 response for Plex events filtered out before the route handler runs.
 */
export function plexWebhookIgnoredResponse(event: string): Response {
  return Response.json(
    { message: 'Invalid webhook data', event },
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Reads only the Plex `payload` field from a cloned request to determine event type.
 * Uses the original request body stream when forwarding allowed events to route handlers.
 */
export async function peekPlexWebhookEvent(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    return peekEventFromMultipart(request.clone());
  }

  if (contentType.includes('application/json')) {
    const eventData = (await request.clone().json()) as PlexWebhookEvent;
    return eventData?.event ?? null;
  }

  return null;
}

/**
 * Parses multipart Plex webhooks until the `payload` part is found, skipping later parts.
 */
async function peekEventFromMultipart(request: Request): Promise<string | null> {
  for await (const part of parseMultipartRequest(request)) {
    if (part.name === 'payload') {
      const eventData = JSON.parse(part.text) as PlexWebhookEvent;
      return eventData?.event ?? null;
    }
  }

  return null;
}
