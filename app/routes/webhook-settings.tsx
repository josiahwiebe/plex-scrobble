import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router'
import { Form, redirect, Link } from 'react-router'
import { validateUserSession } from '../lib/plex-session.js'
import { getUserById, updateUser, ensureUserHasWebhookToken } from '../lib/database.js'
import type { User, WebhookSettings } from '../lib/schema.js'

export function meta() {
  return [{ title: 'Webhook Settings - Plex Letterboxd Scrobbler' }]
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { user, headers } = await validateUserSession(request)

  if (!user) {
    if (headers) {
      return redirect('/?error=session_expired', { headers })
    }
    return redirect('/?error=not_logged_in')
  }

  const dbUser = await getUserById(user.id)
  if (!dbUser) {
    if (headers) {
      return redirect('/?error=session_expired', { headers })
    }
    return redirect('/?error=not_logged_in')
  }

  const url = new URL(request.url)
  const success = url.searchParams.get('success')
  const error = url.searchParams.get('error')

  const defaultSettings: WebhookSettings = {
    enabled: true,
    events: {
      scrobble: true,
      rate: true,
    },
    onlyMovies: true,
  }

  const webhookSettings = dbUser.webhookSettings || defaultSettings

  let webhookToken: string
  try {
    webhookToken = await ensureUserHasWebhookToken(dbUser.id)
  } catch (e) {
    console.error('ensureUserHasWebhookToken failed:', e)
    if (headers) {
      return redirect('/?error=webhook_load_failed', { headers })
    }
    return redirect('/?error=webhook_load_failed')
  }

  const origin = new URL(request.url).origin
  const webhookUrl = new URL(`/webhook/${webhookToken}`, origin).href

  return {
    user: dbUser,
    webhookSettings,
    webhookToken,
    webhookUrl,
    success,
    error,
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { user, headers } = await validateUserSession(request)

  if (!user) {
    if (headers) {
      return redirect('/?error=session_expired', { headers })
    }
    return redirect('/?error=not_logged_in')
  }

  const dbUser = await getUserById(user.id)
  if (!dbUser) {
    if (headers) {
      return redirect('/?error=session_expired', { headers })
    }
    return redirect('/?error=not_logged_in')
  }

  const formData = await request.formData()

  const webhookSettings: WebhookSettings = {
    enabled: formData.get('enabled') === 'on',
    events: {
      scrobble: formData.get('events.scrobble') === 'on',
      rate: formData.get('events.rate') === 'on',
    },
    onlyMovies: formData.get('onlyMovies') === 'on',
  }

  try {
    await updateUser(dbUser.id, { webhookSettings })

    console.log('Webhook settings updated for user:', dbUser.plexUsername)

    return redirect('/webhook-settings?success=settings_saved')
  } catch (error) {
    console.error('Error saving webhook settings:', error)
    return redirect('/webhook-settings?error=save_failed')
  }
}

export default function WebhookSettings({
  loaderData,
}: {
  loaderData: {
    user: User
    webhookSettings: WebhookSettings
    webhookToken: string
    webhookUrl: string
    success: string | null
    error: string | null
  }
}) {
  const { webhookSettings, webhookUrl, success, error } = loaderData

  return (
    <div className='app-container'>
      <div className='content-wrapper'>
        <div className='retro-card p-8 text-center'>
          <h1 className='hero-title gradient-text'>⚙️ WEBHOOK SETTINGS</h1>
          <p className='mx-auto max-w-md text-lg text-gray-600'>Configure which Plex events sync to Letterboxd</p>
        </div>

        <div className='section-spacing'>
          {success && (
            <div className='retro-alert border-emerald-600 bg-emerald-100 p-4 text-emerald-800'>
              <p className='text-center font-bold'>
                ✓ {success === 'settings_saved' ? 'Webhook settings saved successfully!' : 'Success!'}
              </p>
            </div>
          )}

          {error && (
            <div className='retro-alert border-red-600 bg-red-100 p-4 text-red-800'>
              <p className='text-center font-bold'>
                ⚠ {error === 'save_failed' ? 'Failed to save settings' : 'Error occurred'}
              </p>
            </div>
          )}
        </div>

        <div className='retro-card bg-gradient-to-br from-blue-50 to-blue-100 p-6'>
          <h3 className='gradient-text mb-3 text-center text-lg font-bold'>🔗 YOUR WEBHOOK URL</h3>
          <div className='retro-input bg-gray-100 p-4 text-center font-mono text-sm break-all'>{webhookUrl}</div>
          <p className='mt-3 text-center text-sm text-gray-600'>Add this URL to your Plex server's webhook settings</p>
        </div>

        <div className='retro-card p-8'>
          <Form method='post' className='section-spacing'>
            <div className='retro-card bg-gradient-to-br from-gray-50 to-gray-100 p-6'>
              <h3 className='gradient-text mb-4 text-lg font-bold'>🎯 WEBHOOK STATUS</h3>
              <label className='flex cursor-pointer items-center space-x-3'>
                <input
                  type='checkbox'
                  name='enabled'
                  defaultChecked={webhookSettings.enabled}
                  className='retro-input h-5 w-5'
                />
                <span className='text-lg'>Enable webhook processing</span>
              </label>
            </div>

            <div className='retro-card bg-gradient-to-br from-purple-50 to-purple-100 p-6'>
              <h3 className='gradient-text mb-4 text-lg font-bold'>🎬 SYNC EVENTS</h3>
              <div className='space-y-4'>
                <label className='flex cursor-pointer items-center space-x-3'>
                  <input
                    type='checkbox'
                    name='events.scrobble'
                    defaultChecked={webhookSettings.events.scrobble}
                    className='retro-input h-5 w-5'
                  />
                  <div>
                    <span className='text-lg font-bold'>Mark as Watched</span>
                    <p className='text-sm text-gray-600'>Sync when you finish watching a movie</p>
                  </div>
                </label>

                <label className='flex cursor-pointer items-center space-x-3'>
                  <input
                    type='checkbox'
                    name='events.rate'
                    defaultChecked={webhookSettings.events.rate}
                    className='retro-input h-5 w-5'
                  />
                  <div>
                    <span className='text-lg font-bold'>Ratings</span>
                    <p className='text-sm text-gray-600'>Sync when you rate a movie in Plex</p>
                  </div>
                </label>
              </div>
            </div>

            <div className='retro-card bg-gradient-to-br from-green-50 to-green-100 p-6'>
              <h3 className='gradient-text mb-4 text-lg font-bold'>🎭 CONTENT FILTERS</h3>
              <div className='space-y-4'>
                <label className='flex cursor-pointer items-center space-x-3'>
                  <input
                    type='checkbox'
                    name='onlyMovies'
                    defaultChecked={webhookSettings.onlyMovies}
                    className='retro-input h-5 w-5'
                  />
                  <div>
                    <span className='text-lg font-bold'>Movies Only</span>
                    <p className='text-sm text-gray-600'>Skip TV shows and only sync movies</p>
                  </div>
                </label>
              </div>
            </div>

            <button
              type='submit'
              className='retro-button w-full bg-gradient-to-r from-emerald-400 to-emerald-500 p-6 text-xl text-black hover:from-emerald-300 hover:to-emerald-400'
            >
              💾 SAVE WEBHOOK SETTINGS
            </button>
          </Form>
        </div>

        <div className='retro-card bg-gradient-to-br from-amber-50 to-amber-100 p-6'>
          <h3 className='gradient-text mb-3 text-center text-lg font-bold'>📋 PLEX SETUP INSTRUCTIONS</h3>
          <div className='space-y-3 text-gray-700'>
            <p>
              <strong>1.</strong> Open your Plex server settings
            </p>
            <p>
              <strong>2.</strong> Go to Settings → Network → Webhooks
            </p>
            <p>
              <strong>3.</strong> Add the webhook URL shown above
            </p>
            <p>
              <strong>4.</strong> Save and test by watching a movie!
            </p>
          </div>
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
