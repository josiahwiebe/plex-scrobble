import { Link } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { validateUserSession } from "../lib/plex-session.js";

export function meta() {
  return [
    { title: "Plex Letterboxd Scrobbler" },
    { name: "description", content: "Connect your Plex to Letterboxd" },
  ];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { user, headers } = await validateUserSession(request);
  const url = new URL(request.url);
  const success = url.searchParams.get('success');
  const error = url.searchParams.get('error');

  return { user, success, error, headers };
}

export default function Home({ loaderData }: { loaderData: { user: any; success: string | null; error: string | null } }) {
  const { user, success, error } = loaderData;

  return (
    <div className="app-container">
      <div className="content-wrapper">
        {/* Hero Section */}
        <div className="retro-card p-8 text-center">
          <h1 className="hero-title gradient-text">
            PLEX → LETTERBOXD
          </h1>
          <p className="text-lg text-gray-600 max-w-md mx-auto">
            Automatically sync your Plex movie watches to Letterboxd
          </p>
        </div>

        {/* Alert Messages */}
        <div className="section-spacing">
          {success && (
            <div className="retro-alert bg-emerald-100 border-emerald-600 text-emerald-800 p-4">
              <p className="font-bold text-center">
                ✓ {success === 'plex_connected' ? 'Plex account connected successfully!' : 'Success!'}
              </p>
            </div>
          )}

          {error && (
            <div className="retro-alert bg-red-100 border-red-600 text-red-800 p-4">
              <p className="font-bold text-center">
                ⚠ {error === 'missing_code' ? 'Missing authorization code' :
                    error === 'auth_failed' ? 'Authentication failed' : 'Error occurred'}
              </p>
            </div>
          )}

          {user && (
            <div className="retro-alert bg-blue-100 border-blue-600 text-blue-800 p-4">
              <div className="text-center">
                <p className="font-bold">👤 Logged in as: {user.plexUsername}</p>
                <p className="text-sm opacity-75">Plex ID: {user.plexId}</p>
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="retro-card p-8">
          <div className="section-spacing">
            {!user?.plexId && (
              <Link
                to="/auth/plex"
                className="retro-button block w-full bg-gradient-to-r from-orange-400 to-orange-500 hover:from-orange-300 hover:to-orange-400 p-6 text-xl text-black text-center no-underline"
              >
                🎬 CONNECT PLEX ACCOUNT
              </Link>
            )}

            {user?.plexId && !user?.letterboxdUsername && (
              <Link
                to="/letterboxd"
                className="retro-button block w-full bg-gradient-to-r from-emerald-400 to-emerald-500 hover:from-emerald-300 hover:to-emerald-400 p-6 text-xl text-black text-center no-underline"
              >
                📽️ CONNECT LETTERBOXD
              </Link>
            )}

            {user?.plexId && user?.letterboxdUsername && (
              <div className="space-y-4">
                <div className="retro-alert bg-emerald-200 border-emerald-600 text-emerald-800 p-6 text-center">
                  <p className="text-2xl font-bold mb-2">🎉 ALL CONNECTED</p>
                  <p className="text-lg">Your Plex watches will now sync to Letterboxd</p>
                </div>
                <div className="button-grid">
                  <Link
                    to="/webhook-settings"
                    className="retro-button block w-full bg-gradient-to-r from-blue-400 to-blue-500 hover:from-blue-300 hover:to-blue-400 p-4 text-lg text-black text-center no-underline"
                  >
                    ⚙️ WEBHOOK SETTINGS
                  </Link>
                  <Link
                    to="/letterboxd"
                    className="retro-button block w-full bg-gradient-to-r from-emerald-400 to-emerald-500 hover:from-emerald-300 hover:to-emerald-400 p-4 text-lg text-black text-center no-underline"
                  >
                    📽️ UPDATE LETTERBOXD
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* How It Works */}
        <div className="retro-card bg-gradient-to-br from-yellow-50 to-yellow-100 p-8">
          <h2 className="text-2xl font-bold mb-6 text-center gradient-text">HOW IT WORKS</h2>
          <div className="button-grid">
            <div className="flex items-center space-x-4 p-4">
              <span className="retro-button bg-blue-400 w-10 h-10 flex items-center justify-center text-lg font-bold flex-shrink-0">1</span>
              <span className="text-gray-700">Connect your Plex account</span>
            </div>
            <div className="flex items-center space-x-4 p-4">
              <span className="retro-button bg-green-400 w-10 h-10 flex items-center justify-center text-lg font-bold flex-shrink-0">2</span>
              <span className="text-gray-700">Add Letterboxd credentials</span>
            </div>
            <div className="flex items-center space-x-4 p-4">
              <span className="retro-button bg-purple-400 w-10 h-10 flex items-center justify-center text-lg font-bold flex-shrink-0">3</span>
              <span className="text-gray-700">Watch movies on Plex</span>
            </div>
            <div className="flex items-center space-x-4 p-4">
              <span className="retro-button bg-orange-400 w-10 h-10 flex items-center justify-center text-lg font-bold flex-shrink-0">4</span>
              <span className="text-gray-700">Auto-sync to Letterboxd</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}