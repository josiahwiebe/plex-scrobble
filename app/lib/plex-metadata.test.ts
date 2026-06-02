import { describe, expect, test } from 'bun:test'
import { isPlexMovieMetadata } from './plex-metadata.js'

describe('isPlexMovieMetadata', () => {
  test('accepts movies', () => {
    expect(isPlexMovieMetadata({ type: 'movie', librarySectionType: 'movie' } as never)).toBe(true)
  })

  test('rejects episodes in a show library', () => {
    expect(
      isPlexMovieMetadata({ type: 'episode', librarySectionType: 'show' } as never)
    ).toBe(false)
  })
})
