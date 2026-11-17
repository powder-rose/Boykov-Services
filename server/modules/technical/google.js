import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ACCOUNTING_TAB, TECH_TABS } from './model.js';

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const tokenCache = new Map();
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function isGoogleConfigured(env = process.env) {
  return Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_FILE);
}

async function credentials(env) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || await readFile(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
  const c = JSON.parse(raw);
  if (c.type !== 'service_account' || !c.client_email || !c.private_key)
    throw new Error('Неверные реквизиты сервисного аккаунта Google');
  return c;
}

async function accessToken(c, fetchImpl) {
  const cached = tokenCache.get(c.client_email);
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: c.client_email,
    scope: SCOPES,
    aud: c.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = sign('RSA-SHA256', Buffer.from(payload), c.private_key).toString('base64url');
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${payload}.${signature}`,
  });
  const response = await fetchImpl(c.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Google OAuth: HTTP ${response.status}`);
  const json = await response.json();
  if (!json.access_token) throw new Error('Google OAuth не вернул токен доступа');
  tokenCache.set(c.client_email, { value: json.access_token, expires: Date.now() + Math.min(3600, Number(json.expires_in) || 3600) * 1000 });
  return json.access_token;
}

async function batchGet(fileId, ranges, token, fetchImpl, label) {
  const params = new URLSearchParams({ valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' });
  for (const range of ranges) params.append('ranges', range);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values:batchGet?${params}`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Чтение Google Sheets: HTTP ${response.status} (${label}). Проверьте доступ сервисного аккаунта.`);
  return (await response.json()).valueRanges || [];
}

const escapeTitle = (name) => name.replaceAll("'", "''");
export async function readTechnicalGoogleSheets({ env = process.env, fetchImpl = fetch } = {}) {
  if (!isGoogleConfigured(env)) throw new Error('Настройте GOOGLE_SERVICE_ACCOUNT_FILE или GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!env.TECH_WORKBOOK_SHEET_ID || !env.TECH_ACCOUNTING_SHEET_ID) {
    throw new Error('Укажите TECH_WORKBOOK_SHEET_ID и TECH_ACCOUNTING_SHEET_ID в .env');
  }
  const c = await credentials(env);
  const token = await accessToken(c, fetchImpl);
  const ranges = TECH_TABS.map((tab) => `'${escapeTitle(tab.title)}'!A1:AF`);
  const [target, accounting] = await Promise.all([
    batchGet(env.TECH_WORKBOOK_SHEET_ID, ranges, token, fetchImpl, 'ДОП.РАБОТЫ'),
    batchGet(env.TECH_ACCOUNTING_SHEET_ID, [`'${escapeTitle(ACCOUNTING_TAB)}'!A1:AJ`], token, fetchImpl, 'бухгалтерия'),
  ]);
  if (target.length !== TECH_TABS.length || !accounting.length)
    throw new Error('Google Sheets вернул неполный список рабочих вкладок');
  const workbook = Object.fromEntries(TECH_TABS.map((tab, i) => [tab.title, target[i]?.values || []]));
  return { workbook, accounting: accounting[0]?.values || [] };
}
