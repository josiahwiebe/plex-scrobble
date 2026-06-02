import type { PlexWebhookEvent } from '../../types.js'

/**
 * True when Plex metadata is a film. Episodes use `type: "episode"` and
 * `librarySectionType: "show"` — not caught by librarySectionType alone.
 */
export function isPlexMovieMetadata(metadata: PlexWebhookEvent['Metadata'] | undefined): boolean {
  return metadata?.type === 'movie'
}
