import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'
import { Form, redirect, Link } from 'react-router'
import { validateUserSession } from '../lib/plex-session.js'
import { updateUser } from '../lib/database.js'
import { encryptPassword, getUserPassword } from '../lib/password.js'
import { createLetterboxdSession } from '../lib/letterboxd-scraper.js'

export function meta() {
  return [{ title: 'Letterboxd Settings - Plex Letterboxd Scrobbler' }]
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { user, headers } = await validateUserSession(request)

  if (!user) {
    if (headers) {
      return redirect('/?error=session_expired', { headers })
    }
    return redirect('/?error=not_logged_in')
  }

  const url = new URL(request.url)
  const success = url.searchParams.get('success')
  const error = url.searchParams.get('error')
  const test = url.searchParams.get('test')

  return { user, success, error, test }
}

export async function action({ request }: ActionFunctionArgs) {
  const { user, headers } = await validateUserSession(request)

  if (!user) {
    if (headers) {
      return redirect('/?error=session_expired', { headers })
    }
    return redirect('/?error=not_logged_in')
  }

  const formData = await request.formData()
  const intent = formData.get('intent')?.toString()

  if (intent === 'test_login') {
    const password = getUserPassword(user)
    if (!user.letterboxdUsername || !password) {
      return redirect('/letterboxd?error=test_no_credentials')
    }
    try {
      const scraper = await createLetterboxdSession(user.letterboxdUsername, password, {
        forceFreshLogin: true,
        onSessionCookies: async (cookies) => {
          await updateUser(user.id, { letterboxdSessionCookies: cookies })
        },
      })
      await scraper.close()
      return redirect('/letterboxd?test=success')
    } catch (loginErr) {
      console.error('Letterboxd test login failed:', loginErr)
      return redirect('/letterboxd?error=test_login_failed')
    }
  }

  const username = formData.get('username') as string
  const password = formData.get('password') as string

  if (!username || !password) {
    return redirect('/letterboxd?error=missing_credentials')
  }

  try {
    const encryptedPassword = encryptPassword(password)

    await updateUser(user.id, {
      letterboxdUsername: username,
      letterboxdPasswordHash: encryptedPassword.encrypted,
      letterboxdPasswordSalt: encryptedPassword.iv,
      letterboxdSessionCookies: null,
    })

    try {
      const scraper = await createLetterboxdSession(username, password, {
        onSessionCookies: async (cookies) => {
          await updateUser(user.id, { letterboxdSessionCookies: cookies })
        },
      })
      await scraper.close()
    } catch (loginErr) {
      console.error('Letterboxd login verification failed:', loginErr)
      return redirect('/letterboxd?error=letterboxd_login_failed')
    }

    return redirect('/?success=letterboxd_connected')
  } catch (error) {
    console.error('Error saving Letterboxd credentials:', error)
    return redirect('/letterboxd?error=save_failed')
  }
}

export default function Letterboxd({
  loaderData,
}: {
  loaderData: { user: any; success: string | null; error: string | null; test: string | null }
}) {
  const { user, success, error, test } = loaderData
  const isConnected = Boolean(user.letterboxdUsername && user.letterboxdPasswordHash)

  return (
    <div className='app-container'>
      <div className='content-wrapper'>
        <div className='retro-card p-8 text-center'>
          <h1 className='hero-title gradient-text'>📽️ LETTERBOXD SETTINGS</h1>
          <p className='mx-auto max-w-md text-lg text-gray-600'>
            {isConnected
              ? 'Manage your Letterboxd connection'
              : 'Connect your Letterboxd account for automatic logging'}
          </p>
          {isConnected && (
            <div className='mt-4 inline-flex items-center gap-2 rounded border-2 border-emerald-600 bg-emerald-100 px-4 py-2'>
              <span className='font-bold text-emerald-800'>✓ CONNECTED</span>
            </div>
          )}
        </div>

        <div className='section-spacing'>
          {test === 'success' && (
            <div className='retro-alert border-emerald-600 bg-emerald-100 p-4 text-emerald-800'>
              <p className='text-center font-bold'>✓ Letterboxd login test succeeded — session refreshed.</p>
            </div>
          )}

          {success && (
            <div className='retro-alert border-emerald-600 bg-emerald-100 p-4 text-emerald-800'>
              <p className='text-center font-bold'>
                ✓ {success === 'credentials_saved' ? 'Letterboxd credentials saved successfully!' : 'Success!'}
              </p>
            </div>
          )}

          {error && (
            <div className='retro-alert border-red-600 bg-red-100 p-4 text-red-800'>
              <p className='text-center font-bold'>
                ⚠{' '}
                {error === 'missing_credentials'
                  ? 'Please fill in both username and password'
                  : error === 'save_failed'
                    ? 'Failed to save credentials'
                    : error === 'letterboxd_login_failed'
                      ? 'Letterboxd login failed — check username/password'
                      : error === 'test_login_failed'
                        ? 'Login test failed — check credentials or browser-rendering Worker'
                        : error === 'test_no_credentials'
                          ? 'Save Letterboxd credentials before running a login test'
                          : 'Error occurred'}
              </p>
            </div>
          )}
        </div>

        <div className='retro-card p-8'>
          {isConnected && (
            <div className='retro-alert mb-8 border-emerald-600 bg-emerald-100 p-6 text-emerald-800'>
              <div className='text-center'>
                <p className='mb-2 text-xl font-bold'>🎬 LETTERBOXD CONNECTED</p>
                <p className='text-lg'>
                  Username: <span className='font-mono'>{user.letterboxdUsername}</span>
                </p>
                <p className='mt-2 text-sm opacity-75'>Update your credentials below if needed</p>
              </div>
            </div>
          )}

          <Form method='post' className='section-spacing'>
            <div>
              <label className='gradient-text mb-3 block text-lg font-bold' htmlFor='username'>
                LETTERBOXD USERNAME
              </label>
              <input
                type='text'
                id='username'
                name='username'
                defaultValue={user.letterboxdUsername || ''}
                className='retro-input w-full p-4 text-lg'
                placeholder='your_letterboxd_username'
                required
              />
            </div>

            <div>
              <label className='gradient-text mb-3 block text-lg font-bold' htmlFor='password'>
                LETTERBOXD PASSWORD
              </label>
              <input
                type='password'
                id='password'
                name='password'
                className='retro-input w-full p-4 text-lg'
                placeholder={isConnected ? 'Enter new password to update' : 'your_letterboxd_password'}
                required
              />
            </div>

            <button
              type='submit'
              className='retro-button w-full bg-gradient-to-r from-emerald-400 to-emerald-500 p-6 text-xl text-black hover:from-emerald-300 hover:to-emerald-400'
            >
              💾 {isConnected ? 'UPDATE CREDENTIALS' : 'SAVE CREDENTIALS'}
            </button>
          </Form>

          {isConnected && (
            <Form method='post' className='mt-6'>
              <input type='hidden' name='intent' value='test_login' />
              <button
                type='submit'
                className='retro-button w-full border-2 border-amber-600 bg-amber-100 p-4 text-lg font-bold text-amber-950 hover:bg-amber-200'
              >
                🧪 TEST LETTERBOXD LOGIN
              </button>
              <p className='mt-2 text-center text-sm text-gray-600'>
                Runs a fresh login with your saved credentials and updates stored session cookies.
              </p>
            </Form>
          )}
        </div>

        <div className='retro-card bg-gradient-to-br from-amber-50 to-amber-100 p-6'>
          <h3 className='gradient-text mb-3 text-center text-lg font-bold'>🔒 SECURITY NOTE</h3>
          <p className='mx-auto max-w-lg text-center leading-relaxed text-gray-700'>
            Your credentials are encrypted and stored securely. They're only used to log movies to your Letterboxd
            account and are never shared with third parties.
          </p>
        </div>

        <div className='text-center'>
          <Link
            to='/'
            className='retro-button inline-block bg-gradient-to-r from-gray-300 to-gray-400 px-8 py-4 text-black no-underline hover:from-gray-200 hover:to-gray-300'
          >
            ← BACK TO HOME
          </Link>
        </div>
      </div>
    </div>
  )
}
