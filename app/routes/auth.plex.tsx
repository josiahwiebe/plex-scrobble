import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { getPlexAuthUrl } from "../lib/auth.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const { authUrl, sessionCookie } = await getPlexAuthUrl(request);
  
  return redirect(authUrl, {
    headers: {
      "Set-Cookie": sessionCookie,
    },
  });
}