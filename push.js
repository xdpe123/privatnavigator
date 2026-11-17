import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { sendNotification, setVapidDetails } from 'web-push';
import { subscriptionValid } from './push-subscription.js';
import { evaluateWatch, minute, pendingReminders, snapshot, tripSchedule } from './trip-monitor.js';

const stateFile = new URL('./push-watches.json', import.meta.url);
const tempFile = new URL('./push-watches.tmp', import.meta.url);
const env = process.env;
const origin = env.PUSH_ORIGIN ? new URL(env.PUSH_ORIGIN).origin : '';
const enabled = Boolean(origin);
const digest = (value) => createHash('sha256').update(value).digest();
let watches = [];

if (enabled) {
  if (!origin.startsWith('https://') || !env.PUSH_ACCESS_PASSWORD || !env.TRANSITOUS_CONTACT) {
    throw new Error('Push benötigt HTTPS, PUSH_ACCESS_PASSWORD und TRANSITOUS_CONTACT.');
  }
  setVapidDetails(env.PUSH_SUBJECT, env.PUSH_PUBLIC_KEY, env.PUSH_PRIVATE_KEY);
  try {
    watches = JSON.parse(readFileSync(stateFile, 'utf8')).map((watch) => Number.isFinite(watch.departure) ? watch : {
      ...watch, departure: watch.from + 45 * minute, nextCheck: 0, reminders: [60, 30],
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function persist(next) {
  writeFileSync(tempFile, JSON.stringify(next), { mode: 0o600 });
  renameSync(tempFile, stateFile);
  watches = next;
}

export function authorizePushSite(request, response) {
  if (!enabled) return true;
  const expected = `Basic ${Buffer.from(`navigator:${env.PUSH_ACCESS_PASSWORD}`).toString('base64')}`;
  if (timingSafeEqual(digest(request.headers.authorization || ''), digest(expected))) return true;
  response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Privatnavigator"', 'Cache-Control': 'no-store' });
  response.end('Anmeldung erforderlich.');
  return false;
}

async function readBody(request) {
  const stream = request.iterator({ destroyOnReturn: false });
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > 16_000) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks));
}

export async function handlePush(request, response, url, json, refreshJourney) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && url.pathname === '/api/push') {
    return json(response, 200, { enabled, publicKey: enabled ? env.PUSH_PUBLIC_KEY : null });
  }
  if (!enabled || request.headers.origin !== origin) {
    return json(response, 403, { error: 'Push ist für diese Adresse nicht eingerichtet.' });
  }
  if (request.method === 'DELETE' && url.pathname === '/api/push/watch') {
    persist(watches.filter((watch) => watch.id !== url.searchParams.get('id')));
    return json(response, 200, { ok: true });
  }
  if (request.method !== 'POST' || url.pathname !== '/api/push/watch') {
    return json(response, 405, { error: 'Diese Push-Aktion ist nicht verfügbar.' });
  }
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json(response, 400, { error: 'Ungültige Push-Anfrage.' });
  }
  if (!body || !subscriptionValid(body.subscription) ||
      typeof body.itineraryId !== 'string' || !body.itineraryId || body.itineraryId.length > 7000 ||
      !/^[a-f0-9]{24}$/.test(body.tripKey)) {
    return json(response, 400, { error: 'Diese Fahrt oder Push-Anmeldung ist ungültig.' });
  }
  const existing = watches.find((watch) => watch.tripKey === body.tripKey &&
    watch.subscription.endpoint === body.subscription.endpoint);
  if (existing) return json(response, 200, { id: existing.id });
  const journey = await refreshJourney(body.itineraryId);
  const schedule = tripSchedule(journey, Date.now());
  if (!schedule) {
    return json(response, 400, { error: 'Für diese Fahrt ist die Überwachung bereits abgelaufen.' });
  }
  const active = watches.filter((item) => item.until > Date.now());
  if (active.length >= 5) return json(response, 429, { error: 'Es können höchstens fünf Fahrten abonniert werden.' });
  const watch = {
    id: randomUUID(),
    tripKey: body.tripKey,
    itineraryId: body.itineraryId,
    subscription: body.subscription,
    ...schedule,
    baseline: snapshot(journey),
  };
  persist([...active, watch]);
  return json(response, 200, { id: watch.id });
}

export function monitorTrips(refreshJourney) {
  if (!enabled) return;
  async function check() {
    const now = Date.now();
    const active = watches.filter((watch) => watch.until > now);
    if (active.length !== watches.length) persist(active);
    for (const watch of active.filter((item) => !(item.retryAt > now) &&
      (item.nextCheck <= now || pendingReminders(item, now).length))) {
      try {
        let latest = null;
        try {
          latest = snapshot(await refreshJourney(watch.itineraryId));
        } catch (error) {
          console.warn('Fahrtstatus nicht abrufbar:', error.message);
        }
        if (!watches.includes(watch)) continue;
        const { message, next } = evaluateWatch(watch, latest, now);
        if (message) {
          await sendNotification(watch.subscription, JSON.stringify({
            ...message, url: `/#fahrt-${watch.tripKey}`,
          }), { TTL: 600, timeout: 10_000 });
        }
        if (watches.includes(watch)) {
          delete next.retryAt;
          persist(watches.map((item) => item === watch ? next : item));
        }
      } catch (error) {
        if ([404, 410].includes(error.statusCode)) persist(watches.filter((item) => item !== watch));
        else {
          console.warn('Fahrtüberwachung fehlgeschlagen:', error.statusCode || error.message);
          if (watches.includes(watch)) persist(watches.map((item) =>
            item === watch ? { ...item, retryAt: Date.now() + minute } : item));
        }
      }
    }
  }
  async function run() {
    try {
      await check();
    } catch (error) {
      console.warn('Push-Überwachung:', error.message);
    } finally {
      setTimeout(run, 15_000).unref();
    }
  }
  void run();
}
