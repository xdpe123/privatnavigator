import { DurableObject } from 'cloudflare:workers';
import { generateRequestDetails } from 'web-push';
import { requireLogin } from './cloud-auth.js';
import { subscriptionValid } from './push-subscription.js';
import { createTransitClient } from './transit.js';
import { transitApi } from './transit-api.js';
import { evaluateWatch, minute, pendingReminders, snapshot, tripSchedule } from './trip-monitor.js';
import { apiLimit, budgetError, budgetWarning, crossedBudgetThreshold, day, dayKey, historyDays, requestKind, usageReport } from './usage.js';
import { completedTrip, historyWindow, summarizeTrips } from './punctuality.js';
import { pushPreview, pushTestTypes } from './push-previews.js';
import { normalizePushOptions, pushWatchIds } from './public/push-options.js';

function json(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function configured(env) {
  return env.PUSH_ACCESS_PASSWORD && env.TRANSITOUS_CONTACT &&
    env.PUSH_SUBJECT && env.PUSH_PUBLIC_KEY && env.PUSH_PRIVATE_KEY;
}

function cloudTransit(env) {
  const usage = env.API_USAGE.getByName('transitous');
  return createTransitClient(env.TRANSITOUS_CONTACT, async (path) => {
    if (!await usage.reserve(requestKind(path))) throw budgetError();
  });
}

export default {
  async fetch(request, env) {
    if (!env.PUSH_ACCESS_PASSWORD) return json(503, { error: 'Die private Installation wird eingerichtet.' });
    const url = new URL(request.url);
    try {
      const { response, renew } = await requireLogin(request, url, env.PUSH_ACCESS_PASSWORD);
      if (response) return response;
      if (request.method === 'GET' && url.pathname === '/anmelden') {
        return new Response(null, { status: 303, headers: { Location: '/', 'Cache-Control': 'no-store' } });
      }
      if (request.method === 'GET' && url.pathname === '/api/usage') {
        return json(200, await env.API_USAGE.getByName('transitous').report());
      }
      if (request.method === 'GET' && url.pathname === '/api/punctuality') {
        return json(200, { routes: await env.TRIP_HISTORY.getByName('punctuality').report([7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 90) });
      }
      if (request.method === 'GET' && url.pathname === '/api/push') {
        const ready = Boolean(configured(env));
        return json(200, {
          enabled: ready && env.PUSH_MONITORING === 'true',
          budgetAlerts: ready,
          testEnabled: ready,
          testTypes: ready ? pushTestTypes : [],
          publicKey: ready ? env.PUSH_PUBLIC_KEY : null,
        });
      }
      if (url.pathname === '/api/push/budget') {
        if (!configured(env)) return json(503, { error: 'API-Budgetwarnungen sind hier noch nicht verfügbar.' });
        if (request.method !== 'POST') return json(405, { error: 'Diese Push-Aktion ist nicht verfügbar.' });
        if (request.headers.get('Origin') !== url.origin) return json(403, { error: 'Ungültige Herkunft.' });
        const body = await request.json().catch(() => null);
        if (!subscriptionValid(body?.subscription) || typeof body.enabled !== 'boolean') {
          return json(400, { error: 'Ungültige Anmeldung für API-Budgetwarnungen.' });
        }
        await env.API_USAGE.getByName('transitous').setAlerts(body.subscription, body.enabled);
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/push/watch' || url.pathname === '/api/push/test') {
        if (!configured(env)) return json(503, { error: 'Push wird eingerichtet.' });
        if (request.headers.get('Origin') !== url.origin) return json(403, { error: 'Ungültige Herkunft.' });
        if (url.pathname === '/api/push/test') return await env.WATCHES.getByName('push-test').fetch(request);
        if (env.PUSH_MONITORING !== 'true') return json(503, { error: 'Die automatische Fahrtüberwachung ist noch nicht aktiv.' });
        return await env.WATCHES.getByName('privatnavigator').fetch(request);
      }
      if (url.pathname.startsWith('/api/')) {
        if (!env.TRANSITOUS_CONTACT) return json(503, { error: 'Der Fahrplandienst für diese HTTPS-Installation wird eingerichtet.' });
        return await transitApi(request, url, cloudTransit(env), json);
      }
      const asset = await env.ASSETS.fetch(request);
      const page = new Response(asset.body, asset);
      page.headers.set('Cache-Control', 'private, no-cache');
      if (renew && url.pathname === '/') {
        page.headers.set('Set-Cookie', renew);
        page.headers.set('Cache-Control', 'no-store');
      }
      return page;
    } catch (error) {
      if (error.status === 429) return json(429, { error: error.message });
      console.error(error.message);
      return json(502, { error: 'Dienst gerade nicht erreichbar. Bitte versuche es erneut.' });
    }
  },
};

export class ApiUsage extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, timestamp INTEGER, date TEXT, kind TEXT)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS call_time ON calls(timestamp)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS budget_level (id INTEGER PRIMARY KEY, level INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS budget_devices (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS budget_queue (id INTEGER PRIMARY KEY, endpoint TEXT NOT NULL, level INTEGER NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)');
  }

  async reserve(kind) {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const before = this.count(now);
      if (before >= apiLimit) return { allowed: false, queued: false };
      this.sql.exec('DELETE FROM calls WHERE timestamp <= ?', now - (historyDays + 1) * day);
      this.sql.exec('INSERT INTO calls(timestamp,date,kind) VALUES (?,?,?)', now, dayKey(now), kind);
      const previous = this.sql.exec('SELECT level FROM budget_level WHERE id = 1').toArray()[0]?.level || 0;
      const level = crossedBudgetThreshold(previous, before, before + 1);
      if (level || (before < apiLimit / 2 && previous)) {
        this.sql.exec('INSERT INTO budget_level (id, level) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET level = excluded.level', level);
      }
      const queued = level ? this.sql.exec('INSERT INTO budget_queue (endpoint,level,due) SELECT endpoint, ?, ? FROM budget_devices', level, now).rowsWritten : 0;
      return { allowed: true, queued };
    });
    if (result.queued) await this.ctx.storage.setAlarm(now);
    return result.allowed;
  }

  setAlerts(subscription, enabled) {
    this.ctx.storage.transactionSync(() => {
      if (enabled) {
        this.sql.exec('INSERT INTO budget_devices (endpoint, subscription) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription',
          subscription.endpoint, JSON.stringify(subscription));
      } else {
        this.sql.exec('DELETE FROM budget_queue WHERE endpoint = ?', subscription.endpoint);
        this.sql.exec('DELETE FROM budget_devices WHERE endpoint = ?', subscription.endpoint);
      }
    });
  }

  async alarm() {
    const now = Date.now();
    const jobs = this.sql.exec(`SELECT budget_queue.*, budget_devices.subscription FROM budget_queue
      JOIN budget_devices USING(endpoint) WHERE due <= ? ORDER BY due, id LIMIT 16`, now).toArray();
    for (const job of jobs) {
      const stillEnabled = this.sql.exec('SELECT 1 FROM budget_queue WHERE id = ?', job.id).toArray().length;
      if (!stillEnabled) continue;
      try {
        await deliver(this.env, JSON.parse(job.subscription), budgetWarning(job.level));
        this.sql.exec('DELETE FROM budget_queue WHERE id = ?', job.id);
      } catch (error) {
        if ([404, 410].includes(error.status)) this.setAlerts({ endpoint: job.endpoint }, false);
        else if (job.attempts >= 2) this.sql.exec('DELETE FROM budget_queue WHERE id = ?', job.id);
        else this.sql.exec('UPDATE budget_queue SET attempts = attempts + 1, due = ? WHERE id = ?', Date.now() + minute, job.id);
      }
    }
    const next = this.sql.exec('SELECT MIN(due) AS due FROM budget_queue').one().due;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }

  count(now) {
    return this.sql.exec('SELECT COUNT(*) AS count FROM calls WHERE timestamp > ?', now - day).one().count;
  }

  report() {
    const now = Date.now();
    const rows = this.sql.exec('SELECT date, kind, COUNT(*) AS count FROM calls GROUP BY date, kind').toArray();
    return usageReport(rows, this.count(now), now);
  }
}

export class TripHistory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, origin TEXT, destination TEXT, lines TEXT, departure INTEGER, kind TEXT, delay INTEGER)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS trip_date ON trips(departure)');
  }

  record(trip) {
    this.sql.exec('DELETE FROM trips WHERE departure < ?', Date.now() - historyWindow);
    this.sql.exec(`INSERT INTO trips (id, origin, destination, lines, departure, kind, delay) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, delay = excluded.delay
      WHERE trips.kind = 'unknown' OR (trips.kind = 'forecast' AND excluded.kind <> 'unknown')
         OR excluded.kind IN ('observed','cancelled')`,
    trip.id, trip.origin, trip.destination, trip.lines, trip.departure, trip.kind, trip.delay);
  }

  report(days = 90) {
    return summarizeTrips(this.sql.exec('SELECT origin, destination, lines, departure, kind, delay FROM trips WHERE departure >= ? ORDER BY departure DESC',
      Date.now() - historyWindow).toArray(), days);
  }
}

export class TripWatches extends DurableObject {
  async fetch(request) {
    const storage = this.ctx.storage;
    const path = new URL(request.url).pathname;
    if (path === '/api/push/test') {
      if (request.method !== 'POST') return json(405, { error: 'Diese Push-Aktion ist nicht verfügbar.' });
      const payload = await request.json().catch(() => null);
      const subscription = payload?.subscription || payload;
      if (!subscriptionValid(subscription)) return json(400, { error: 'Für diesen Test ist ein Apple-Push-Abo nötig.' });
      const preview = pushPreview(payload?.type || 'general');
      if (!preview) return json(400, { error: 'Diese Push-Testart ist nicht verfügbar.' });
      try {
        await deliver(this.env, subscription, preview);
        return json(200, { ok: true });
      } catch (error) {
        console.warn('Apple-Push-Test fehlgeschlagen:', error.name, error.message);
        return json(502, {
          error: error.status
            ? `Apple-Push: HTTP ${error.status}${error.reason ? ` · ${error.reason}` : ''}.`
            : 'Der Server konnte die Testmitteilung nicht vorbereiten oder an Apple übertragen.',
          resetSubscription: [404, 410].includes(error.status) || error.reason === 'VapidPkHashMismatch',
          diagnostic: error.status ? null : error.name,
        });
      }
    }
    if (request.method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id');
      if (id) await storage.delete(id);
      return json(200, { ok: true });
    }
    if (!['POST', 'PATCH'].includes(request.method)) return json(405, { error: 'Diese Push-Aktion ist nicht verfügbar.' });
    let body;
    try {
      const text = await request.text();
      if (text.length > 16_000) throw new Error('Request too large');
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'Ungültige Push-Anfrage.' });
    }
    const preferences = normalizePushOptions(body?.preferences);
    if (request.method === 'PATCH') {
      const ids = pushWatchIds(body?.ids);
      if (!ids || !body.preferences || typeof body.preferences !== 'object') return json(400, { error: 'Ungültige Push-Einstellungen.' });
      await storage.transaction(async (tx) => {
        for (const id of ids) {
          const watch = await tx.get(id);
          if (watch) await tx.put(id, { ...watch, preferences });
        }
      });
      return json(200, { ok: true });
    }
    if (!body || !subscriptionValid(body.subscription) || typeof body.itineraryId !== 'string' ||
        !body.itineraryId || body.itineraryId.length > 7000 || !/^[a-f0-9]{24}$/.test(body.tripKey)) {
      return json(400, { error: 'Diese Fahrt oder Push-Anmeldung ist ungültig.' });
    }
    const { refreshJourney } = cloudTransit(this.env);
    const journey = await refreshJourney(body.itineraryId);
    const schedule = tripSchedule(journey, Date.now());
    if (!schedule) return json(400, { error: 'Für diese Fahrt ist die Überwachung bereits abgelaufen.' });

    return storage.transaction(async (tx) => {
      const active = [...(await tx.list()).values()].filter((watch) => watch.until > Date.now());
      const existing = active.find((watch) => watch.tripKey === body.tripKey &&
        watch.subscription.endpoint === body.subscription.endpoint);
      if (existing) {
        await tx.put(existing.id, { ...existing, preferences });
        return json(200, { id: existing.id });
      }
      if (active.length >= 5) return json(429, { error: 'Es können höchstens fünf Fahrten abonniert werden.' });
      const id = crypto.randomUUID();
      const watch = { id, tripKey: body.tripKey, itineraryId: body.itineraryId,
        subscription: body.subscription, preferences, ...schedule, baseline: snapshot(journey) };
      await tx.put(id, watch);
      await scheduleAlarm(tx, [...active, watch]);
      return json(200, { id });
    });
  }

  async alarm() {
    if (this.env.PUSH_MONITORING !== 'true') return;
    const storage = this.ctx.storage;
    const now = Date.now();
    const { refreshJourney } = cloudTransit(this.env);
    for (const [id, watch] of await storage.list()) {
      if (watch.until <= now) {
        const trip = completedTrip(watch);
        if (trip) await this.env.TRIP_HISTORY.getByName('punctuality').record(trip);
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
      const current = await storage.get(id);
      if (!current) continue;
      const { message, next } = evaluateWatch(current, latest, now);
      delete next.retryAt;
      try {
        if (message) await deliver(this.env, current.subscription, { ...message, url: `/#fahrt-${current.tripKey}` });
      } catch (error) {
        if ([404, 410].includes(error.status)) {
          await storage.delete(id);
          continue;
        }
        console.warn('Push-Zustellung fehlgeschlagen:', error.message);
        await storage.transaction(async (tx) => {
          const existing = await tx.get(id);
          if (existing) await tx.put(id, { ...existing, observation: next.observation || existing.observation || null, retryAt: Date.now() + minute });
        });
        continue;
      }
      await storage.transaction(async (tx) => {
        const existing = await tx.get(id);
        if (existing) await tx.put(id, { ...next, preferences: existing.preferences || next.preferences || null });
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

async function deliver(env, subscription, message) {
  const request = generateRequestDetails(subscription, JSON.stringify(message), { TTL: 600, urgency: 'high', vapidDetails: {
    subject: env.PUSH_SUBJECT, publicKey: env.PUSH_PUBLIC_KEY, privateKey: env.PUSH_PRIVATE_KEY,
  } });
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  const response = await fetch(request.endpoint, {
    method: request.method, body: request.body,
    headers, redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const error = new Error(`Apple Web Push HTTP ${response.status}`);
    error.status = response.status;
    error.reason = /^[A-Za-z]{2,60}$/.test(result?.reason || '') ? result.reason : null;
    throw error;
  }
  await response.body?.cancel();
}
