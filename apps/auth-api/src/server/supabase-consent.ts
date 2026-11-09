const consentPath = "/oauth/consent";
const callbackPath = "/v1/auth/company/callback";
const sessionCookie = "__Host-openbot-supabase-consent";
const authorizationIdPattern = /^[a-zA-Z0-9_-]{16,128}$/;

export interface SupabaseConsentBindings {
  SUPABASE_AUTH_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_OAUTH_CLIENT_ID?: string;
}

export async function supabaseConsent(request: Request, bindings: SupabaseConsentBindings): Promise<Response | null> {
  const url = new URL(request.url);
  const { SUPABASE_AUTH_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_OAUTH_CLIENT_ID } = bindings;
  if (url.pathname !== consentPath || !SUPABASE_AUTH_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_OAUTH_CLIENT_ID) {
    return null;
  }

  const authorizationId = url.searchParams.get("authorization_id") ?? "";
  if (!authorizationIdPattern.test(authorizationId))
    return page("<p>Open sign-in again from the OpenBot app.</p>", 400);
  const authUrl = URL.canParse(SUPABASE_AUTH_URL) ? new URL(SUPABASE_AUTH_URL) : null;
  const isLoopback = (value: URL) => value.protocol === "http:" && value.hostname === "127.0.0.1";
  if (
    !authUrl ||
    authUrl.username ||
    authUrl.password ||
    authUrl.search ||
    authUrl.hash ||
    (authUrl.protocol !== "https:" && !(isLoopback(authUrl) && isLoopback(url)))
  ) {
    return page("<p>Sign-in is temporarily unavailable.</p>", 503);
  }
  const base = authUrl.href.replace(/\/$/, "");
  const callback = new URL(callbackPath, url.origin);
  const authorizationPath = `/oauth/authorizations/${authorizationId}`;
  const publishableKey = SUPABASE_PUBLISHABLE_KEY;
  const storedSession = request.headers
    .get("Cookie")
    ?.split(/;\s*/)
    .find((cookie) => cookie.startsWith(`${sessionCookie}=${authorizationId}.`))
    ?.slice(sessionCookie.length + authorizationId.length + 2);

  async function call(path: string, options: { body?: object; token?: string } = {}) {
    const headers = new Headers({ apikey: publishableKey, Origin: url.origin });
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    if (options.body) headers.set("Content-Type", "application/json");
    return fetch(base + path, {
      method: options.body ? "POST" : "GET",
      headers,
      body: options.body && JSON.stringify(options.body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  }

  function finish(location: unknown) {
    const target = typeof location === "string" && URL.canParse(location) ? new URL(location) : null;
    if (!target || target.origin !== callback.origin || target.pathname !== callback.pathname) {
      return page("<p>This request could not be completed. Open sign-in again from the OpenBot app.</p>", 400);
    }
    return redirect(target.href, "", 0);
  }

  try {
    let action: FormDataEntryValue | null = null;
    if (request.method === "POST") {
      if (request.headers.get("Origin") !== url.origin) return page("<p>Invalid sign-in request.</p>", 403);
      if (Number(request.headers.get("Content-Length")) > 8192) return page("<p>Invalid sign-in request.</p>", 413);
      const form = await request.formData();
      action = form.get("action");
      if (action === "sign-in") {
        const email = form.get("email");
        const password = form.get("password");
        if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
          return signIn("Enter your email and password.");
        }
        const signedIn = await call("/token?grant_type=password", { body: { email: email.trim(), password } });
        if (signedIn.status === 429) return signIn("Too many attempts. Wait a moment and try again.");
        if (signedIn.status >= 500) return page("<p>Sign-in is temporarily unavailable. Please try again.</p>", 503);
        if (!signedIn.ok) return signIn("Check your email and password, then try again.");
        const { access_token: token } = await signedIn.json<{ access_token?: unknown }>();
        if (typeof token !== "string" || !/^[\w.-]+$/.test(token) || token.length > 3500) {
          return page("<p>Sign-in is temporarily unavailable.</p>", 503);
        }
        return redirect(url.href, `${authorizationId}.${token}`, 300);
      }
      if (action !== "approve" && action !== "deny") return page("<p>Invalid sign-in request.</p>", 400);
    } else if (request.method !== "GET") {
      return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
    }
    if (!storedSession) return signIn(action ? "Sign in again to continue." : undefined);
    const details = await call(authorizationPath, { token: storedSession });
    if (!details.ok) return signIn("Your sign-in expired. Sign in again or reopen OpenBot.");
    const authorization = await details.json<AuthorizationDetails>();
    if (authorization.redirect_url) return finish(authorization.redirect_url);
    if (!isExpectedRequest(authorization, SUPABASE_OAUTH_CLIENT_ID, callback.href)) {
      return page("<p>This sign-in request does not belong to OpenBot.</p>", 400);
    }
    if (action) {
      const decision = await call(`${authorizationPath}/consent`, { token: storedSession, body: { action } });
      if (!decision.ok) return page("<p>Open sign-in again from the OpenBot app.</p>", 400);
      return finish((await decision.json<AuthorizationDetails>()).redirect_url);
    }
    return page(`<p>Allow OpenBot to use your name and verified email to sign you in.</p>
      <form method="post">
        <button name="action" value="approve">Continue to OpenBot</button>
        <button name="action" value="deny" class="secondary">Cancel</button>
      </form>`);
  } catch {
    return page("<p>Sign-in is temporarily unavailable. Please try again.</p>", 503);
  }
}

interface AuthorizationDetails {
  client?: { id: string };
  redirect_uri?: string;
  redirect_url?: string;
  scope?: string;
}

function isExpectedRequest(details: AuthorizationDetails, clientId: string, callback: string) {
  const scopes = details.scope?.split(" ");
  return (
    details.client?.id === clientId &&
    details.redirect_uri === callback &&
    scopes?.includes("openid") &&
    scopes.every((scope) => ["openid", "email", "profile"].includes(scope))
  );
}

function signIn(message?: string) {
  return page(`<p>Use the account your administrator set up for you.</p>
    ${message ? `<p role="alert">${message}</p>` : ""}
    <form method="post">
      <input type="hidden" name="action" value="sign-in">
      <label>Email<input name="email" type="email" autocomplete="username" maxlength="254" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label>
      <button>Sign in</button>
    </form>`);
}

function page(content: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to OpenBot</title>
    <style>
      :root{color-scheme:light dark;font:1rem system-ui,sans-serif}
      body{margin:0;padding:2rem 1rem} main{max-width:26rem;margin:8vh auto}
      h1{font-size:1.65rem} form,label{display:grid;gap:.5rem} form{gap:1rem}
      input,button{font:inherit;box-sizing:border-box;border:1px solid GrayText;border-radius:.5rem;padding:.7rem}
      button{cursor:pointer;background:#5b37bd;color:white;border-color:transparent}
      button.secondary{background:Canvas;color:CanvasText;border-color:GrayText}
      :focus-visible{outline:2px solid Highlight;outline-offset:3px}
    </style><main><h1>Sign in to OpenBot</h1>${content}</main></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function redirect(location: string, cookieValue: string, maxAge: number) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": `${sessionCookie}=${cookieValue}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}
