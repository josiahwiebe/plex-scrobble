import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, Link } from "react-router";
import { validateUserSession } from "../lib/plex-session.js";
import { updateUser } from "../lib/database.js";
import { encryptPassword } from "../lib/password.js";

export function meta() {
  return [
    { title: "Letterboxd Settings - Plex Letterboxd Scrobbler" },
  ];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { user, headers } = await validateUserSession(request);

  if (!user) {
    if (headers) {
      return redirect('/?error=session_expired', { headers });
    }
    return redirect('/?error=not_logged_in');
  }

  const url = new URL(request.url);
  const success = url.searchParams.get('success');
  const error = url.searchParams.get('error');

  return { user, success, error };
}

export async function action({ request }: ActionFunctionArgs) {
  const { user, headers } = await validateUserSession(request);

  if (!user) {
    if (headers) {
      return redirect('/?error=session_expired', { headers });
    }
    return redirect('/?error=not_logged_in');
  }

  const formData = await request.formData();
  const username = formData.get('username') as string;
  const password = formData.get('password') as string;

  if (!username || !password) {
    return redirect('/letterboxd?error=missing_credentials');
  }

  try {
    const encryptedPassword = encryptPassword(password);

    await updateUser(user.id, {
      letterboxdUsername: username,
      letterboxdPasswordHash: encryptedPassword.encrypted,
      letterboxdPasswordSalt: encryptedPassword.iv,
    });

    return redirect('/?success=letterboxd_connected');
  } catch (error) {
    console.error('Error saving Letterboxd credentials:', error);
    return redirect('/letterboxd?error=save_failed');
  }
}

export default function Letterboxd({ loaderData }: { loaderData: { user: any; success: string | null; error: string | null } }) {
  const { user, success, error } = loaderData;
  const isConnected = Boolean(user.letterboxdUsername && user.letterboxdPasswordHash);

  return (
    <div className="app-container">
      <div className="content-wrapper">
        <div className="retro-card p-8 text-center">
          <h1 className="hero-title gradient-text">
            📽️ LETTERBOXD SETTINGS
          </h1>
          <p className="text-lg text-gray-600 max-w-md mx-auto">
            {isConnected ? 'Manage your Letterboxd connection' : 'Connect your Letterboxd account for automatic logging'}
          </p>
          {isConnected && (
            <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-emerald-100 border-2 border-emerald-600 rounded">
              <span className="text-emerald-800 font-bold">✓ CONNECTED</span>
            </div>
          )}
        </div>

        <div className="section-spacing">
          {success && (
            <div className="retro-alert bg-emerald-100 border-emerald-600 text-emerald-800 p-4">
              <p className="font-bold text-center">
                ✓ {success === 'credentials_saved' ? 'Letterboxd credentials saved successfully!' : 'Success!'}
              </p>
            </div>
          )}

          {error && (
            <div className="retro-alert bg-red-100 border-red-600 text-red-800 p-4">
              <p className="font-bold text-center">
                ⚠ {error === 'missing_credentials' ? 'Please fill in both username and password' :
                    error === 'save_failed' ? 'Failed to save credentials' : 'Error occurred'}
              </p>
            </div>
          )}
        </div>

        <div className="retro-card p-8">
          {isConnected && (
            <div className="retro-alert bg-emerald-100 border-emerald-600 text-emerald-800 p-6 mb-8">
              <div className="text-center">
                <p className="font-bold text-xl mb-2">🎬 LETTERBOXD CONNECTED</p>
                <p className="text-lg">Username: <span className="font-mono">{user.letterboxdUsername}</span></p>
                <p className="text-sm mt-2 opacity-75">Update your credentials below if needed</p>
              </div>
            </div>
          )}

          <Form method="post" className="section-spacing">
            <div>
              <label className="block text-lg font-bold mb-3 gradient-text" htmlFor="username">
                LETTERBOXD USERNAME
              </label>
              <input
                type="text"
                id="username"
                name="username"
                defaultValue={user.letterboxdUsername || ''}
                className="retro-input w-full p-4 text-lg"
                placeholder="your_letterboxd_username"
                required
              />
            </div>

            <div>
              <label className="block text-lg font-bold mb-3 gradient-text" htmlFor="password">
                LETTERBOXD PASSWORD
              </label>
              <input
                type="password"
                id="password"
                name="password"
                className="retro-input w-full p-4 text-lg"
                placeholder={isConnected ? "Enter new password to update" : "your_letterboxd_password"}
                required
              />
            </div>

            <button
              type="submit"
              className="retro-button w-full bg-gradient-to-r from-emerald-400 to-emerald-500 hover:from-emerald-300 hover:to-emerald-400 p-6 text-xl text-black"
            >
              💾 {isConnected ? 'UPDATE CREDENTIALS' : 'SAVE CREDENTIALS'}
            </button>
          </Form>
        </div>

        <div className="retro-card bg-gradient-to-br from-amber-50 to-amber-100 p-6">
          <h3 className="font-bold mb-3 text-lg gradient-text text-center">🔒 SECURITY NOTE</h3>
          <p className="text-gray-700 leading-relaxed text-center max-w-lg mx-auto">
            Your credentials are encrypted and stored securely. They're only used to log movies
            to your Letterboxd account and are never shared with third parties.
          </p>
        </div>

        <div className="text-center">
          <Link
            to="/"
            className="retro-button inline-block bg-gradient-to-r from-gray-300 to-gray-400 hover:from-gray-200 hover:to-gray-300 px-8 py-4 text-black no-underline"
          >
            ← BACK TO HOME
          </Link>
        </div>
      </div>
    </div>
  );
}