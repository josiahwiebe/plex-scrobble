import type { PlexWebhookEvent, LetterboxdFilm, LetterboxdWatchOptions, ScrobbleResult } from '../../types.js'
import type { LetterboxdSessionCookie, WebhookSettings } from './schema.js'
import { letterboxdLoginViaBrowserRendering } from './letterboxd-browser-rendering.js'

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface CreateLetterboxdSessionOptions {
  /** Previously persisted cookies from DB */
  storedCookies?: LetterboxdSessionCookie[] | null
  /** Called when session cookies change (persist to DB) */
  onSessionCookies?: (cookies: LetterboxdSessionCookie[]) => void | Promise<void>
  /** Skip stored cookies and run a full login (e.g. “test login” from settings). */
  forceFreshLogin?: boolean
}

function buildCookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function getSetCookieLines(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }
  const single = response.headers.get('set-cookie')
  return single ? [single] : []
}

function parseCookiePair(setCookieLine: string): { name: string; value: string } | null {
  const first = setCookieLine.split(';')[0]?.trim()
  if (!first) return null
  const eq = first.indexOf('=')
  if (eq === -1) return null
  return { name: first.slice(0, eq), value: first.slice(eq + 1) }
}

function mergeResponseCookies(response: Response, jar: Map<string, string>): void {
  for (const line of getSetCookieLines(response)) {
    const parsed = parseCookiePair(line)
    if (parsed) {
      jar.set(parsed.name, parsed.value)
    }
  }
}

export function sessionCookiesFromJar(jar: Map<string, string>): LetterboxdSessionCookie[] {
  return [...jar.entries()].map(([name, value]) => ({ name, value }))
}

function isCloudflareChallenge(html: string, status: number, headers: Headers): boolean {
  if (headers.get('cf-mitigated')) return true
  if (status === 403 && (html.includes('cf-browser-verification') || html.includes('Just a moment'))) {
    return true
  }
  return (
    html.includes('cf-turnstile') || html.includes('challenge-platform') || html.includes('cf-browser-verification')
  )
}

type LoginJson = { result?: string | boolean; message?: string; csrf?: string }

function tryParseJson(text: string): LoginJson | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  try {
    return JSON.parse(t) as LoginJson
  } catch {
    return null
  }
}

/** Letterboxd has used both string and boolean shapes for `result` over time. */
function isLoginJsonSuccess(json: LoginJson | null): boolean {
  if (!json) return false
  const r = json.result
  return r === true || r === 'success' || r === 'Success'
}

function isLoginJsonFailure(json: LoginJson | null): boolean {
  if (!json) return false
  const r = json.result
  return r === false || r === 'failure' || r === 'Failure'
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractTitle(html: string): string {
  const og = html.match(/property="og:title"\s+content="([^"]+)"/)
  if (og) {
    return og[1]
      .replace(/\s*\(\d{4}\)\s*\|\s*Letterboxd\s*$/i, '')
      .replace(/\s*\|\s*Letterboxd\s*$/i, '')
      .trim()
  }
  const h1 = html.match(/<h1[^>]*class="[^"]*headline[^"]*"[^>]*>([^<]+)</i)
  if (h1) return h1[1].trim()
  return 'Unknown'
}

function pathSlugFromFilmUrl(filmPageUrl: string): string {
  const u = new URL(filmPageUrl)
  return u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname
}

function parseFilmFromPageHtml(html: string, filmPageUrl: string): LetterboxdFilm | null {
  const posterMatch = html.match(/data-postered-identifier="([^"]+)"/)
  if (posterMatch) {
    try {
      const decoded = posterMatch[1].replace(/&quot;/g, '"')
      const parsed = JSON.parse(decoded) as { uid?: string }
      if (parsed.uid) {
        return {
          title: extractTitle(html),
          url: filmPageUrl,
          slug: pathSlugFromFilmUrl(filmPageUrl),
          uid: parsed.uid,
        }
      }
    } catch {
      /* fall through */
    }
  }

  const uidMatch = html.match(/data-item-uid="([^"]+)"/)
  if (uidMatch) {
    let uid = uidMatch[1]
    if (!uid.includes(':') && /^\d+$/.test(uid)) uid = `film:${uid}`
    return {
      title: extractTitle(html),
      url: filmPageUrl,
      slug: pathSlugFromFilmUrl(filmPageUrl),
      uid,
    }
  }

  return null
}

/**
 * Letterboxd client: fetch-based login + HTTP diary entry (Vercel/Node compatible).
 */
export class LetterboxdScraper {
  private jar = new Map<string, string>()
  private csrfToken: string | null = null
  private isLoggedIn = false
  private onSessionCookies?: CreateLetterboxdSessionOptions['onSessionCookies']

  /**
   * Establish Letterboxd session (stored cookies, fetch login, or browser fallback).
   */
  async init(username: string, password: string, options: CreateLetterboxdSessionOptions = {}): Promise<void> {
    this.onSessionCookies = options.onSessionCookies

    if (!options.forceFreshLogin && options.storedCookies?.length) {
      this.loadStoredCookies(options.storedCookies)
      if (await this.validateSession()) {
        this.isLoggedIn = true
        this.csrfToken = this.jar.get('com.xk72.webparts.csrf') ?? null
        return
      }
      // Stale cookies — discard and full login
      this.jar.clear()
      this.csrfToken = null
    }

    const ok = await this.loginWithRetry(username, password, 3)
    if (!ok) {
      throw new Error('Failed to login to Letterboxd after multiple attempts')
    }
  }

  private loadStoredCookies(cookies: LetterboxdSessionCookie[]): void {
    this.jar.clear()
    for (const c of cookies) {
      this.jar.set(c.name, c.value)
    }
    this.csrfToken = this.jar.get('com.xk72.webparts.csrf') ?? null
  }

  private async rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('User-Agent', CHROME_USER_AGENT)
    headers.set('Accept-Language', 'en-US,en;q=0.9')
    const ch = buildCookieHeader(this.jar)
    if (ch) headers.set('Cookie', ch)
    return fetch(url, { ...init, headers })
  }

  /**
   * Check session without assuming stored "username" is the public profile slug
   * (users may log in with email). /settings/ redirects to sign-in when unauthenticated.
   */
  private async validateSession(): Promise<boolean> {
    const res = await this.rawFetch('https://letterboxd.com/settings/', {
      redirect: 'follow',
    })
    mergeResponseCookies(res, this.jar)
    const html = await res.text()
    if (!res.ok) return false
    if (isCloudflareChallenge(html, res.status, res.headers)) return false
    const url = res.url
    if (url.includes('/sign-in')) return false
    const looksAuthed =
      /sign\s*out/i.test(html) ||
      /\/sign-out\/?/i.test(html) ||
      /href="[^"]*sign-out/i.test(html)
    const looksLikeLoginForm = html.includes('name="password"') && html.includes('name="username"')
    return looksAuthed && !looksLikeLoginForm
  }

  private async loginWithRetry(username: string, password: string, maxAttempts: number): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const success = await this.loginOnce(username, password)
      if (success) {
        this.isLoggedIn = true
        this.csrfToken = this.jar.get('com.xk72.webparts.csrf') ?? null
        if (this.onSessionCookies) {
          await this.onSessionCookies(sessionCookiesFromJar(this.jar))
        }
        return true
      }
      if (attempt < maxAttempts) {
        await delay(Math.pow(2, attempt) * 1000)
        this.jar.clear()
      }
    }
    return false
  }

  private async loginOnce(username: string, password: string): Promise<boolean> {
    const res1 = await this.rawFetch('https://letterboxd.com/sign-in/', { redirect: 'follow' })
    mergeResponseCookies(res1, this.jar)
    const html1 = await res1.text()
    if (isCloudflareChallenge(html1, res1.status, res1.headers)) {
      return this.browserFallbackLogin(username, password)
    }

    const csrf = this.jar.get('com.xk72.webparts.csrf')
    if (!csrf) {
      console.error('Letterboxd: missing CSRF cookie after sign-in GET')
      return false
    }

    const res2 = await this.rawFetch('https://letterboxd.com/user/login.do', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Origin: 'https://letterboxd.com',
        Referer: 'https://letterboxd.com/sign-in/',
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
      },
      body: new URLSearchParams({
        __csrf: csrf,
        username,
        password,
        remember: 'true',
      }).toString(),
    })
    mergeResponseCookies(res2, this.jar)
    const text = await res2.text()

    if (isCloudflareChallenge(text, res2.status, res2.headers)) {
      return this.browserFallbackLogin(username, password)
    }

    const json = tryParseJson(text)
    if (isLoginJsonFailure(json)) {
      console.error('Letterboxd login rejected:', json?.message?.trim() || text.slice(0, 500))
      return false
    }
    if (isLoginJsonSuccess(json)) {
      if (json?.csrf) {
        this.jar.set('com.xk72.webparts.csrf', json.csrf)
      }
      return this.validateSession()
    }

    console.error('Letterboxd login unexpected response:', text.slice(0, 500))
    return false
  }

  private async browserFallbackLogin(username: string, password: string): Promise<boolean> {
    const remote = await letterboxdLoginViaBrowserRendering(username, password)
    if (!remote?.length) {
      console.error(
        'Letterboxd: browser worker did not return session cookies (check preceding "Letterboxd browser rendering" log — wrong password, profile check, CF challenge, or worker error).'
      )
      return false
    }
    this.jar.clear()
    for (const c of remote) {
      this.jar.set(c.name, c.value)
    }
    this.csrfToken = this.jar.get('com.xk72.webparts.csrf') ?? null
    return this.validateSession()
  }

  private getCookieString(): string {
    return buildCookieHeader(this.jar)
  }

  private extractExternalIds(plexEvent: PlexWebhookEvent): { imdb?: string; tmdb?: string } {
    const guids = plexEvent.Metadata.Guid || []
    const ids: { imdb?: string; tmdb?: string } = {}
    for (const guid of guids) {
      if (guid.id.startsWith('imdb://')) {
        ids.imdb = guid.id.replace('imdb://', '')
      } else if (guid.id.startsWith('tmdb://')) {
        ids.tmdb = guid.id.replace('tmdb://', '')
      }
    }
    return ids
  }

  private async searchByExternalId(provider: 'imdb' | 'tmdb', id: string): Promise<LetterboxdFilm | null> {
    const path = provider === 'imdb' ? `imdb/${id}` : `tmdb/${id}`
    const res = await this.rawFetch(`https://letterboxd.com/${path}/`, { redirect: 'follow' })
    mergeResponseCookies(res, this.jar)
    const html = await res.text()
    if (!res.ok || isCloudflareChallenge(html, res.status, res.headers)) {
      return null
    }
    return parseFilmFromPageHtml(html, res.url)
  }

  async searchFilm(
    title: string,
    year?: number,
    _director?: string,
    externalIds?: { imdb?: string; tmdb?: string }
  ): Promise<LetterboxdFilm | null> {
    if (externalIds?.imdb) {
      const r = await this.searchByExternalId('imdb', externalIds.imdb)
      if (r) return r
    }
    if (externalIds?.tmdb) {
      const r = await this.searchByExternalId('tmdb', externalIds.tmdb)
      if (r) return r
    }

    const q = encodeURIComponent(title)
    const res = await this.rawFetch(`https://letterboxd.com/search/films/${q}/`, { redirect: 'follow' })
    mergeResponseCookies(res, this.jar)
    const html = await res.text()
    if (!res.ok || isCloudflareChallenge(html, res.status, res.headers)) {
      return null
    }

    const slugMatch = html.match(/class="[^"]*react-component[^"]*figure[^"]*"[^>]*data-item-slug="([^"]+)"/)
    const linkMatch = html.match(/data-item-link="([^"]+)"/) ?? html.match(/data-film-link="([^"]+)"/)
    const nameMatch = html.match(/data-item-name="([^"]+)"/) ?? html.match(/data-film-name="([^"]+)"/)
    const uidFromPoster = html.match(/data-postered-identifier="([^"]+)"/)

    if (uidFromPoster) {
      try {
        const decoded = uidFromPoster[1].replace(/&quot;/g, '"')
        const parsed = JSON.parse(decoded) as { uid?: string }
        if (parsed.uid && linkMatch) {
          const filmUrl = `https://letterboxd.com${linkMatch[1]}`
          return {
            title: nameMatch?.[1] ?? title,
            url: filmUrl,
            slug: linkMatch[1],
            uid: parsed.uid,
          }
        }
      } catch {
        /* fall through */
      }
    }

    if (slugMatch && linkMatch) {
      const filmPath = linkMatch[1]
      const filmUrl = `https://letterboxd.com${filmPath}`
      const filmPage = await this.rawFetch(`${filmUrl}`, { redirect: 'follow' })
      mergeResponseCookies(filmPage, this.jar)
      const pageHtml = await filmPage.text()
      const film = parseFilmFromPageHtml(pageHtml, filmPage.url)
      if (film) return film
    }

    if (year) {
      const re = new RegExp(`data-item-name="([^"]*${escapeRegex(title)}[^"]*${year}[^"]*)"`, 'i')
      const m = html.match(re)
      if (m && linkMatch) {
        const filmUrl = `https://letterboxd.com${linkMatch[1]}`
        const filmPage = await this.rawFetch(filmUrl, { redirect: 'follow' })
        const pageHtml = await filmPage.text()
        return parseFilmFromPageHtml(pageHtml, filmPage.url)
      }
    }

    return null
  }

  async markAsWatched(film: LetterboxdFilm, options: LetterboxdWatchOptions = {}): Promise<boolean> {
    if (!this.isLoggedIn) {
      throw new Error('Not logged in to Letterboxd')
    }
    if (!this.csrfToken) {
      throw new Error('No CSRF token available')
    }

    const { watchedDate, rating, review, tags } = options
    const now = new Date()
    const defaultDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

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
      viewingableUID: film.uid,
    })

    const response = await fetch('https://letterboxd.com/s/save-diary-entry', {
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        cookie: this.getCookieString(),
        dnt: '1',
        origin: 'https://letterboxd.com',
        referer: film.url,
        'user-agent': CHROME_USER_AGENT,
        'x-requested-with': 'XMLHttpRequest',
      },
      body: formData.toString(),
    })

    const responseText = await response.text()
    if (response.status === 401 || response.status === 403) {
      console.error('Diary entry unauthorized — session may have expired')
      return false
    }

    if (response.ok) {
      return true
    }
    console.error('HTTP request failed:', response.status, responseText.slice(0, 500))
    return false
  }

  async logFilmFromPlex(plexEvent: PlexWebhookEvent, webhookSettings?: WebhookSettings): Promise<ScrobbleResult> {
    const metadata = plexEvent.Metadata

    if (webhookSettings) {
      if (!webhookSettings.enabled) {
        return { success: false, reason: 'webhooks_disabled', message: 'Webhooks are disabled in settings' }
      }
      if (webhookSettings.onlyMovies && metadata.librarySectionType !== 'movie') {
        return {
          success: false,
          reason: 'non_movie',
          message: 'Movies-only filter enabled, skipping non-movie content',
        }
      }
      if (plexEvent.event === 'media.scrobble' && !webhookSettings.events.scrobble) {
        return { success: false, reason: 'event_disabled', message: 'Scrobble events are disabled in settings' }
      }
      if (plexEvent.event === 'media.rate' && !webhookSettings.events.rate) {
        return { success: false, reason: 'event_disabled', message: 'Rate events are disabled in settings' }
      }
    }

    if (metadata.librarySectionType !== 'movie') {
      return { success: false, reason: 'non_movie', message: 'Content is not a movie, skipping' }
    }

    const title = metadata.title
    const year = metadata.year
    const userRating = plexEvent.rating || metadata.userRating

    if (!this.isLoggedIn) {
      return {
        success: false,
        reason: 'login_failed',
        message: 'Not logged in to Letterboxd. Please log in first.',
        error: new Error('Login failed'),
      }
    }

    try {
      const externalIds = this.extractExternalIds(plexEvent)
      const film = await this.searchFilm(title, year, undefined, externalIds)
      if (!film) {
        return {
          success: false,
          reason: 'film_not_found',
          message: `Could not find film: ${title} (${year}) on Letterboxd`,
          error: new Error(`Film not found: ${title}`),
        }
      }

      let watchedDate: string
      if (metadata.lastViewedAt) {
        const watchedDateTime = new Date(metadata.lastViewedAt * 1000)
        watchedDate = `${watchedDateTime.getFullYear()}-${String(watchedDateTime.getMonth() + 1).padStart(2, '0')}-${String(watchedDateTime.getDate()).padStart(2, '0')}`
      } else {
        const n = new Date()
        watchedDate = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
      }

      const success = await this.markAsWatched(film, {
        watchedDate,
        rating: userRating,
        tags: 'plex',
      })

      if (success) {
        return { success: true, message: `Successfully logged ${title} to Letterboxd` }
      }
      return {
        success: false,
        reason: 'mark_failed',
        message: `Failed to mark ${title} as watched on Letterboxd`,
        error: new Error('Mark as watched failed'),
      }
    } catch (error) {
      return {
        success: false,
        reason: 'unknown_error',
        message: `Unexpected error processing ${title}`,
        error: error as Error,
      }
    }
  }

  /** No-op (kept for callers that used Puppeteer's close). */
  async close(): Promise<void> {
    this.isLoggedIn = false
  }
}

/**
 * Create an authenticated Letterboxd session (fetch-based).
 */
export async function createLetterboxdSession(
  username: string,
  password: string,
  options: CreateLetterboxdSessionOptions = {}
): Promise<LetterboxdScraper> {
  const scraper = new LetterboxdScraper()
  await scraper.init(username, password, options)
  return scraper
}
