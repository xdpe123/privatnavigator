import { DurableObject } from 'cloudflare:workers';
import { createHash, timingSafeEqual } from 'node:crypto';
import { generateRequestDetails } from 'web-push';
import { subscriptionValid } from './push-subscription.js';
import { createTransitClient } from './transit.js';
import { transitApi } from './transit-api.js';
import { evaluateWatch, minute, pendingReminders, snapshot, tripSchedule } from './trip-monitor.js';

function json(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function configured(env) {
  return env.PUSH_ACCESS_PASSWORD && env.TRANSITOUS_CONTACT &&
    env.PUSH_SUBJECT && env.PUSH_PUBLIC_KEY && env.PUSH_PRIVATE_KEY;
}

function authorized(request, password) {
  const expected = `Basic ${btoa(`navigator:${password}`)}`;
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(expected), hash(request.headers.get('Authorization') || ''));
}

export default {
  async fetch(request, env) {
    if (!env.PUSH_ACCESS_PASSWORD) return json(503, { error: 'Die private Installation wird eingerichtet.' });
    if (!authorized(request, env.PUSH_ACCESS_PASSWORD)) {
      return new Response('Anmeldung erforderlich.', { status: 401, headers: {
        'WWW-Authenticate': 'Basic realm="Privatnavigator"', 'Cache-Control': 'no-store',
      } });
    }
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/api/push') {
        return json(200, { enabled: Boolean(configured(env)), publicKey: configured(env) ? env.PUSH_PUBLIC_KEY : null });
      }
      if (url.pathname === '/api/push/watch') {
        if (!configured(env)) return json(503, { error: 'Push wird eingerichtet.' });
        if (request.headers.get('Origin') !== url.origin) return json(403, { error: 'Ungültige Herkunft.' });
        return await env.WATCHES.getByName('privatnavigator').fetch(request);
      }
      if (url.pathname.startsWith('/api/')) {
        if (!env.TRANSITOUS_CONTACT) return json(503, { error: 'Der Fahrplandienst für diese HTTPS-Installation wird eingerichtet.' });
        return await transitApi(request, url, createTransitClient(env.TRANSITOUS_CONTACT), json);
      }
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error.message);
      return json(502, { error: 'Dienst gerade nicht erreichbar. Bitte versuche es erneut.' });
    }
  },
};

export class TripWatches extends DurableObject {
  async fetch(request) {
    const storage = this.ctx.storage;
    if (request.method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id');
      if (id) await storage.delete(id);
      return json(200, { ok: true });
    }
    if (request.method !== 'POST') return json(405, { error: 'Diese Push-Aktion ist nicht verfügbar.' });
    let body;
    try {
      const text = await request.text();
      if (text.length > 16_000) throw new Error('Request too large');
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'Ungültige Push-Anfrage.' });
    }
    if (!body || !subscriptionValid(body.subscription) || typeof body.itineraryId !== 'string' ||
        !body.itineraryId || body.itineraryId.length > 7000 || !/^[a-f0-9]{24}$/.test(body.tripKey)) {
      return json(400, { error: 'Diese Fahrt oder Push-Anmeldung ist ungültig.' });
    }
    const { refreshJourney } = createTransitClient(this.env.TRANSITOUS_CONTACT);
    const journey = await refreshJourney(body.itineraryId);
    const schedule = tripSchedule(journey, Date.now());
    if (!schedule) return json(400, { error: 'Für diese Fahrt ist die Überwachung bereits abgelaufen.' });

    return storage.transaction(async (tx) => {
      const active = [...(await tx.list()).values()].filter((watch) => watch.until > Date.now());
      const existing = active.find((watch) => watch.tripKey === body.tripKey &&
        watch.subscription.endpoint === body.subscription.endpoint);
      if (existing) return json(200, { id: existing.id });
      if (active.length >= 5) return json(429, { error: 'Es können höchstens fünf Fahrten abonniert werden.' });
      const id = crypto.randomUUID();
      const watch = { id, tripKey: body.tripKey, itineraryId: body.itineraryId,
        subscription: body.subscription, ...schedule, baseline: snapshot(journey) };
      await tx.put(id, watch);
      await scheduleAlarm(tx, [...active, watch]);
      return json(200, { id });
    });
  }

  async alarm() {
    const storage = this.ctx.storage;
    const now = Date.now();
    const { refreshJourney } = createTransitClient(this.env.TRANSITOUS_CONTACT);
    for (const [id, watch] of await storage.list()) {
      if (watch.until <= now) {
        await storage.delete(id);
        continue;
      }
      if (watch.retryAt > now || (watch.nextCheck > now && !pendingReminders(watch, now).length)) continue;
      let latest;
      try {
        latest = snapshot(await refreshJourney(watch.itineraryId));
      } catch (error) {
        console.warn('Fahrtstatus nicht abrufbar:', error.message);
      }
      if (!await storage.get(id)) continue;
      const { message, next } = evaluateWatch(watch, latest, now);
      delete next.retryAt;
      try {
        if (message) await deliver(this.env, watch, message);
      } catch (error) {
        if ([404, 410].includes(error.status)) {
          await storage.delete(id);
          continue;
        }
        console.warn('Push-Zustellung fehlgeschlagen:', error.message);
        await storage.transaction(async (tx) => {
          if (await tx.get(id)) await tx.put(id, { ...watch, retryAt: Date.now() + minute });
        });
        continue;
      }
      await storage.transaction(async (tx) => {
        if (await tx.get(id)) await tx.put(id, next);
      });
    }
    await storage.transaction(async (tx) => scheduleAlarm(tx, [...(await tx.list()).values()]));
  }
}

async function scheduleAlarm(storage, watches) {
  if (!watches.length) return;
  const next = Math.min(...watches.map((watch) => Math.min(watch.until, watch.retryAt ||
    Math.min(watch.nextCheck, ...watch.reminders.map((offset) => watch.departure - offset * minute)))));
  await storage.setAlarm(Math.max(Date.now() + 1000, next));
}

async function deliver(env, watch, message) {
  const request = generateRequestDetails(watch.subscription, JSON.stringify({
    ...message, url: `/#fahrt-${watch.tripKey}`,
  }), { TTL: 600, vapidDetails: {
    subject: env.PUSH_SUBJECT, publicKey: env.PUSH_PUBLIC_KEY, privateKey: env.PUSH_PRIVATE_KEY,
  } });
  const response = await fetch(request.endpoint, {
    method: request.method, body: request.body,
    headers: request.headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    const error = new Error(`Apple Web Push HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
}
