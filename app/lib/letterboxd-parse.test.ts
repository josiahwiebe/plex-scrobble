import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildFilmSearchUrl,
  extractNameYearFromMovieTitle,
  hasLocalLetterboxdSessionSignals,
  hasMinimalLetterboxdSession,
  isLetterboxdFilmPageHtml,
  parseFilmFromPageHtml,
  parseFilmsFromSearchHtml,
  pickBestSearchMatch,
} from './letterboxd-parse.js'

const fixturesDir = join(new URL('.', import.meta.url).pathname, '__fixtures__')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

describe('extractNameYearFromMovieTitle', () => {
  test('splits title and year', () => {
    expect(extractNameYearFromMovieTitle('V for Vendetta (2005)')).toEqual({
      title: 'V for Vendetta',
      year: 2005,
    })
  })

  test('returns title only when no year', () => {
    expect(extractNameYearFromMovieTitle('Inception')).toEqual({ title: 'Inception' })
  })
})

describe('parseFilmsFromSearchHtml', () => {
  test('parses react-component figure hits from fixture', () => {
    const html = loadFixture('letterboxd-search-snippet.html')
    const films = parseFilmsFromSearchHtml(html)

    expect(films).toHaveLength(2)
    expect(films[0]).toMatchObject({
      title: 'V for Vendetta',
      year: 2005,
      slug: '/film/v-for-vendetta/',
      uid: 'film:51400',
    })
  })
})

describe('pickBestSearchMatch', () => {
  const hits = parseFilmsFromSearchHtml(loadFixture('letterboxd-search-snippet.html'))

  test('prefers exact title and year', () => {
    const best = pickBestSearchMatch(hits, 'V for Vendetta', 2005)
    expect(best.slug).toBe('/film/v-for-vendetta/')
  })

  test('disambiguates same-year titles by name', () => {
    const best = pickBestSearchMatch(hits, 'Lady Vengeance', 2005)
    expect(best.slug).toBe('/film/lady-vengeance/')
  })
})

describe('parseFilmFromPageHtml', () => {
  test('extracts uid from poster and report url fallbacks', () => {
    const html = loadFixture('letterboxd-film-page-snippet.html')
    expect(isLetterboxdFilmPageHtml(html)).toBe(true)

    const film = parseFilmFromPageHtml(html, 'https://letterboxd.com/film/the-matrix/')
    expect(film).toMatchObject({
      title: 'The Matrix',
      uid: 'film:51798',
      slug: '/film/the-matrix',
    })
  })

  test('uses data-report-url when poster uid missing', () => {
    const html = loadFixture('letterboxd-film-page-snippet.html').replace(
      /data-postered-identifier="[^"]+"/,
      ''
    )
    const film = parseFilmFromPageHtml(html, 'https://letterboxd.com/film/the-matrix/')
    expect(film?.uid).toBe('film:51798')
  })
})

describe('session helpers', () => {
  test('hasLocalLetterboxdSessionSignals', () => {
    const jar = new Map<string, string>()
    expect(hasLocalLetterboxdSessionSignals(jar)).toBe(false)
    jar.set('letterboxd.signed.in.as', 'josiah')
    expect(hasLocalLetterboxdSessionSignals(jar)).toBe(true)
  })

  test('accepts letterboxd.user cookie', () => {
    const jar = new Map<string, string>([['letterboxd.user', 'abc123']])
    expect(hasLocalLetterboxdSessionSignals(jar)).toBe(true)
  })

  test('hasMinimalLetterboxdSession requires csrf and user', () => {
    const jar = new Map<string, string>()
    expect(hasMinimalLetterboxdSession(jar)).toBe(false)
    jar.set('com.xk72.webparts.csrf', 'token')
    expect(hasMinimalLetterboxdSession(jar)).toBe(false)
    jar.set('letterboxd.signed.in.as', 'josiah')
    expect(hasMinimalLetterboxdSession(jar)).toBe(true)
  })
})

describe('buildFilmSearchUrl', () => {
  test('uses /s/search/films path', () => {
    expect(buildFilmSearchUrl('V for Vendetta')).toBe(
      'https://letterboxd.com/s/search/films/V%20for%20Vendetta/'
    )
  })
})
