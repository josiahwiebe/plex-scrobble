import type { ActionFunctionArgs } from 'react-router';
import { handleTokenWebhook } from '../lib/plex-webhook.js';

export async function action({ request, params }: ActionFunctionArgs) {
  return handleTokenWebhook(request, params.token ?? '');
}
