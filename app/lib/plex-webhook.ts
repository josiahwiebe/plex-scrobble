import { waitUntil } from '@vercel/functions';
import { MultipartParseError, parseMultipartRequest } from '@remix-run/multipart-parser';
import type { PlexWebhookEvent } from '../../types.js';
import { createLetterboxdSession } from './letterboxd-scraper.js';
import { getUserByPlexId, getUserByWebhookToken, updateUser } from './database.js';
import { getUserPassword } from './password.js';
import type { User, WebhookSettings } from './schema.js';
import { createTelegramBot } from './telegram.js';
import {
  isAllowedPlexEvent,
  plexWebhookIgnoredResponse,
} from './plex-webhook-ingress.js';

export {
  getAllowedPlexEvents,
  getWebhookRouteKind,
  isAllowedPlexEvent,
  peekPlexWebhookEvent,
  plexWebhookIgnoredResponse,
  PLEX_ID_WEBHOOK_EVENTS,
  TOKEN_WEBHOOK_EVENTS,
  type PlexWebhookRouteKind,
} from './plex-webhook-ingress.js';

export interface ParsedPlexWebhook {
  eventData: PlexWebhookEvent;
}

const defaultWebhookSettings: WebhookSettings = {
  enabled: true,
  events: { scrobble: true, rate: true },
  onlyMovies: true,
};

/**
 * Parses a Plex webhook request body into event JSON.
 * Stops after the `payload` multipart field so optional thumbnail parts are not read.
 */
export async function parsePlexWebhookRequest(request: Request): Promise<ParsedPlexWebhook> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    for await (const part of parseMultipartRequest(request)) {
      if (part.name === 'payload') {
        return {
          eventData: JSON.parse(part.text) as PlexWebhookEvent,
        };
      }
    }

    throw new Error('No payload part found in multipart request');
  }

  const eventData = (await request.json()) as PlexWebhookEvent;
  return { eventData };
}

/**
 * Handles `/webhook` POSTs keyed by Plex account id.
 */
export async function handlePlexIdWebhook(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    throw new Response('Method not allowed', { status: 405 });
  }

  try {
    console.log('Processing Plex webhook...');

    const { eventData } = await parsePlexWebhookRequest(request);

    if (!isAllowedPlexEvent(eventData.event, 'plex-id')) {
      console.error('Invalid webhook data, event type:', eventData.event);
      return plexWebhookIgnoredResponse(eventData.event);
    }

    console.log('🐛 [DEBUG] Event Data:', eventData);

    const user = await getUserByPlexId(eventData.Account?.id?.toString());

    if (!user) {
      return Response.json({ message: 'User not found or not configured' }, { status: 200 });
    }

    return await processScrobbleEvent(eventData, user, null);
  } catch (error) {
    return webhookErrorResponse(error);
  }
}

/**
 * Handles `/webhook/:token` POSTs with token auth and optional Telegram notifications.
 */
export async function handleTokenWebhook(request: Request, token: string): Promise<Response> {
  const telegram = createTelegramBot();

  if (request.method !== 'POST') {
    throw new Response('Method not allowed', { status: 405 });
  }

  if (!token) {
    return Response.json({ error: 'Webhook token required' }, { status: 400 });
  }

  try {
    console.log('Processing Plex webhook for token:', token.substring(0, 8) + '...');

    const { eventData } = await parsePlexWebhookRequest(request);

    if (eventData.event === 'webhook.created') {
      await telegram?.sendWebhookSuccess('webhook.created');
      return Response.json({ message: 'Webhook created' }, { status: 200 });
    }

    if (!isAllowedPlexEvent(eventData.event, 'token')) {
      console.error('Invalid webhook data, event type:', eventData.event);
      return plexWebhookIgnoredResponse(eventData.event);
    }

    console.log('🐛 [DEBUG] Event Data:', eventData);

    const user = await getUserByWebhookToken(token);

    if (!user) {
      return Response.json({ message: 'Invalid webhook token' }, { status: 401 });
    }

    if (user.plexUsername !== eventData.Account.title) {
      console.log('🐛 [DEBUG] Scrobbling not enabled for this user');
      console.log('🐛 [DEBUG] Webhook User:', user.plexUsername);
      console.log('🐛 [DEBUG] Event Data Username:', eventData.Account.title);
      return Response.json({ message: 'Scrobbling not enabled for this user' }, { status: 200 });
    }

    return await processScrobbleEvent(eventData, user, telegram);
  } catch (error) {
    if (telegram) {
      await telegram.sendError(error as Error, 'Webhook processing');
    }

    return webhookErrorResponse(error);
  }
}

/**
 * Shared Letterboxd scrobble/rate handling once a user record is resolved.
 */
async function processScrobbleEvent(
  eventData: PlexWebhookEvent,
  user: User,
  telegram: ReturnType<typeof createTelegramBot> | null,
): Promise<Response> {
  if (!user.letterboxdUsername || !user.letterboxdPasswordHash) {
    return Response.json({ message: 'Letterboxd credentials not configured' }, { status: 200 });
  }

  const settings = user.webhookSettings || defaultWebhookSettings;

  if (!settings.enabled) {
    return Response.json({ message: 'Webhooks disabled for user' }, { status: 200 });
  }

  if (settings.onlyMovies && eventData.Metadata?.librarySectionType !== 'movie') {
    return Response.json({ message: 'Skipping non-movie content' }, { status: 200 });
  }

  const letterboxdPassword = getUserPassword(user);

  if (!letterboxdPassword) {
    return Response.json({ message: 'Failed to decrypt Letterboxd password' }, { status: 200 });
  }

  const event = eventData.event;

  if (event === 'media.scrobble' && settings.events.scrobble) {
    return await handleMarkAsWatched(eventData, user, letterboxdPassword, settings, telegram);
  }

  if (event === 'media.rate' && settings.events.rate) {
    return await handleRate(eventData, user, letterboxdPassword, settings, telegram);
  }

  return Response.json({ message: 'Event not enabled or handled', event }, { status: 200 });
}

function webhookErrorResponse(error: unknown): Response {
  if (error instanceof MultipartParseError) {
    console.error('Failed to parse multipart request:', error.message);
  } else {
    console.error('Error processing Plex event:', error);
  }

  return Response.json({ error: 'Internal server error' }, { status: 500 });
}

async function handleMarkAsWatched(
  eventData: PlexWebhookEvent,
  user: User,
  password: string,
  settings: WebhookSettings,
  telegram: ReturnType<typeof createTelegramBot> | null,
): Promise<Response> {
  try {
    console.log('Processing media.scrobble event...');

    const username = user.letterboxdUsername!;
    const scraper = await createLetterboxdSession(username, password, {
      storedCookies: user.letterboxdSessionCookies,
      onSessionCookies: async (cookies) => {
        waitUntil(updateUser(user.id, { letterboxdSessionCookies: cookies }));
      },
    });
    const result = await scraper.logFilmFromPlex(eventData, settings);
    await scraper.close();

    if (result.success) {
      if (telegram) {
        await telegram.sendWebhookSuccess('media.scrobble', eventData.Metadata?.title);
      }

      return Response.json(
        {
          message: result.message || 'Successfully logged to Letterboxd',
          film: eventData.Metadata?.title,
        },
        { status: 200 },
      );
    }

    const isActualError =
      result.reason && ['login_failed', 'mark_failed', 'unknown_error', 'film_not_found'].includes(result.reason);
    const statusCode = isActualError ? 400 : 200;

    if (telegram && isActualError) {
      await telegram.sendWebhookFailure('media.scrobble', eventData.Metadata?.title, result.message);
    }

    return Response.json(
      {
        message: result.message || 'Failed to log to Letterboxd',
        film: eventData.Metadata?.title,
        reason: result.reason,
      },
      { status: statusCode },
    );
  } catch (error) {
    console.error('Error in handleMarkAsWatched:', error);

    if (telegram) {
      await telegram.sendWebhookFailure('media.scrobble', eventData.Metadata?.title, (error as Error).message);
    }

    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

async function handleRate(
  eventData: PlexWebhookEvent,
  user: User,
  password: string,
  settings: WebhookSettings,
  telegram: ReturnType<typeof createTelegramBot> | null,
): Promise<Response> {
  try {
    console.log('Processing media.rate event...');

    const username = user.letterboxdUsername!;
    const scraper = await createLetterboxdSession(username, password, {
      storedCookies: user.letterboxdSessionCookies,
      onSessionCookies: async (cookies) => {
        waitUntil(updateUser(user.id, { letterboxdSessionCookies: cookies }));
      },
    });
    const result = await scraper.logFilmFromPlex(eventData, settings);
    await scraper.close();

    if (result.success) {
      if (telegram) {
        await telegram.sendWebhookSuccess('media.rate', eventData.Metadata?.title, eventData.rating);
      }

      return Response.json(
        {
          message: result.message || 'Successfully updated rating on Letterboxd',
          film: eventData.Metadata?.title,
          rating: eventData.rating,
        },
        { status: 200 },
      );
    }

    const isActualError =
      result.reason && ['login_failed', 'mark_failed', 'unknown_error', 'film_not_found'].includes(result.reason);
    const statusCode = isActualError ? 400 : 200;

    if (telegram && isActualError) {
      await telegram.sendWebhookFailure('media.rate', eventData.Metadata?.title, result.message);
    }

    return Response.json(
      {
        message: result.message || 'Failed to update rating on Letterboxd',
        film: eventData.Metadata?.title,
        reason: result.reason,
      },
      { status: statusCode },
    );
  } catch (error) {
    console.error('Error in handleRate:', error);

    if (telegram) {
      await telegram.sendWebhookFailure('media.rate', eventData.Metadata?.title, (error as Error).message);
    }

    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
