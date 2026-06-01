import type { LetterboxdFilm } from '../../types.js'

/** Search hit with optional release year; uid may be filled after a film-page fetch. */
export interface LetterboxdFilmSearchHit {
  title: string
  url: string
  slug: string
  uid?: string
  year?: number
}

const MOVIE_TITLE_YEAR_PATTERN = /^(.+?)(?:\s*\((\d{4})\))?$/

const FIGURE_COMPONENT_REGEX =
  /<div[^>]*class="[^"]*react-component[^"]*figure[^"]*"[^>]*>/gi

const USER_COOKIE = 'letterboxd.signed.in.as'

export { USER_COOKIE }

/**
 * Split a Letterboxd display name like "The Matrix (1999)" into title and year.
 */
export function extractNameYearFromMovieTitle(movieName: string): { title: string; year?: number } {
  const match = MOVIE_TITLE_YEAR_PATTERN.exec(movieName.trim())
  if (!match) {
    return { title: movieName.trim() }
  }
  const title = match[1].trim()
  const year = match[2] ? Number.parseInt(match[2], 10) : undefined
  return { title, year }
}

/**
 * True when HTML looks like a Letterboxd film page (not a 404, person, or list).
 */
export function isLetterboxdFilmPageHtml(html: string): boolean {
  const ogType = html.match(/property="og:type"\s+content="([^"]+)"/i)?.[1]
  if (ogType === 'video.movie') {
    return true
  }
  return (
    /class="[^"]*filmtitle[^"]*"/i.test(html) &&
    (html.includes('data-postered-identifier') || html.includes('data-item-uid'))
  )
}

function attrFromTag(tag: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, 'i')
  return tag.match(re)?.[1] ?? null
}

function uidFromPosteredIdentifier(raw: string | null): string | null {
  if (!raw) return null
  try {
    const decoded = raw.replace(/&quot;/g, '"')
    const parsed = JSON.parse(decoded) as { uid?: string }
    return parsed.uid ?? null
  } catch {
    return null
  }
}

function normalizeFilmPath(linkOrSlug: string): string {
  if (linkOrSlug.startsWith('/')) {
    return linkOrSlug
  }
  return `/film/${linkOrSlug}/`
}

function hitFromFigureTag(tag: string): LetterboxdFilmSearchHit | null {
  const slug = attrFromTag(tag, 'data-item-slug')
  const rawName = attrFromTag(tag, 'data-item-name') ?? attrFromTag(tag, 'data-film-name')
  const link =
    attrFromTag(tag, 'data-target-link') ??
    attrFromTag(tag, 'data-item-link') ??
    attrFromTag(tag, 'data-film-link') ??
    (slug ? normalizeFilmPath(slug) : null)

  if (!rawName || !link) {
    return null
  }

  const { title, year } = extractNameYearFromMovieTitle(rawName)
  const uid = uidFromPosteredIdentifier(attrFromTag(tag, 'data-postered-identifier')) ?? undefined
  const path = normalizeFilmPath(link)

  return {
    title,
    year,
    url: `https://letterboxd.com${path}`,
    slug: path,
    uid,
  }
}

/** Legacy path: poster JSON near link/name attrs in search result chunks. */
function parseFilmsFromSearchHtmlLegacy(html: string): LetterboxdFilmSearchHit[] {
  const results: LetterboxdFilmSearchHit[] = []
  const chunkRegex =
    /data-postered-identifier="([^"]+)"[\s\S]{0,1200}?(?:data-item-link|data-film-link|data-target-link)="([^"]+)"[\s\S]{0,400}?(?:data-item-name|data-film-name)="([^"]+)"/gi

  for (const match of html.matchAll(chunkRegex)) {
    const uid = uidFromPosteredIdentifier(match[1])
    if (!uid) continue
    const link = match[2]
    const { title, year } = extractNameYearFromMovieTitle(match[3])
    const path = normalizeFilmPath(link)
    results.push({
      title,
      year,
      url: `https://letterboxd.com${path}`,
      slug: path,
      uid,
    })
  }
  return results
}

/**
 * Parse film hits from Letterboxd search results HTML.
 * Prefers react-component figure attrs; falls back to poster-identifier chunks.
 */
export function parseFilmsFromSearchHtml(html: string): LetterboxdFilmSearchHit[] {
  const byKey = new Map<string, LetterboxdFilmSearchHit>()

  const add = (hit: LetterboxdFilmSearchHit | null) => {
    if (!hit) return
    const key = hit.slug
    const existing = byKey.get(key)
    if (!existing || (!existing.uid && hit.uid)) {
      byKey.set(key, hit)
    }
  }

  for (const match of html.matchAll(FIGURE_COMPONENT_REGEX)) {
    add(hitFromFigureTag(match[0]))
  }

  for (const hit of parseFilmsFromSearchHtmlLegacy(html)) {
    add(hit)
  }

  return [...byKey.values()]
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pick the best search result for a Plex title/year.
 */
export function pickBestSearchMatch(
  films: LetterboxdFilmSearchHit[],
  title: string,
  year?: number
): LetterboxdFilmSearchHit {
  if (films.length === 0) {
    throw new Error('pickBestSearchMatch requires at least one film')
  }
  if (films.length === 1) {
    return films[0]
  }

  const normQuery = normalizeTitle(title)
  let best = films[0]
  let bestScore = -1

  for (const film of films) {
    const normTitle = normalizeTitle(film.title)
    let score = 0

    if (normTitle === normQuery) {
      score += 100
    } else if (normTitle.includes(normQuery) || normQuery.includes(normTitle)) {
      score += 50
    }

    if (year !== undefined && film.year === year) {
      score += 40
    } else if (year !== undefined && film.year !== undefined && Math.abs(film.year - year) <= 1) {
      score += 10
    }

    if (score > bestScore) {
      bestScore = score
      best = film
    }
  }

  return best
}

export function buildFilmSearchUrl(title: string): string {
  return `https://letterboxd.com/s/search/films/${encodeURIComponent(title)}/`
}

function extractTitle(html: string): string {
  const og = html.match(/property="og:title"\s+content="([^"]+)"/)
  if (og) {
    return og[1]
      .replace(/\s*\(\d{4}\)\s*\|\s*Letterboxd\s*$/i, '')
      .replace(/\s*\|\s*Letterboxd\s*$/i, '')
      .trim()
  }
  const h1 = html.match(/<h1[^>]*class="[^"]*primaryname[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)</i)
  if (h1) return h1[1].trim()
  const filmtitle = html.match(/<h1[^>]*class="[^"]*filmtitle[^"]*"[^>]*>([^<]+)</i)
  if (filmtitle) return filmtitle[1].trim()
  return 'Unknown'
}

function pathSlugFromFilmUrl(filmPageUrl: string): string {
  const u = new URL(filmPageUrl)
  return u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname
}

function extractUidFromReportUrl(html: string): string | null {
  const m = html.match(/data-report-url="[^"]*\/report\/(\d+)\/?"/i)
  return m ? `film:${m[1]}` : null
}

/**
 * Parse film uid/title from a Letterboxd film page HTML.
 */
export function parseFilmFromPageHtml(html: string, filmPageUrl: string): LetterboxdFilm | null {
  const uidFromPoster = uidFromPosteredIdentifier(
    html.match(/data-postered-identifier="([^"]+)"/)?.[1] ?? null
  )
  if (uidFromPoster) {
    return {
      title: extractTitle(html),
      url: filmPageUrl,
      slug: pathSlugFromFilmUrl(filmPageUrl),
      uid: uidFromPoster,
    }
  }

  const uidMatch = html.match(/data-item-uid="([^"]+)"/)
  if (uidMatch) {
    let uid = uidMatch[1]
    if (!uid.includes(':') && /^\d+$/.test(uid)) {
      uid = `film:${uid}`
    }
    return {
      title: extractTitle(html),
      url: filmPageUrl,
      slug: pathSlugFromFilmUrl(filmPageUrl),
      uid,
    }
  }

  const uidFromReport = extractUidFromReportUrl(html)
  if (uidFromReport) {
    return {
      title: extractTitle(html),
      url: filmPageUrl,
      slug: pathSlugFromFilmUrl(filmPageUrl),
      uid: uidFromReport,
    }
  }

  return null
}

/** True if the cookie jar has a local signed-in signal (avoids pointless /settings/ calls). */
export function hasLocalLetterboxdSessionSignals(jar: Map<string, string>): boolean {
  const signedIn = jar.get(USER_COOKIE)
  if (signedIn && signedIn.length > 0) {
    return true
  }
  for (const [name, value] of jar) {
    if (name.startsWith('letterboxd.user') && value.length > 0) {
      return true
    }
  }
  return false
}

/** CSRF + signed-in cookies — enough to trust a browser-established session without fetch /settings/. */
export function hasMinimalLetterboxdSession(jar: Map<string, string>): boolean {
  const csrf = jar.get('com.xk72.webparts.csrf')
  return Boolean(csrf && csrf.length > 0 && hasLocalLetterboxdSessionSignals(jar))
}
