import type { ActionFunctionArgs } from "react-router";
import { createLetterboxdSession } from "../lib/letterboxd-scraper.js";
import type { PlexWebhookEvent } from "../../types.js";
import { getUserByWebhookToken } from "../lib/database.js";
import { getUserPassword } from "../lib/password.js";
import type { WebhookSettings } from "../lib/schema.js";
import { MultipartParseError, parseMultipartRequest } from '@remix-run/multipart-parser';
import { createTelegramBot } from "../lib/telegram.js";

export async function action({ request, params }: ActionFunctionArgs) {
  const telegram = createTelegramBot();

  if (request.method !== "POST") {
    throw new Response("Method not allowed", { status: 405 });
  }

  const { token } = params;

  if (!token) {
    return Response.json({ error: 'Webhook token required' }, { status: 400 });
  }

  try {
    console.log('Processing Plex webhook for token:', token.substring(0, 8) + '...');

    let eventData: PlexWebhookEvent;
    let thumbnail: Buffer | null = null;

    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      console.log('Parsing multipart request...');
      try {
        let payloadPart = null;
        let thumbnailPart = null;
        let partCount = 0;

        for await (const part of parseMultipartRequest(request)) {
          partCount++;
          if (part.name === 'payload') {
            payloadPart = part;
          } else if (part.filename && part.filename.endsWith('.jpg')) {
            thumbnailPart = part;
          }
        }


        if (!payloadPart) {
          throw new Error('No payload part found in multipart request');
        }

        const payloadText = payloadPart.text;

        eventData = JSON.parse(payloadText) as PlexWebhookEvent;

        if (thumbnailPart) {
          thumbnail = Buffer.from(thumbnailPart.bytes);
        }
      } catch (multipartError) {
        console.error('Error parsing multipart request:', multipartError);
        console.error('Content-Type:', contentType);
        console.error('Request headers:', Object.fromEntries(request.headers.entries()));

        if (telegram) {
          await telegram.sendError(multipartError as Error, 'Multipart parsing');
        }

        throw multipartError;
      }
    } else {
      console.log('Processing regular JSON request...');
      eventData = await request.json().then(data => data as PlexWebhookEvent);
    }

    if (eventData.event === 'webhook.created') {
      await telegram?.sendWebhookSuccess('webhook.created');
      return Response.json({ message: 'Webhook created' }, { status: 200 });
    }

    if (!eventData || (eventData.event !== 'media.scrobble' && eventData.event !== 'media.rate')) {
      console.error('Invalid webhook data, event type:', eventData.event);
      return Response.json({ message: 'Invalid webhook data', event: eventData?.event }, { status: 200 });
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

    if (!user.letterboxdUsername || !user.letterboxdPasswordHash) {
      return Response.json({ message: 'Letterboxd credentials not configured' }, { status: 200 });
    }

    const defaultSettings: WebhookSettings = {
      enabled: true,
      events: { scrobble: true, rate: true },
      onlyMovies: true,
    };

    const settings = user.webhookSettings || defaultSettings;

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
      return await handleMarkAsWatched(eventData, user.letterboxdUsername, letterboxdPassword, settings, telegram);
    } else if (event === 'media.rate' && settings.events.rate) {
      return await handleRate(eventData, user.letterboxdUsername, letterboxdPassword, settings, telegram);
    } else {
      return Response.json({ message: 'Event not enabled or handled', event }, { status: 200 });
    }
  } catch (error) {
    if (error instanceof MultipartParseError) {
      console.error('Failed to parse multipart request:', error.message);
    } else {
      console.error('Error processing Plex event:', error);
    }

    if (telegram) {
      await telegram.sendError(error as Error, 'Webhook processing');
    }

    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handleMarkAsWatched(
  eventData: PlexWebhookEvent,
  username: string,
  password: string,
  settings: WebhookSettings,
  telegram?: ReturnType<typeof createTelegramBot>
) {
  try {
    console.log('Processing media.scrobble event...');

    const scraper = await createLetterboxdSession(username, password);
    const result = await scraper.logFilmFromPlex(eventData, settings);
    await scraper.close();

    if (result.success) {
      if (telegram) {
        await telegram.sendWebhookSuccess('media.scrobble', eventData.Metadata?.title);
      }

      return Response.json({
        message: result.message || 'Successfully logged to Letterboxd',
        film: eventData.Metadata?.title
      }, { status: 200 });
    } else {
      // Only send error notifications for actual errors, not filtering
      const isActualError = result.reason && ['login_failed', 'mark_failed', 'unknown_error', 'film_not_found'].includes(result.reason);

      if (telegram && isActualError) {
        await telegram.sendWebhookFailure('media.scrobble', eventData.Metadata?.title, result.message);
      }

      // For non-errors (filtering), return 200 status; for actual errors, return 400
      const statusCode = isActualError ? 400 : 200;

      return Response.json({
        message: result.message || 'Failed to log to Letterboxd',
        film: eventData.Metadata?.title,
        reason: result.reason
      }, { status: statusCode });
    }
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
  username: string,
  password: string,
  settings: WebhookSettings,
  telegram?: ReturnType<typeof createTelegramBot>
) {
  try {
    console.log('Processing media.rate event...');

    const scraper = await createLetterboxdSession(username, password);
    const result = await scraper.logFilmFromPlex(eventData, settings);
    await scraper.close();

    if (result.success) {
      if (telegram) {
        await telegram.sendWebhookSuccess('media.rate', eventData.Metadata?.title, eventData.rating);
      }

      return Response.json({
        message: result.message || 'Successfully updated rating on Letterboxd',
        film: eventData.Metadata?.title,
        rating: eventData.rating
      }, { status: 200 });
    } else {
      // Only send error notifications for actual errors, not filtering
      const isActualError = result.reason && ['login_failed', 'mark_failed', 'unknown_error', 'film_not_found'].includes(result.reason);

      if (telegram && isActualError) {
        await telegram.sendWebhookFailure('media.rate', eventData.Metadata?.title, result.message);
      }

      // For non-errors (filtering), return 200 status; for actual errors, return 400
      const statusCode = isActualError ? 400 : 200;

      return Response.json({
        message: result.message || 'Failed to update rating on Letterboxd',
        film: eventData.Metadata?.title,
        reason: result.reason
      }, { status: statusCode });
    }
  } catch (error) {
    console.error('Error in handleRate:', error);

    if (telegram) {
      await telegram.sendWebhookFailure('media.rate', eventData.Metadata?.title, (error as Error).message);
    }

    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}