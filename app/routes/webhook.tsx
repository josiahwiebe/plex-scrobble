import type { ActionFunctionArgs } from 'react-router';
import { handlePlexIdWebhook } from '../lib/plex-webhook.js';

export async function action({ request }: ActionFunctionArgs) {
  return handlePlexIdWebhook(request);
}
