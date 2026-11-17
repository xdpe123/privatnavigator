export const pushOptions = {
  before60: '60 Minuten vor Abfahrt',
  before30: '30 Minuten vor Abfahrt',
  time: 'Verspätungen und geänderte Fahrzeiten',
  platform: 'Gleiswechsel bei Abfahrt und Ankunft',
  cancellation: 'Ausfälle und aufgehobene Ausfälle',
  stops: 'Geänderte Zwischenhalte',
  notices: 'Neue Fahrtmeldungen',
  route: 'Geänderter Fahrtverlauf',
};

export function normalizePushOptions(input) {
  return Object.fromEntries(Object.keys(pushOptions).map((key) => [key, input?.[key] !== false]));
}

export function pushWatchIds(value) {
  return Array.isArray(value) && value.length <= 100 &&
    value.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) ? new Set(value) : null;
}
