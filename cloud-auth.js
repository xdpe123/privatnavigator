import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const cookieName = '__Host-privatnavigator';
const maxAge = 365 * 24 * 60 * 60;
const renewalWindow = 30 * 24 * 60 * 60;
const seconds = () => Math.floor(Date.now() / 1000);

function equal(left, right) {
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(left), hash(right));
}

function signature(expires, password) {
  return createHmac('sha256', password).update(`privatnavigator-session-v1:${expires}`).digest('base64url');
}

function sessionCookie(password) {
  const expires = seconds() + maxAge;
  return `${cookieName}=${expires}.${signature(expires, password)}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function sessionExpires(request, password) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)__Host-privatnavigator=(\d{10})\.([\w-]{43})(?=;|$)/);
  if (!match) return 0;
  const expires = Number(match[1]);
  return expires > seconds() && equal(match[2], signature(expires, password)) ? expires : 0;
}

function loginPage(invalid = false) {
  return new Response(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privatnavigator · Anmelden</title>
  <style>
    * { box-sizing: border-box }
    body { display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1rem; background: #f4f4f6; color: #202128; font: 1rem system-ui,sans-serif }
    main { width: min(100%, 26rem); padding: 1.5rem; border: 1px solid #d9d9e1; border-radius: 1rem; background: #fff }
    h1 { margin: 0 0 .65rem; font-size: 1.55rem }
    p { color: #565967; margin: 0 0 1.2rem }
    label, input, button { display: block; width: 100% }
    label { font-weight: 650 }
    input, button { min-height: 2.85rem; margin-top: .4rem; border: 1px solid #d9d9e1; border-radius: .6rem; padding: .5rem .7rem; font: inherit }
    button { margin-top: 1rem; background: #cc001c; color: #fff; border-color: #cc001c; font-weight: 700 }
    .error { color: #9b2621 }
  </style>
</head>
<body><main>
  <h1>Privatnavigator</h1>
  <p>Einmal anmelden. Dieses Gerät merkt sich deine Sitzung.</p>
  ${invalid ? '<p class="error" role="alert">Das Passwort stimmt nicht.</p>' : ''}
  <form action="/anmelden" method="post">
    <input type="hidden" name="username" value="navigator" autocomplete="username">
    <label for="password">Projektpasswort</label>
    <input id="password" type="password" name="password" autocomplete="current-password" maxlength="256" required>
    <button type="submit">Anmelden</button>
  </form>
</main></body>
</html>`, { status: invalid ? 401 : 200, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  } });
}

export async function requireLogin(request, url, password) {
  if (url.pathname === '/anmelden' && request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return { response: new Response('Ungültige Herkunft.', { status: 403 }) };
    }
    const data = await request.formData().catch(() => null);
    const candidate = data?.get('password');
    if (typeof candidate !== 'string' || candidate.length > 256 || !equal(candidate, password)) {
      return { response: loginPage(true) };
    }
    return { response: new Response(null, { status: 303, headers: {
      Location: '/', 'Set-Cookie': sessionCookie(password), 'Cache-Control': 'no-store',
    } }) };
  }

  const expires = sessionExpires(request, password);
  if (expires) return { renew: expires - seconds() < renewalWindow ? sessionCookie(password) : null };
  const expected = `Basic ${Buffer.from(`navigator:${password}`).toString('base64')}`;
  if (equal(request.headers.get('Authorization') || '', expected)) return {};
  if (request.method === 'GET' && ['/', '/anmelden'].includes(url.pathname)) return { response: loginPage() };
  return { response: Response.json({ error: 'Anmeldung erforderlich. Öffne die Startseite.' }, {
    status: 401, headers: { 'Cache-Control': 'no-store' },
  }) };
}
