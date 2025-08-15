import { storePlexPin, getPlexPin, type PlexPinData } from "./plex-session.js";

interface PlexUser {
  id: string;
  username: string;
  email?: string;
  thumb?: string;
  authToken: string;
}

export async function getPlexAuthUrl(request: Request): Promise<{ authUrl: string; sessionCookie: string }> {
  const pinResponse = await fetch('https://plex.tv/api/v2/pins', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'strong': 'true',
      'X-Plex-Product': 'Plex Scrobbler',
      'X-Plex-Client-Identifier': process.env.PLEX_CLIENT_ID!,
      'X-Plex-Device-Name': 'Plex Scrobbler',
    }),
  });

  if (!pinResponse.ok) {
    const errorText = await pinResponse.text();
    console.error('Plex PIN error:', errorText);
    throw new Error(`Failed to get Plex PIN: ${pinResponse.status}`);
  }

  const pinData = await pinResponse.json();

  const { id, code } = pinData;

  const plexPinData: PlexPinData = {
    pinId: id,
    code: code,
    createdAt: Date.now(),
  };

  const sessionCookie = await storePlexPin(request, plexPinData);

  const authUrlParams = new URLSearchParams({
    'clientID': process.env.PLEX_CLIENT_ID!,
    'code': code,
    'forwardUrl': process.env.PLEX_REDIRECT_URI || "http://localhost:5173/auth/plex/callback",
    'context[device][product]': 'Plex Scrobbler',
    'context[device][platform]': 'web',
    'context[device][device]': 'Plex Scrobbler',
    'context[device][version]': '1.0.0',
  });

  const authUrl = `https://app.plex.tv/auth#?${authUrlParams.toString()}`;

  return { authUrl, sessionCookie };
}

export async function exchangePlexCode(request: Request): Promise<PlexUser> {

  const pinData = await getPlexPin(request);

  if (!pinData) {
    throw new Error('PIN data not found in session or expired');
  }

  const isExpired = Date.now() - pinData.createdAt > 10 * 60 * 1000;
  if (isExpired) {
    throw new Error('PIN has expired');
  }

  const url = new URL(`https://plex.tv/api/v2/pins/${pinData.pinId}`);
  url.searchParams.append('code', pinData.code);
  url.searchParams.append('X-Plex-Client-Identifier', process.env.PLEX_CLIENT_ID!);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Failed to check PIN:', errorText);
    throw new Error(`Failed to exchange Plex code: ${response.status}`);
  }

  const data = await response.json();

  if (!data.authToken) {
    throw new Error('No auth token received from Plex - user may not have completed authentication');
  }

  const userResponse = await fetch('https://plex.tv/api/v2/user', {
    headers: {
      'Accept': 'application/json',
      'X-Plex-Token': data.authToken,
      'X-Plex-Client-Identifier': process.env.PLEX_CLIENT_ID!,
      'X-Plex-Product': 'Plex Scrobbler',
    },
  });

  if (!userResponse.ok) {
    const errorText = await userResponse.text();
    console.error('Failed to get user info:', errorText);
    throw new Error('Failed to get user info from Plex');
  }

  const userData = await userResponse.json();

  return {
    id: userData.id.toString(),
    username: userData.username,
    email: userData.email,
    thumb: userData.thumb,
    authToken: data.authToken,
  };
}