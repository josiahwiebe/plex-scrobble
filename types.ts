export interface PlexWebhookEvent {
  event: string;
  user: boolean;
  owner: boolean;
  Account: {
    id: number;
    thumb: string;
    title: string;
  };
  Server: {
    title: string;
    uuid: string;
  };
  Player: {
    local: boolean;
    publicAddress: string;
    title: string;
    uuid: string;
  };
  Metadata: {
    librarySectionType: string;
    ratingKey: string;
    key: string;
    parentRatingKey?: string;
    grandparentRatingKey?: string;
    guid: string;
    studio?: string;
    type: string;
    title: string;
    titleSort?: string;
    librarySectionTitle: string;
    librarySectionID: number;
    librarySectionKey: string;
    contentRating?: string;
    summary?: string;
    rating?: number;
    audienceRating?: number;
    userRating?: number;
    viewCount?: number;
    lastViewedAt?: number;
    year?: number;
    tagline?: string;
    thumb?: string;
    art?: string;
    duration?: number;
    originallyAvailableAt?: string;
    addedAt: number;
    updatedAt: number;
    audienceRatingImage?: string;
    chapterSource?: string;
    primaryExtraKey?: string;
    ratingImage?: string;
    Media?: Array<{
      id: number;
      duration: number;
      bitrate: number;
      width: number;
      height: number;
      aspectRatio: number;
      audioChannels: number;
      audioCodec: string;
      videoCodec: string;
      videoResolution: string;
      container: string;
      videoFrameRate: string;
      audioProfile?: string;
      videoProfile?: string;
      Part: Array<{
        id: number;
        key: string;
        duration: number;
        file: string;
        size: number;
        audioProfile?: string;
        container: string;
        videoProfile?: string;
      }>;
    }>;
    Genre?: Array<{
      tag: string;
    }>;
    Director?: Array<{
      tag: string;
    }>;
    Writer?: Array<{
      tag: string;
    }>;
    Producer?: Array<{
      tag: string;
    }>;
    Country?: Array<{
      tag: string;
    }>;
    Guid?: Array<{
      id: string;
    }>;
    Rating?: Array<{
      image: string;
      value: number;
      type: string;
    }>;
    Role?: Array<{
      tag: string;
    }>;
  };
  rating?: number;
}

export interface LetterboxdFilm {
  title: string;
  url: string;
  slug: string;
  uid: string; // film:123 or just the ID
}

export interface LetterboxdLoginOptions {
  username: string;
  password: string;
}

export interface LetterboxdWatchOptions {
  watchedDate?: string;
  rating?: number;
  review?: string;
  tags?: string;
}

export interface ScrobbleResult {
  success: boolean;
  reason?: 'webhooks_disabled' | 'non_movie' | 'event_disabled' | 'film_not_found' | 'login_failed' | 'mark_failed' | 'unknown_error';
  message?: string;
  error?: Error;
}