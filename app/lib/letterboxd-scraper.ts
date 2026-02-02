import { PlexWebhookEvent, LetterboxdFilm, LetterboxdWatchOptions, ScrobbleResult } from '../../types.js';
import { WebhookSettings } from './schema.js';

// Use loose types to handle both puppeteer and puppeteer-core variants
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ElementHandleInstance = any;

/** Modern Chrome user-agent - update periodically */
const CHROME_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Letterboxd scraper with stealth mode and bot detection evasion.
 * Uses puppeteer-extra with stealth plugin to avoid Cloudflare blocks.
 */
export class LetterboxdScraper {
  private browser: BrowserInstance | null = null;
  private page: PageInstance | null = null;
  private isLoggedIn: boolean = false;
  private cookies: Cookie[] = [];
  private csrfToken: string | null = null;

  /**
   * Initialize browser with stealth mode enabled.
   * Uses puppeteer-extra on local dev and puppeteer-core with chromium on Vercel.
   */
  async init(): Promise<void> {
    const isVercel = !!process.env.VERCEL_ENV;

    let launchOptions: any = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
      ]
    };

    try {
      if (isVercel) {
        // On Vercel, use puppeteer-core with @sparticuz/chromium
        // Note: stealth plugin doesn't work with puppeteer-core, but we add extra evasions
        const chromium = (await import("@sparticuz/chromium")).default;
        const puppeteerCore = await import("puppeteer-core");

        launchOptions = {
          ...launchOptions,
          args: [...launchOptions.args, ...chromium.args],
          executablePath: await chromium.executablePath(),
          headless: true,
        };

        this.browser = await puppeteerCore.launch(launchOptions);
      } else {
        // On local dev, use puppeteer-extra with stealth plugin
        const puppeteerExtra = (await import("puppeteer-extra")).default;
        const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;

        puppeteerExtra.use(StealthPlugin());
        this.browser = await puppeteerExtra.launch(launchOptions);
      }

      this.page = await this.browser.newPage();

      // Set modern user-agent
      await this.page.setUserAgent(CHROME_USER_AGENT);
      await this.page.setViewport({ width: 1920, height: 1080 });
      this.page.setDefaultTimeout(30000);

      // Additional evasion: override navigator.webdriver
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
        // Mock plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        // Mock languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
      });

    } catch (error) {
      console.error('Failed to initialize Puppeteer:', error);
      throw new Error(`Browser initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Wait for Cloudflare challenge to complete.
   * Polls page title/content for challenge indicators.
   */
  private async waitForCloudflare(maxWaitMs = 30000): Promise<void> {
    if (!this.page) return;

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const title = await this.page.title();
        const content = await this.page.content();

        // Cloudflare challenge indicators
        const isCloudflareChallenge =
          title?.includes('Just a moment') ||
          title?.includes('Attention Required') ||
          content?.includes('cf-browser-verification') ||
          content?.includes('challenge-platform') ||
          content?.includes('cf-turnstile');

        if (!isCloudflareChallenge) {
          return; // Challenge cleared or not present
        }

        console.log('Waiting for Cloudflare challenge to complete...');
        await this.randomDelay(2000, 3000);
      } catch (error) {
        // Page might be navigating, wait and retry
        await this.randomDelay(1000, 2000);
      }
    }

    console.warn('Cloudflare challenge did not clear within timeout');
  }

  /**
   * Add a random delay to mimic human behavior.
   */
  private async randomDelay(minMs = 500, maxMs = 1500): Promise<void> {
    const delay = minMs + Math.random() * (maxMs - minMs);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Type text with human-like delays between keystrokes.
   */
  private async humanType(element: ElementHandleInstance, text: string): Promise<void> {
    for (const char of text) {
      await element.type(char, { delay: 50 + Math.random() * 100 });
      // Occasional longer pause (simulates thinking)
      if (Math.random() < 0.1) {
        await this.randomDelay(100, 300);
      }
    }
  }

  /**
   * Login to Letterboxd with a single attempt.
   * Use loginWithRetry() for production use.
   */
  async login(username: string, password: string): Promise<boolean> {
    if (!this.page) await this.init();

    try {
      console.log('Navigating to Letterboxd sign-in page...');
      await this.page!.goto('https://letterboxd.com/sign-in/', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // Wait for any Cloudflare challenge to clear
      await this.waitForCloudflare();

      // Random delay before interacting (human behavior)
      await this.randomDelay(1000, 2000);

      // Find username field
      let usernameField: ElementHandleInstance | null = null;
      const usernameSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="text"]', 'input[type="email"]'];

      for (const selector of usernameSelectors) {
        usernameField = await this.page!.$(selector);
        if (usernameField) {
          console.log(`Found username field with selector: ${selector}`);
          break;
        }
      }

      if (!usernameField) {
        const pageTitle = await this.page!.title();
        const pageUrl = this.page!.url();
        console.error(`Username field not found. Page title: "${pageTitle}", URL: ${pageUrl}`);
        throw new Error('Username field not found - page structure may have changed');
      }

      // Find password field
      let passwordField = await this.page!.$('input[name="password"]');
      if (!passwordField) {
        passwordField = await this.page!.$('input[type="password"]');
      }

      if (!passwordField) {
        throw new Error('Password field not found');
      }

      // Type credentials with human-like delays
      console.log('Entering credentials...');
      await this.humanType(usernameField, username);
      await this.randomDelay(300, 700);
      await this.humanType(passwordField, password);
      await this.randomDelay(500, 1000);

      // Find and click submit button
      const submitButton = await this.page!.$('input[type="submit"], button[type="submit"]');
      if (!submitButton) {
        throw new Error('Submit button not found');
      }

      const navigationPromise = this.page!.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 30000
      }).catch((err: Error) => {
        console.log('Navigation wait failed:', err.message);
        return null;
      });

      await submitButton.click();
      await navigationPromise;

      // Wait for any post-login Cloudflare challenge
      await this.waitForCloudflare();

      // Verify login succeeded
      this.isLoggedIn = await this.verifyLoggedIn();

      if (this.isLoggedIn) {
        console.log('Successfully logged in to Letterboxd');
        await this.saveCookies();
      } else {
        // Capture diagnostic info
        const pageTitle = await this.page!.title();
        const currentUrl = this.page!.url();
        const errorMessage = await this.page!.$eval('.error, .form-error, .message',
          (el: Element) => el.textContent).catch(() => 'No specific error message found');

        console.error(`Login failed. Title: "${pageTitle}", URL: ${currentUrl}, Error: ${errorMessage}`);
        throw new Error(`Login failed - ${errorMessage}`);
      }

      return this.isLoggedIn;
    } catch (error) {
      console.error('Login error:', error);

      // Log additional diagnostics
      if (this.page) {
        try {
          const pageTitle = await this.page.title();
          const pageUrl = this.page.url();
          console.error(`Diagnostic - Page title: "${pageTitle}", URL: ${pageUrl}`);
        } catch (e) {
          // Ignore diagnostic errors
        }
      }

      return false;
    }
  }

  /**
   * Login with retry logic and exponential backoff.
   * Recommended for production use.
   */
  async loginWithRetry(username: string, password: string, maxAttempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`Login attempt ${attempt}/${maxAttempts}...`);

      try {
        const success = await this.login(username, password);
        if (success) {
          return true;
        }
      } catch (error) {
        console.error(`Login attempt ${attempt} failed:`, error);
      }

      if (attempt < maxAttempts) {
        // Exponential backoff: 2s, 4s, 8s...
        const delayMs = Math.pow(2, attempt) * 1000;
        console.log(`Waiting ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));

        // Reinitialize browser for fresh state
        await this.close();
        await this.init();
      }
    }

    console.error(`All ${maxAttempts} login attempts failed`);
    return false;
  }

  /**
   * Verify that the user is actually logged in by checking session state.
   */
  private async verifyLoggedIn(): Promise<boolean> {
    if (!this.page) return false;

    try {
      const currentUrl = this.page.url();

      // If still on sign-in page, definitely not logged in
      if (currentUrl.includes('/sign-in')) {
        return false;
      }

      // Check for logged-in indicators in the page
      const hasLoggedInElements = await this.page.evaluate(() => {
        // Look for elements that only appear when logged in
        const avatar = document.querySelector('.avatar, .nav-avatar, [data-person]');
        const signOutLink = document.querySelector('a[href*="sign-out"]');
        const activityLink = document.querySelector('a[href*="/activity"]');

        return !!(avatar || signOutLink || activityLink);
      });

      return hasLoggedInElements;
    } catch (error) {
      console.error('Error verifying login status:', error);
      return false;
    }
  }

  async saveCookies(): Promise<void> {
    if (!this.page) return;

    const cookies = await this.page.cookies();
    this.cookies = cookies;

    const csrfCookie = cookies.find((cookie: Cookie) => cookie.name === 'com.xk72.webparts.csrf');
    if (csrfCookie) {
      this.csrfToken = csrfCookie.value;
    }
  }

  async loadCookies(): Promise<boolean> {
    try {
      if (this.cookies && this.cookies.length > 0 && this.page) {
        await this.page.setCookie(...this.cookies);

        const csrfCookie = this.cookies.find(cookie => cookie.name === 'com.xk72.webparts.csrf');
        if (csrfCookie) {
          this.csrfToken = csrfCookie.value;
        }

        this.isLoggedIn = true;
        return true;
      }
    } catch (error) {
      console.error('Error loading cookies:', error);
    }
    return false;
  }

  private getCookieString(): string {
    return this.cookies
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  private extractExternalIds(plexEvent: PlexWebhookEvent): { imdb?: string; tmdb?: string } {
    const guids = plexEvent.Metadata.Guid || [];
    const ids: { imdb?: string; tmdb?: string } = {};

    for (const guid of guids) {
      if (guid.id.startsWith('imdb://')) {
        ids.imdb = guid.id.replace('imdb://', '');
      } else if (guid.id.startsWith('tmdb://')) {
        ids.tmdb = guid.id.replace('tmdb://', '');
      }
    }

    return ids;
  }

  private async searchByExternalId(provider: 'imdb' | 'tmdb', id: string): Promise<LetterboxdFilm | null> {
    if (!this.page) return null;

    try {
      const searchQuery = `${provider}:${id}`;
      await this.page.goto(`https://letterboxd.com/search/films/${searchQuery}/`, {
        waitUntil: 'networkidle2'
      });

      // Wait for Cloudflare if present
      await this.waitForCloudflare();

      // Wait for either the new React components or old film-poster elements
      await Promise.race([
        this.page.waitForSelector('.react-component.figure[data-item-slug]', { timeout: 5000 }),
        this.page.waitForSelector('.film-poster', { timeout: 5000 }),
        this.page.waitForSelector('.no-results', { timeout: 5000 })
      ]).catch(() => {
        // Continue if timeout - we'll check what's actually on the page
      });

      const film = await this.page.evaluate(() => {
        // Look for the React component element that contains the film data
        const filmElement = document.querySelector('.react-component.figure[data-item-slug]') ||
                           document.querySelector('.film-poster');

        if (!filmElement) return null;

        // Extract data using the correct attribute names from the HTML structure
        const filmUrl = filmElement.getAttribute('data-item-link') ||
                       filmElement.getAttribute('data-film-link');

        const filmTitle = filmElement.getAttribute('data-item-name') ||
                         filmElement.getAttribute('data-film-name');

        // Extract UID from the postered-identifier JSON
        let uid = null;
        const posteredIdentifier = filmElement.getAttribute('data-postered-identifier');
        if (posteredIdentifier) {
          try {
            const parsed = JSON.parse(posteredIdentifier);
            uid = parsed.uid;
          } catch (e) {
            // Fall back to other methods if JSON parsing fails
          }
        }

        // Fallback UID methods
        if (!uid) {
          uid = filmElement.getAttribute('data-item-uid');
        }
        if (!uid) {
          const filmId = filmElement.getAttribute('data-film-id');
          if (filmId) {
            uid = `film:${filmId}`;
          }
        }

        if (filmUrl && filmTitle && uid) {
          return {
            title: filmTitle,
            url: `https://letterboxd.com${filmUrl}`,
            slug: filmUrl,
            uid: uid
          };
        }
        return null;
      });

      if (film) {
        console.log(`Found film via ${provider.toUpperCase()} ID: ${film.title}`);
        return film;
      }
    } catch (error) {
      console.error(`Error searching by ${provider} ID:`, error);
    }

    return null;
  }

  async searchFilm(title: string, year?: number, director?: string, externalIds?: { imdb?: string; tmdb?: string }): Promise<LetterboxdFilm | null> {
    if (!this.page) await this.init();

    try {
      // Try searching with external IDs first (more accurate)
      if (externalIds?.imdb) {
        console.log(`Trying IMDB search: ${externalIds.imdb}`);
        const imdbResult = await this.searchByExternalId('imdb', externalIds.imdb);
        if (imdbResult) return imdbResult;
      }

      if (externalIds?.tmdb) {
        console.log(`Trying TMDB search: ${externalIds.tmdb}`);
        const tmdbResult = await this.searchByExternalId('tmdb', externalIds.tmdb);
        if (tmdbResult) return tmdbResult;
      }

      // Fallback to title search
      console.log(`Falling back to title search: ${title}`);
      let searchQuery = encodeURIComponent(title);
      await this.page!.goto(`https://letterboxd.com/search/films/${searchQuery}/`, {
        waitUntil: 'networkidle2'
      });

      // Wait for Cloudflare if present
      await this.waitForCloudflare();

      // Wait for either the new React components or old film-poster elements
      await Promise.race([
        this.page!.waitForSelector('.react-component.figure[data-item-slug]', { timeout: 5000 }),
        this.page!.waitForSelector('.film-poster', { timeout: 5000 })
      ]).catch(() => {
        // Continue if timeout - we'll check what's actually on the page
      });

      const films = await this.page!.evaluate(() => {
        // Look for React component elements or fallback to film-poster
        let filmElements = document.querySelectorAll('.react-component.figure[data-item-slug]');
        if (filmElements.length === 0) {
          filmElements = document.querySelectorAll('.film-poster');
        }
        const results: Array<{ title: string; url: string; slug: string; uid: string }> = [];

        for (const element of filmElements) {
          // Extract data using the correct attribute names
          const filmUrl = element.getAttribute('data-item-link') ||
                         element.getAttribute('data-film-link');

          const filmTitle = element.getAttribute('data-item-name') ||
                           element.getAttribute('data-film-name');

          // Extract UID from the postered-identifier JSON
          let uid = null;
          const posteredIdentifier = element.getAttribute('data-postered-identifier');
          if (posteredIdentifier) {
            try {
              const parsed = JSON.parse(posteredIdentifier);
              uid = parsed.uid;
            } catch (e) {
              // Fall back to other methods if JSON parsing fails
            }
          }

          // Fallback UID methods
          if (!uid) {
            uid = element.getAttribute('data-item-uid');
          }
          if (!uid) {
            const filmId = element.getAttribute('data-film-id');
            if (filmId) {
              uid = `film:${filmId}`;
            }
          }

          if (filmUrl && filmTitle && uid) {
            results.push({
              title: filmTitle,
              url: `https://letterboxd.com${filmUrl}`,
              slug: filmUrl,
              uid: uid
            });
          }
        }

        return results;
      });

      if (films.length === 0) {
        console.log(`No films found for: ${title}`);
        return null;
      }

      let bestMatch = films[0];

      if (year) {
        for (const film of films) {
          if (film.title.toLowerCase().includes(title.toLowerCase()) &&
              film.title.includes(year.toString())) {
            bestMatch = film;
            break;
          }
        }
      }

      console.log(`Found film: ${bestMatch.title} - ${bestMatch.url}`);
      return bestMatch;
    } catch (error) {
      console.error('Error searching for film:', error);
      return null;
    }
  }

  async markAsWatched(
    film: LetterboxdFilm,
    options: LetterboxdWatchOptions = {}
  ): Promise<boolean> {
    if (!this.isLoggedIn) {
      throw new Error('Not logged in to Letterboxd');
    }

    if (!this.csrfToken) {
      throw new Error('No CSRF token available');
    }

    const { watchedDate, rating, review, tags } = options;

    try {
      console.log(`Using UID from search results: ${film.uid}`);

      const now = new Date();
      const defaultDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      const formData = new URLSearchParams({
        json: 'true',
        __csrf: this.csrfToken,
        viewingId: '',
        viewingableUid: film.uid,
        specifiedDate: 'true',
        viewingDateStr: watchedDate || defaultDate,
        review: review || '',
        tags: tags || '',
        rating: rating ? rating.toString() : '0',
        viewingableUID: film.uid
      });

      // Make the HTTP request to log the film
      console.log('Sending diary entry with data:', {
        viewingableUid: film.uid,
        watchedDate: watchedDate || defaultDate,
        rating: rating ? rating.toString() : '0',
      });

      const response = await fetch('https://letterboxd.com/s/save-diary-entry', {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'cookie': this.getCookieString(),
          'dnt': '1',
          'origin': 'https://letterboxd.com',
          'referer': film.url,
          'user-agent': CHROME_USER_AGENT,
          'x-requested-with': 'XMLHttpRequest'
        },
        body: formData.toString()
      });

      const responseText = await response.text();
      console.log('Response body:', responseText);

      if (response.ok) {
        console.log('Successfully marked film as watched via HTTP API');
        return true;
      } else {
        console.error('HTTP request failed:', response.status, responseText);
        return false;
      }
    } catch (error) {
      console.error('Error marking film as watched via HTTP:', error);
      return false;
    }
  }

  async logFilmFromPlex(plexEvent: PlexWebhookEvent, webhookSettings?: WebhookSettings): Promise<ScrobbleResult> {
    const metadata = plexEvent.Metadata;

    // Check webhook settings
    if (webhookSettings) {
      // Skip if webhooks are disabled
      if (!webhookSettings.enabled) {
        console.log('Webhooks disabled, skipping');
        return {
          success: false,
          reason: 'webhooks_disabled',
          message: 'Webhooks are disabled in settings'
        };
      }

      // Skip if movies-only filter is enabled and this isn't a movie
      if (webhookSettings.onlyMovies && metadata.librarySectionType !== 'movie') {
        console.log('Movies-only filter enabled, skipping non-movie');
        return {
          success: false,
          reason: 'non_movie',
          message: 'Movies-only filter enabled, skipping non-movie content'
        };
      }

      // Check if this event type is enabled
      if (plexEvent.event === 'media.scrobble' && !webhookSettings.events.scrobble) {
        console.log('Scrobble events disabled, skipping');
        return {
          success: false,
          reason: 'event_disabled',
          message: 'Scrobble events are disabled in settings'
        };
      }

      if (plexEvent.event === 'media.rate' && !webhookSettings.events.rate) {
        console.log('Rate events disabled, skipping');
        return {
          success: false,
          reason: 'event_disabled',
          message: 'Rate events are disabled in settings'
        };
      }
    }

    if (metadata.librarySectionType !== 'movie') {
      console.log('Not a movie, skipping');
      return {
        success: false,
        reason: 'non_movie',
        message: 'Content is not a movie, skipping'
      };
    }

    const title = metadata.title;
    const year = metadata.year;
    const director = metadata.Director?.[0]?.tag;
    const userRating = plexEvent.rating || metadata.userRating;

    console.log(`Processing film: ${title} (${year})`);

    try {
      if (!this.isLoggedIn) {
        await this.loadCookies();
        if (!this.isLoggedIn) {
          return {
            success: false,
            reason: 'login_failed',
            message: 'Not logged in to Letterboxd. Please log in first.',
            error: new Error('Login failed')
          };
        }
      }

      // Extract external IDs for better matching
      const externalIds = this.extractExternalIds(plexEvent);

      const film = await this.searchFilm(title, year, director, externalIds);
      if (!film) {
        console.log(`Could not find film: ${title} (${year})`);
        return {
          success: false,
          reason: 'film_not_found',
          message: `Could not find film: ${title} (${year}) on Letterboxd`,
          error: new Error(`Film not found: ${title}`)
        };
      }

      // Use the actual timestamp from Plex when the movie was watched
      let watchedDate: string;
      if (metadata.lastViewedAt) {
        const watchedDateTime = new Date(metadata.lastViewedAt * 1000); // Convert Unix timestamp to Date
        watchedDate = `${watchedDateTime.getFullYear()}-${String(watchedDateTime.getMonth() + 1).padStart(2, '0')}-${String(watchedDateTime.getDate()).padStart(2, '0')}`;
      } else {
        // Fallback to current date if no lastViewedAt is available
        const now = new Date();
        watchedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      }

      const success = await this.markAsWatched(film, {
        watchedDate,
        rating: userRating,
        tags: 'plex'
      });

      if (success) {
        return {
          success: true,
          message: `Successfully logged ${title} to Letterboxd`
        };
      } else {
        return {
          success: false,
          reason: 'mark_failed',
          message: `Failed to mark ${title} as watched on Letterboxd`,
          error: new Error('Mark as watched failed')
        };
      }
    } catch (error) {
      return {
        success: false,
        reason: 'unknown_error',
        message: `Unexpected error processing ${title}`,
        error: error as Error
      };
    }
  }

  async close(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    } catch (error) {
      console.error('Error closing browser:', error);
      // Force kill if normal close fails
      if (this.browser) {
        try {
          await this.browser.close();
        } catch (e) {
          // Ignore errors during force close
        }
      }
    }
    this.isLoggedIn = false;
  }
}

/**
 * Create a Letterboxd session with login retry logic.
 * @param username - Letterboxd username
 * @param password - Letterboxd password
 * @returns Authenticated LetterboxdScraper instance
 * @throws Error if all login attempts fail
 */
export async function createLetterboxdSession(username: string, password: string): Promise<LetterboxdScraper> {
  const scraper = new LetterboxdScraper();
  await scraper.init();

  const cookiesLoaded = await scraper.loadCookies();
  if (!cookiesLoaded) {
    // Use retry logic for login
    const loginSuccess = await scraper.loginWithRetry(username, password, 3);
    if (!loginSuccess) {
      await scraper.close();
      throw new Error('Failed to login to Letterboxd after multiple attempts');
    }
  }

  return scraper;
}
