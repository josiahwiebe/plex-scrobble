import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { exchangePlexCode } from "../lib/auth.js";
import { getUserByPlexId, createUser, updateUser } from "../lib/database.js";
import { createUserSession } from "../lib/plex-session.js";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const plexUser = await exchangePlexCode(request);

    let user = await getUserByPlexId(plexUser.id);

    if (!user) {
      user = await createUser({
        plexId: plexUser.id,
        plexUsername: plexUser.username,
        plexToken: plexUser.authToken,
      });
    } else {
      user = await updateUser(user.id, {
        plexUsername: plexUser.username,
        plexToken: plexUser.authToken,
      });
    }


    const sessionCookie = await createUserSession(user, request);

    return redirect('/?success=plex_connected', {
      headers: {
        "Set-Cookie": sessionCookie,
      },
    });
  } catch (error) {
    console.error('Plex auth error:', error);
    return redirect('/?error=auth_failed');
  }
}