import type { PlexWebhookEvent, LetterboxdFilm, LetterboxdWatchOptions, ScrobbleResult } from '../../types.js'
import type { LetterboxdSessionCookie, WebhookSettings } from './schema.js'
import { isPlexMovieMetadata } from './plex-metadata.js'
import { letterboxdLoginViaPuppeteer } from './letterboxd-puppeteer-login.js'
import {
  buildFilmSearchUrl,
  hasMinimalLetterboxdSession,
  isLetterboxdFilmPageHtml,
  parseFilmFromPageHtml,
  parseFilmsFromSearchHtml,
  pickBestSearchMatch,
  type LetterboxdFilmSearchHit,
} from './letterboxd-parse.js'

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
  const hasSignInForm = html.includes('name="username"') && html.includes('name="password"')
  if (status === 403 && (html.includes('cf-browser-verification') || /just a moment/i.test(html))) {
    return true
  }
  if (hasSignInForm) {
    return false
  }
  return (
    /just a moment/i.test(html) ||
    html.includes('cf-browser-verification') ||
    html.includes('challenge-platform')
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

type DiaryJson = { result?: string | boolean; message?: string; csrf?: string }

function isDiaryJsonSuccess(json: DiaryJson | null): boolean {
  if (!json) return false
  const r = json.result
  return r === true || r === 'success' || r === 'Success'
}

function isDiaryJsonFailure(json: DiaryJson | null): boolean {
  if (!json) return false
  const r = json.result
  return r === false || r === 'failure' || r === 'Failure'
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
        if (this.onSessionCookies) {
          await this.onSessionCookies(sessionCookiesFromJar(this.jar))
        }
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
    if (!hasMinimalLetterboxdSession(this.jar)) {
      return false
    }

    const res = await this.rawFetch('https://letterboxd.com/settings/', {
      redirect: 'follow',
    })
    mergeResponseCookies(res, this.jar)
    const html = await res.text()
    if (!res.ok) return false
    if (isCloudflareChallenge(html, res.status, res.headers)) {
      // Fetch often hits CF on serverless; trust cookies from a real browser login.
      return hasMinimalLetterboxdSession(this.jar)
    }
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

  /** True when login already established a usable cookie jar (skip redundant fetch/puppeteer). */
  private hasEstablishedSession(): boolean {
    return hasMinimalLetterboxdSession(this.jar)
  }

  private async loginOnce(username: string, password: string): Promise<boolean> {
    if (this.hasEstablishedSession()) {
      return true
    }

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
      if (this.hasEstablishedSession() || (await this.validateSession())) {
        return true
      }
      console.warn('Letterboxd: login JSON succeeded but fetch validation failed; trying browser fallback')
      return this.browserFallbackLogin(username, password)
    }

    console.error('Letterboxd login unexpected response:', text.slice(0, 500))
    return false
  }

  /**
   * POST login.do using cookies already in the jar (e.g. cf_clearance from Puppeteer).
   */
  private async postLoginWithJar(username: string, password: string): Promise<boolean> {
    const csrf = this.jar.get('com.xk72.webparts.csrf')
    if (!csrf) {
      return false
    }

    const res = await this.rawFetch('https://letterboxd.com/user/login.do', {
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
    mergeResponseCookies(res, this.jar)
    const text = await res.text()

    if (isCloudflareChallenge(text, res.status, res.headers)) {
      return false
    }

    const json = tryParseJson(text)
    if (isLoginJsonFailure(json)) {
      console.error('Letterboxd fetch login rejected:', json?.message?.trim() || text.slice(0, 300))
      return false
    }
    if (json?.csrf) {
      this.jar.set('com.xk72.webparts.csrf', json.csrf)
      this.csrfToken = json.csrf
    }
    return isLoginJsonSuccess(json) || this.hasEstablishedSession()
  }

  private async browserFallbackLogin(username: string, password: string): Promise<boolean> {
    const remote = await letterboxdLoginViaPuppeteer(username, password)
    if (!remote?.length) {
      console.error(
        'Letterboxd: puppeteer login did not return session cookies (wrong password, CF challenge, or Chromium launch failed on Vercel).'
      )
      return false
    }
    this.jar.clear()
    for (const c of remote) {
      this.jar.set(c.name, c.value)
    }
    this.csrfToken = this.jar.get('com.xk72.webparts.csrf') ?? null

    if (this.hasEstablishedSession()) {
      return true
    }

    // Puppeteer often yields cf_clearance + csrf only — complete login via fetch in Node.
    if (this.jar.has('cf_clearance')) {
      console.log('Letterboxd: completing login via fetch using Cloudflare cookies from browser…')
      if ((await this.postLoginWithJar(username, password)) && this.hasEstablishedSession()) {
        return true
      }
    }

    if (await this.validateSession()) {
      return true
    }

    console.error('Letterboxd: puppeteer returned cookies but no authenticated session signals')
    return false
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
    if (!isLetterboxdFilmPageHtml(html)) {
      return null
    }
    return parseFilmFromPageHtml(html, res.url)
  }

  private async fetchSearchResultsHtml(title: string): Promise<string | null> {
    const urls = [
      buildFilmSearchUrl(title),
      `https://letterboxd.com/search/films/${encodeURIComponent(title)}/`,
    ]

    for (const url of urls) {
      const res = await this.rawFetch(url, { redirect: 'follow' })
      mergeResponseCookies(res, this.jar)
      const html = await res.text()
      if (res.ok && !isCloudflareChallenge(html, res.status, res.headers)) {
        return html
      }
    }
    return null
  }

  private async resolveSearchHit(hit: LetterboxdFilmSearchHit): Promise<LetterboxdFilm | null> {
    if (hit.uid) {
      return { title: hit.title, url: hit.url, slug: hit.slug, uid: hit.uid }
    }

    const res = await this.rawFetch(hit.url, { redirect: 'follow' })
    mergeResponseCookies(res, this.jar)
    const html = await res.text()
    if (!res.ok || isCloudflareChallenge(html, res.status, res.headers)) {
      return null
    }
    if (!isLetterboxdFilmPageHtml(html)) {
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

    const html = await this.fetchSearchResultsHtml(title)
    if (!html) {
      return null
    }

    const searchHits = parseFilmsFromSearchHtml(html)
    if (searchHits.length > 0) {
      const best = pickBestSearchMatch(searchHits, title, year)
      return this.resolveSearchHit(best)
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

    const response = await this.rawFetch('https://letterboxd.com/s/save-diary-entry', {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: 'https://letterboxd.com',
        Referer: film.url,
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
      },
      body: formData.toString(),
    })

    const responseText = await response.text()
    if (response.status === 401 || response.status === 403) {
      console.error('Diary entry unauthorized — session may have expired')
      return false
    }

    if (isCloudflareChallenge(responseText, response.status, response.headers)) {
      console.error('Diary entry blocked by Cloudflare challenge')
      return false
    }

    const json = tryParseJson(responseText) as DiaryJson | null
    if (isDiaryJsonFailure(json)) {
      console.error('Diary entry rejected:', json?.message?.trim() || responseText.slice(0, 500))
      return false
    }
    if (json?.csrf) {
      this.jar.set('com.xk72.webparts.csrf', json.csrf)
      this.csrfToken = json.csrf
    }
    if (isDiaryJsonSuccess(json)) {
      if (this.onSessionCookies) {
        await this.onSessionCookies(sessionCookiesFromJar(this.jar))
      }
      return true
    }

    if (response.ok) {
      if (this.onSessionCookies) {
        await this.onSessionCookies(sessionCookiesFromJar(this.jar))
      }
      return true
    }
    console.error('HTTP request failed:', response.status, responseText.slice(0, 500))
    return false
  }

  async logFilmFromPlex(plexEvent: PlexWebhookEvent, webhookSettings?: WebhookSettings): Promise<ScrobbleResult> {
    const metadata = plexEvent.Metadata

    if (!isPlexMovieMetadata(metadata)) {
      return {
        success: false,
        reason: 'non_movie',
        message: 'Content is not a movie, skipping',
      }
    }

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
    /* session is request-scoped; do not clear isLoggedIn before callers finish */
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
