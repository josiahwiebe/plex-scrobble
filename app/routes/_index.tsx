import { Link } from 'react-router'
import type { LoaderFunctionArgs } from 'react-router'
import { validateUserSession } from '../lib/plex-session.js'

export function meta() {
  return [{ title: 'Plex Letterboxd Scrobbler' }, { name: 'description', content: 'Connect your Plex to Letterboxd' }]
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { user, headers } = await validateUserSession(request)
  const url = new URL(request.url)
  const success = url.searchParams.get('success')
  const error = url.searchParams.get('error')

  return { user, success, error, headers }
}

export default function Home({
  loaderData,
}: {
  loaderData: { user: any; success: string | null; error: string | null }
}) {
  const { user, success, error } = loaderData

  return (
    <div className='app-container'>
      <div className='content-wrapper'>
        {/* Hero Section */}
        <div className='retro-card p-8 text-center'>
          <h1 className='hero-title gradient-text'>PLEX → LETTERBOXD</h1>
          <p className='mx-auto max-w-md text-lg text-gray-600'>
            Automatically sync your Plex movie watches to Letterboxd
          </p>
        </div>

        {/* Alert Messages */}
        <div className='section-spacing'>
          {success && (
            <div className='retro-alert border-emerald-600 bg-emerald-100 p-4 text-emerald-800'>
              <p className='text-center font-bold'>
                ✓ {success === 'plex_connected' ? 'Plex account connected successfully!' : 'Success!'}
              </p>
            </div>
          )}

          {error && (
            <div className='retro-alert border-red-600 bg-red-100 p-4 text-red-800'>
              <p className='text-center font-bold'>
                ⚠{' '}
                {error === 'missing_code'
                  ? 'Missing authorization code'
                  : error === 'auth_failed'
                    ? 'Authentication failed'
                    : 'Error occurred'}
              </p>
            </div>
          )}

          {user && (
            <div className='retro-alert border-blue-600 bg-blue-100 p-4 text-blue-800'>
              <div className='text-center'>
                <p className='font-bold'>👤 Logged in as: {user.plexUsername}</p>
                <p className='text-sm opacity-75'>Plex ID: {user.plexId}</p>
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className='retro-card p-8'>
          <div className='section-spacing'>
            {!user?.plexId && (
              <Link
                to='/auth/plex'
                className='retro-button block w-full bg-gradient-to-r from-orange-400 to-orange-500 p-6 text-center text-xl text-black no-underline hover:from-orange-300 hover:to-orange-400'
              >
                🎬 CONNECT PLEX ACCOUNT
              </Link>
            )}

            {user?.plexId && !user?.letterboxdUsername && (
              <Link
                to='/letterboxd'
                className='retro-button block w-full bg-gradient-to-r from-emerald-400 to-emerald-500 p-6 text-center text-xl text-black no-underline hover:from-emerald-300 hover:to-emerald-400'
              >
                📽️ CONNECT LETTERBOXD
              </Link>
            )}

            {user?.plexId && user?.letterboxdUsername && (
              <div className='space-y-4'>
                <div className='retro-alert border-emerald-600 bg-emerald-200 p-6 text-center text-emerald-800'>
                  <p className='mb-2 text-2xl font-bold'>🎉 ALL CONNECTED</p>
                  <p className='text-lg'>Your Plex watches will now sync to Letterboxd</p>
                </div>
                <div className='button-grid'>
                  <Link
                    to='/webhook-settings'
                    className='retro-button block w-full bg-gradient-to-r from-blue-400 to-blue-500 p-4 text-center text-lg text-black no-underline hover:from-blue-300 hover:to-blue-400'
                  >
                    ⚙️ WEBHOOK SETTINGS
                  </Link>
                  <Link
                    to='/letterboxd'
                    className='retro-button block w-full bg-gradient-to-r from-emerald-400 to-emerald-500 p-4 text-center text-lg text-black no-underline hover:from-emerald-300 hover:to-emerald-400'
                  >
                    📽️ UPDATE LETTERBOXD
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* How It Works */}
        <div className='retro-card bg-gradient-to-br from-yellow-50 to-yellow-100 p-8'>
          <h2 className='gradient-text mb-6 text-center text-2xl font-bold'>HOW IT WORKS</h2>
          <div className='button-grid'>
            <div className='flex items-center space-x-4 p-4'>
              <span className='retro-button flex h-10 w-10 flex-shrink-0 items-center justify-center bg-blue-400 text-lg font-bold'>
                1
              </span>
              <span className='text-gray-700'>Connect your Plex account</span>
            </div>
            <div className='flex items-center space-x-4 p-4'>
              <span className='retro-button flex h-10 w-10 flex-shrink-0 items-center justify-center bg-green-400 text-lg font-bold'>
                2
              </span>
              <span className='text-gray-700'>Add Letterboxd credentials</span>
            </div>
            <div className='flex items-center space-x-4 p-4'>
              <span className='retro-button flex h-10 w-10 flex-shrink-0 items-center justify-center bg-purple-400 text-lg font-bold'>
                3
              </span>
              <span className='text-gray-700'>Watch movies on Plex</span>
            </div>
            <div className='flex items-center space-x-4 p-4'>
              <span className='retro-button flex h-10 w-10 flex-shrink-0 items-center justify-center bg-orange-400 text-lg font-bold'>
                4
              </span>
              <span className='text-gray-700'>Auto-sync to Letterboxd</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
