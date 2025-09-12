import puppeteer, { Browser, Page } from 'puppeteer';
import { PlexWebhookEvent, LetterboxdFilm, LetterboxdWatchOptions } from '../../types.js';
import { WebhookSettings } from './schema.js';

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

export class LetterboxdScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isLoggedIn: boolean = false;
  private cookies: Cookie[] = [];
  private csrfToken: string | null = null;

  async init(): Promise<void> {
    const isVercel = !!process.env.VERCEL_ENV;
    let puppeteer
    let launchOptions: any = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    };

    if (isVercel) {
      const chromium = (await import("@sparticuz/chromium")).default;
      puppeteer = await import("puppeteer-core");
      launchOptions = {
        ...launchOptions,
        args: [...launchOptions.args, ...chromium.args],
        executablePath: await chromium.executablePath(),
        headless: true,
      };
    } else {
      puppeteer = await import("puppeteer");
    }

    try {
      this.browser = await puppeteer.launch(launchOptions) as Browser;
      this.page = await this.browser.newPage();

      await this.page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      await this.page.setViewport({ width: 1280, height: 720 });

      this.page.setDefaultTimeout(30000);

    } catch (error) {
      console.error('Failed to initialize Puppeteer:', error);
      throw new Error(`Browser initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async login(username: string, password: string): Promise<boolean> {
    if (!this.page) await this.init();

    try {
      await this.page!.goto('https://letterboxd.com/sign-in/', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      let usernameField = null;
      const usernameSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="text"]', 'input[type="email"]'];

      for (const selector of usernameSelectors) {
        usernameField = await this.page!.$(selector);
        if (usernameField) {
          break;
        }
      }

      if (!usernameField) {
        throw new Error('Username field not found');
      }

      let passwordField = await this.page!.$('input[name="password"]');
      if (!passwordField) {
        passwordField = await this.page!.$('input[type="password"]');
      }

      if (!passwordField) {
        throw new Error('Password field not found');
      }

      await usernameField.type(username, { delay: 50 });
      await passwordField.type(password, { delay: 50 });

      const submitButton = await this.page!.$('input[type="submit"], button[type="submit"]');
      if (!submitButton) {
        throw new Error('Submit button not found');
      }

      const navigationPromise = this.page!.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 30000
      }).catch(err => {
        console.log('Navigation wait failed:', err.message);
        return null;
      });

      await submitButton.click();
      await navigationPromise;

      const currentUrl = this.page!.url();
      this.isLoggedIn = !currentUrl.includes('/sign-in/');

      if (this.isLoggedIn) {
        console.log('Successfully logged in to Letterboxd');
        await this.saveCookies();
      } else {
        const errorMessage = await this.page!.$eval('.error, .form-error, .message',
          el => el.textContent).catch(() => 'No specific error found');
        throw new Error(`Login failed - still on sign-in page. Error: ${errorMessage}`);
      }

      return this.isLoggedIn;
    } catch (error) {
      console.error('Login error:', error);

      return false;
    }
  }

  async saveCookies(): Promise<void> {
    if (!this.page) return;

    const cookies = await this.page.cookies();
    this.cookies = cookies;

    const csrfCookie = cookies.find(cookie => cookie.name === 'com.xk72.webparts.csrf');
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

      // Wait for either the new React components or old film-poster elements
      await Promise.race([
        this.page.waitForSelector('.react-component.figure[data-item-slug]', { timeout: 3000 }),
        this.page.waitForSelector('.film-poster', { timeout: 3000 }),
        this.page.waitForSelector('.no-results', { timeout: 3000 })
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
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

  async logFilmFromPlex(plexEvent: PlexWebhookEvent, webhookSettings?: WebhookSettings): Promise<boolean> {
    const metadata = plexEvent.Metadata;

    // Check webhook settings
    if (webhookSettings) {
      // Skip if webhooks are disabled
      if (!webhookSettings.enabled) {
        console.log('Webhooks disabled, skipping');
        return false;
      }

      // Skip if movies-only filter is enabled and this isn't a movie
      if (webhookSettings.onlyMovies && metadata.librarySectionType !== 'movie') {
        console.log('Movies-only filter enabled, skipping non-movie');
        return false;
      }

      // Check if this event type is enabled
      if (plexEvent.event === 'media.scrobble' && !webhookSettings.events.scrobble) {
        console.log('Scrobble events disabled, skipping');
        return false;
      }

      if (plexEvent.event === 'media.rate' && !webhookSettings.events.rate) {
        console.log('Rate events disabled, skipping');
        return false;
      }
    }

    if (metadata.librarySectionType !== 'movie') {
      console.log('Not a movie, skipping');
      return false;
    }

    const title = metadata.title;
    const year = metadata.year;
    const director = metadata.Director?.[0]?.tag;
    const userRating = plexEvent.rating || metadata.userRating;

    console.log(`Processing film: ${title} (${year})`);

    if (!this.isLoggedIn) {
      await this.loadCookies();
      if (!this.isLoggedIn) {
        throw new Error('Not logged in to Letterboxd. Please log in first.');
      }
    }

    // Extract external IDs for better matching
    const externalIds = this.extractExternalIds(plexEvent);

    const film = await this.searchFilm(title, year, director, externalIds);
    if (!film) {
      console.log(`Could not find film: ${title} (${year})`);
      return false;
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

    return success;
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
  }
}

export async function createLetterboxdSession(username: string, password: string): Promise<LetterboxdScraper> {
  const scraper = new LetterboxdScraper();
  await scraper.init();

  const cookiesLoaded = await scraper.loadCookies();
  if (!cookiesLoaded) {
    const loginSuccess = await scraper.login(username, password);
    if (!loginSuccess) {
      throw new Error('Failed to login to Letterboxd');
    }
  }

  return scraper;
}