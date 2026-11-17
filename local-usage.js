import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { apiLimit, budgetError, day, dayKey, historyDays, requestKind, usageReport } from './usage.js';

const file = new URL('./api-usage.json', import.meta.url);
const temporary = new URL('./api-usage.tmp', import.meta.url);
let entries = [];
try {
  entries = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

export function record(path) {
  const now = Date.now();
  if (entries.filter(({ timestamp }) => timestamp > now - day).length >= apiLimit) throw budgetError();
  const next = entries.filter(({ timestamp }) => timestamp > now - (historyDays + 1) * day);
  next.push({ timestamp: now, kind: requestKind(path) });
  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  renameSync(temporary, file);
  entries = next;
}

export function report() {
  const now = Date.now();
  return usageReport(entries.map(({ timestamp, kind }) =>
    ({ date: dayKey(timestamp), kind, count: 1 })),
  entries.filter(({ timestamp }) => timestamp > now - day).length, now);
}
