// Standalone: usa apenas APIs nativas do Node.js 22+ (sem npm install)
// - node:http, node:https para HTTP server / cliente
// - node:sqlite (built-in) para persistência
// - Web Crypto API para verificação HMAC
// - sem dependências externas
//
// Mantém toda a lógica de negócio:
// - scrapers de Shopee, Mercado Livre, AliExpress
// - conversores de link de afiliado
// - filtro de nicho 3D + classificador de categoria
// - monitor de grupos concorrentes
// - fila de mensagens + dispatcher para WhatsApp Cloud API
// - PAINEL ADMIN em /admin (HTML único)

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';

// ============ Config ============
const PORT = Number(process.env.PORT ?? 3040);
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const DATA_DIR = process.env.DATA_DIR ?? './data';
const LOG_DIR = process.env.LOG_DIR ?? './logs';
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? './public';

const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID ?? '';
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN ?? '';
const WA_WEBHOOK_VERIFY_TOKEN = process.env.WA_WEBHOOK_VERIFY_TOKEN ?? 'garimpo-3d-verify';
const WA_WEBHOOK_URL = process.env.WA_WEBHOOK_URL ?? '';
const WA_TARGET_GROUPS = (process.env.WA_TARGET_GROUPS ?? '').split(',').map(s => s.trim()).filter(Boolean);

const SHOPEE_AFFILIATE_ID = process.env.SHOPEE_AFFILIATE_ID ?? '';
const ML_AFFILIATE_ID = process.env.ML_AFFILIATE_ID ?? '';
const ALIEXPRESS_TRACKING_ID = process.env.ALIEXPRESS_TRACKING_ID ?? '';

const SCAN_INTERVAL_MIN = Number(process.env.SCAN_INTERVAL_MIN ?? 15);
const MONITOR_INTERVAL_MIN = Number(process.env.MONITOR_INTERVAL_MIN ?? 5);
const MIN_DISCOUNT_PCT = Number(process.env.MIN_DISCOUNT_PCT ?? 20);

// Editáveis em runtime via painel /config/settings (sobrescreve env se houver)
const runtimeConfig = {
  scanIntervalMin: SCAN_INTERVAL_MIN,
  minDiscountPct: MIN_DISCOUNT_PCT,
  dryRun: false,
  port: PORT,
  webhookUrl: WA_WEBHOOK_URL,
};

// Config persistida (afiliados, filtros, connection, runtime settings)
const settingsFile = path.join(DATA_DIR, 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (s.affiliates) {
        if (s.affiliates.shopee && !process.env.SHOPEE_AFFILIATE_ID) env.SHOPEE_AFFILIATE_ID = s.affiliates.shopee;
        if (s.affiliates.mercadolivre && !process.env.ML_AFFILIATE_ID) env.ML_AFFILIATE_ID = s.affiliates.mercadolivre;
        if (s.affiliates.aliexpress && !process.env.ALIEXPRESS_TRACKING_ID) env.ALIEXPRESS_TRACKING_ID = s.affiliates.aliexpress;
      }
      if (s.runtime) Object.assign(runtimeConfig, s.runtime);
    }
  } catch {}
}

const env = { ...process.env };
loadSettings();
function saveSettings() {
  try {
    const cur = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    fs.writeFileSync(settingsFile, JSON.stringify({ ...cur, runtime: runtimeConfig }, null, 2));
  } catch (e) {
    error('boot', 'falha ao salvar settings.json', { err: e.message });
  }
}

// ============ Setup dirs & logger ============
for (const d of [DATA_DIR, LOG_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const ERR_FILE = path.join(LOG_DIR, 'error.log');

function log(level, component, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'garimpeiro-3d',
    env: NODE_ENV,
    component,
    msg,
    ...fields,
  };
  const line = JSON.stringify(entry) + '\n';
  try { process.stdout.write(line); } catch {}
  try {
    fs.appendFileSync(LOG_FILE, line);
    if (level === 'error' || level === 'fatal') fs.appendFileSync(ERR_FILE, line);
  } catch {}
}

const info = (c, m, f = {}) => log('info', c, m, f);
const warn = (c, m, f = {}) => log('warn', c, m, f);
const error = (c, m, f = {}) => log('error', c, m, f);
const debug = (c, m, f = {}) => log('debug', c, m, f);

// ============ Nicho 3D (palavras-chave) ============
const DEFAULT_INCLUDE = [
  'filamento','pla','petg','abs','tpu','nylon','asa','pc','pva','hips','flex','wood','silk','marble','glow',
  'impressora 3d','impressora 3 d','ender 3','creality','bambulab','prusa','anycubic','elegoo','voron','klipper',
  'mk4','p1s','a1 mini','a1','saturn','mars','photon',
  'placa fria','pei sheet','pei textured','build plate','buildtak','magigoo','cola 3d','cola bastao','adesivo 3d',
  'resina','resin','water washable','abs-like','tough resin',
  'hotend','nozzle','bico','extrusor','extruder','bowden','direct drive','stepper','motor de passo','correia gt2',
  'polia','trilho','linear rail','fuso','leadscrew','termistor','thermistor','aquecedor','heater','bed heater',
  'mk3','mk8','e3d','bltouch','cr touch','auto level','octopus','skr','btt','manta','mks','rambo','ramps',
  'display lcd','tela lcd 3d','fep','ndfeb','release film','uv curing','lavadora de resina','cure',
  'impressao 3d','3d print','world 3d','licer','cura','prusaslicer','world3d',
];
const DEFAULT_EXCLUDE = ['boneca','lego compativel','action figure','pelucia','capa de celular','capinha celular'];
const CATEGORY_MAP = [
  ['filamento',   ['filamento','pla ','petg','abs ','tpu','nylon','asa ','flex','wood ']],
  ['impressora',  ['impressora 3d','ender','creality','bambulab','prusa','anycubic','elegoo','voron','saturn','mars','photon']],
  ['placa-fria',  ['placa fria','pei ','buildtak','magigoo','build plate']],
  ['cola',        ['cola 3d','cola bastao','adesivo 3d']],
  ['ferramenta',  ['alic','chave','kit ferramentas','desengripante','pinca','tesoura']],
  ['peca',        ['hotend','nozzle','bico','extrusor','extruder','bowden','stepper','correia','trilho','fuso','termistor','aquecedor','bltouch','skr','btt','octopus','manta','fep','ndfeb']],
  ['resina',      ['resina','resin','water washable','abs-like']],
  ['eletronica',  ['display lcd','tela lcd','rambo','ramps','klipper']],
  ['software',    ['licer','cura','prusaslicer']],
  ['acessorio',   ['capa impressora','suporte filamento','spool holder','drybox']],
];

const STOPWORDS = new Set([
  'de','da','do','para','com','sem','kit','pacote','novo','nova','original',
  'promocao','oferta','a','o','e','em','the','and','for',
]);

// Carregar filtros do settings.json (se houver)
let nicheInclude = [...DEFAULT_INCLUDE];
let nicheExclude = [...DEFAULT_EXCLUDE];
function loadFilters() {
  try {
    if (fs.existsSync(settingsFile)) {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (s.filters?.include?.length) nicheInclude = s.filters.include;
      if (s.filters?.exclude?.length) nicheExclude = s.filters.exclude;
    }
  } catch {}
}
loadFilters();

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function extractKeywords(title) {
  return normalize(title)
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function isNicheMatch(title) {
  const t = normalize(title);
  for (const ex of nicheExclude) {
    if (t.includes(normalize(ex))) return { match: false, hits: [] };
  }
  const hits = [];
  for (const kw of nicheInclude) {
    if (t.includes(normalize(kw))) hits.push(kw);
  }
  return { match: hits.length > 0, hits };
}

function classifyCategory(title) {
  const t = normalize(title);
  for (const [cat, kws] of CATEGORY_MAP) {
    for (const kw of kws) {
      if (t.includes(normalize(kw).trim())) return cat;
    }
  }
  return 'outro';
}

function calcDiscount(original, current) {
  if (original <= 0 || current <= 0) return 0;
  if (current >= original) return 0;
  return Math.round(((original - current) / original) * 1000) / 10;
}

// ============ Conversores de afiliado ============
function detectMarketplace(url) {
  if (/shopee\.com\.br|shopee\.com\.my|shopee\.co\.id/i.test(url)) return 'shopee';
  if (/mercadolivre\.com\.br|mercadolivre\.com|mlb/i.test(url)) return 'mercadolivre';
  if (/aliexpress\.com|ali\.pub|a\.aliexpress\.com/i.test(url)) return 'aliexpress';
  return 'unknown';
}

function convertToAffiliate(url, marketplace) {
  if (!marketplace) marketplace = detectMarketplace(url);
  if (marketplace === 'unknown') return url;
  try {
    const u = new URL(url);
    if (marketplace === 'shopee' && env.SHOPEE_AFFILIATE_ID) {
      u.searchParams.set('af_id', env.SHOPEE_AFFILIATE_ID);
      u.searchParams.set('utm_source', `an_${env.SHOPEE_AFFILIATE_ID}`);
      u.searchParams.set('utm_medium', 'affiliate');
      u.searchParams.set('utm_campaign', 'garimpo-3d');
    } else if (marketplace === 'mercadolivre' && env.ML_AFFILIATE_ID) {
      u.searchParams.set('matt_tool', '87448605');
      u.searchParams.set('matt_word', env.ML_AFFILIATE_ID);
      u.searchParams.set('matt_campaign', 'garimpo-3d');
    } else if (marketplace === 'aliexpress' && env.ALIEXPRESS_TRACKING_ID) {
      if (!u.searchParams.has('af')) u.searchParams.set('af', env.ALIEXPRESS_TRACKING_ID);
      u.searchParams.set('utm_source', `an_${env.ALIEXPRESS_TRACKING_ID}`);
      u.searchParams.set('utm_medium', 'affiliate');
      u.searchParams.set('utm_campaign', 'garimpo-3d');
      u.searchParams.set('dp', env.ALIEXPRESS_TRACKING_ID);
    }
    return u.toString();
  } catch {
    return url;
  }
}

// ============ HTTP client (nativo) ============
function httpRequest(method, urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Garimpo3D/1.0)',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        ...(options.headers ?? {}),
      },
      timeout: options.timeoutMs ?? 15000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
        json: () => { try { return JSON.parse(body); } catch { return null; } },
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ============ Banco SQLite ============
const dbPath = path.join(DATA_DIR, 'garimpo.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = DELETE;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace TEXT NOT NULL,
    external_id TEXT NOT NULL,
    url TEXT NOT NULL,
    affiliate_url TEXT,
    title TEXT NOT NULL,
    image_url TEXT,
    price_original INTEGER NOT NULL,
    price_current INTEGER NOT NULL,
    currency TEXT NOT NULL,
    seller TEXT,
    rating REAL,
    reviews_count INTEGER,
    discount_pct REAL,
    category TEXT,
    keywords TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    sent_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(marketplace, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_offers_marketplace ON offers(marketplace);
  CREATE INDEX IF NOT EXISTS idx_offers_first_seen ON offers(first_seen_at);

  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace TEXT NOT NULL,
    code TEXT NOT NULL,
    description TEXT NOT NULL,
    discount_pct REAL,
    expires_at TEXT,
    url TEXT,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    sent_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(marketplace, code, source)
  );

  CREATE TABLE IF NOT EXISTS monitor_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    whatsapp_group_id TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen_message_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS target_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    whatsapp_group_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER,
    coupon_id INTEGER,
    target_groups TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    scheduled_for TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages_queue(status);

  CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace TEXT NOT NULL,
    scanned INTEGER NOT NULL,
    filtered INTEGER NOT NULL,
    duplicates INTEGER NOT NULL,
    saved INTEGER NOT NULL,
    errors INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    started_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seen_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_group_id INTEGER NOT NULL,
    whatsapp_message_id TEXT NOT NULL UNIQUE,
    seen_at TEXT NOT NULL,
    FOREIGN KEY (monitor_group_id) REFERENCES monitor_groups(id) ON DELETE CASCADE
  );
`);

// Migração leve: criar target_groups se não existia
try { db.exec(`CREATE TABLE IF NOT EXISTS target_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, whatsapp_group_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);`); } catch {}
// Migração: garantir colunas extras em monitor_groups
try { db.exec(`ALTER TABLE monitor_groups ADD COLUMN notes TEXT`); } catch {}

// ============ DB helpers ============
function upsertOfferStmt() {
  return db.prepare(`
    INSERT INTO offers (
      marketplace, external_id, url, affiliate_url, title, image_url,
      price_original, price_current, currency, seller, rating, reviews_count,
      discount_pct, category, keywords, first_seen_at, last_seen_at
    ) VALUES (
      @marketplace, @external_id, @url, @affiliate_url, @title, @image_url,
      @price_original, @price_current, @currency, @seller, @rating, @reviews_count,
      @discount_pct, @category, @keywords, @first_seen_at, @last_seen_at
    )
    ON CONFLICT(marketplace, external_id) DO UPDATE SET
      url = excluded.url, affiliate_url = excluded.affiliate_url, title = excluded.title,
      image_url = excluded.image_url, price_original = excluded.price_original,
      price_current = excluded.price_current, seller = excluded.seller, rating = excluded.rating,
      reviews_count = excluded.reviews_count, discount_pct = excluded.discount_pct,
      category = excluded.category, keywords = excluded.keywords,
      last_seen_at = excluded.last_seen_at
  `);
}

function upsertOffer(raw, normalized) {
  const now = raw.fetchedAt.toISOString();
  const result = upsertOfferStmt().run({
    marketplace: raw.marketplace, external_id: raw.externalId, url: raw.url,
    affiliate_url: normalized.affiliateUrl, title: raw.title,
    image_url: raw.imageUrl ?? null, price_original: raw.priceOriginal,
    price_current: raw.priceCurrent, currency: raw.currency, seller: raw.seller ?? null,
    rating: raw.rating ?? null, reviews_count: raw.reviewsCount ?? null,
    discount_pct: normalized.discountPct, category: normalized.category,
    keywords: normalized.keywords.join(','), first_seen_at: now, last_seen_at: now,
  });
  const row = db.prepare(`SELECT id FROM offers WHERE marketplace = ? AND external_id = ?`)
    .get(raw.marketplace, raw.externalId);
  const inserted = row && Number(row.id) === Number(result.lastInsertRowid);
  return { id: Number(result.lastInsertRowid), inserted };
}

function isOfferSent(marketplace, externalId) {
  const row = db.prepare(`SELECT sent_count FROM offers WHERE marketplace = ? AND external_id = ?`)
    .get(marketplace, externalId);
  return row && row.sent_count > 0;
}
function markOfferSent(id) { db.prepare(`UPDATE offers SET sent_count = sent_count + 1 WHERE id = ?`).run(id); }

function upsertCouponStmt() {
  return db.prepare(`
    INSERT INTO coupons (marketplace, code, description, discount_pct, expires_at, url, source, fetched_at)
    VALUES (@marketplace, @code, @description, @discount_pct, @expires_at, @url, @source, @fetched_at)
    ON CONFLICT(marketplace, code, source) DO UPDATE SET
      description = excluded.description, discount_pct = excluded.discount_pct,
      expires_at = excluded.expires_at, url = excluded.url, fetched_at = excluded.fetched_at
  `);
}
function upsertCoupon(c) {
  const result = upsertCouponStmt().run({
    marketplace: c.marketplace, code: c.code, description: c.description,
    discount_pct: c.discountPct ?? null, expires_at: c.expiresAt ? c.expiresAt.toISOString() : null,
    url: c.url ?? null, source: c.source, fetched_at: c.fetchedAt.toISOString(),
  });
  const row = db.prepare(`SELECT id FROM coupons WHERE marketplace = ? AND code = ? AND source = ?`)
    .get(c.marketplace, c.code, c.source);
  return { id: Number(result.lastInsertRowid), inserted: row && Number(row.id) === Number(result.lastInsertRowid) };
}
function markCouponSent(id) { db.prepare(`UPDATE coupons SET sent_count = sent_count + 1 WHERE id = ?`).run(id); }

function enqueueMessage(msg) {
  const result = db.prepare(`
    INSERT INTO messages_queue (offer_id, coupon_id, target_groups, payload, status, attempts, scheduled_for)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.offerId ?? null, msg.couponId ?? null, JSON.stringify(msg.whatsappGroupIds),
    msg.payload, msg.status, msg.attempts, msg.scheduledFor.toISOString()
  );
  return Number(result.lastInsertRowid);
}

function getPendingMessages(limit = 20) {
  return db.prepare(`SELECT * FROM messages_queue WHERE status = 'pending' AND scheduled_for <= ?
                     ORDER BY scheduled_for ASC LIMIT ?`).all(new Date().toISOString(), limit);
}
function markMessageSent(id) { db.prepare(`UPDATE messages_queue SET status = 'sent', sent_at = ? WHERE id = ?`).run(new Date().toISOString(), id); }
function markMessageFailed(id, err) { db.prepare(`UPDATE messages_queue SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`).run(err, id); }
function requeueMessage(id, delayMs) {
  const t = new Date(Date.now() + delayMs).toISOString();
  db.prepare(`UPDATE messages_queue SET status = 'pending', attempts = attempts + 1, scheduled_for = ? WHERE id = ?`).run(t, id);
}

// Target groups
function listTargetGroups() { return db.prepare(`SELECT * FROM target_groups ORDER BY created_at DESC`).all(); }
function addTargetGroup(gid) {
  db.prepare(`INSERT INTO target_groups (whatsapp_group_id, created_at) VALUES (?, ?)
              ON CONFLICT(whatsapp_group_id) DO NOTHING`).run(gid, new Date().toISOString());
  return db.prepare(`SELECT * FROM target_groups WHERE whatsapp_group_id = ?`).get(gid);
}
function removeTargetGroup(id) { db.prepare(`DELETE FROM target_groups WHERE id = ?`).run(id); }

// Monitor groups
function addMonitorGroup(name, gid) {
  db.prepare(`INSERT INTO monitor_groups (name, whatsapp_group_id, created_at) VALUES (?, ?, ?)
              ON CONFLICT(whatsapp_group_id) DO UPDATE SET name = excluded.name`)
    .run(name, gid, new Date().toISOString());
  return db.prepare(`SELECT * FROM monitor_groups WHERE whatsapp_group_id = ?`).get(gid);
}
function listMonitorGroups(enabledOnly = true) {
  return enabledOnly
    ? db.prepare(`SELECT * FROM monitor_groups WHERE enabled = 1`).all()
    : db.prepare(`SELECT * FROM monitor_groups`).all();
}
function toggleMonitorGroup(id, enabled) { db.prepare(`UPDATE monitor_groups SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id); }
function removeMonitorGroup(id) { db.prepare(`DELETE FROM monitor_groups WHERE id = ?`).run(id); }
function updateMonitorGroupLastSeen(id) { db.prepare(`UPDATE monitor_groups SET last_seen_message_at = ? WHERE id = ?`).run(new Date().toISOString(), id); }
function isMonitorMessageSeen(msgId) { return !!db.prepare(`SELECT 1 FROM seen_messages WHERE whatsapp_message_id = ?`).get(msgId); }
function recordMonitorMessage(monitorGroupId, msgId) {
  db.prepare(`INSERT OR IGNORE INTO seen_messages (monitor_group_id, whatsapp_message_id, seen_at) VALUES (?, ?, ?)`)
    .run(monitorGroupId, msgId, new Date().toISOString());
}

function recordScanRun(s) {
  db.prepare(`INSERT INTO scan_runs (marketplace, scanned, filtered, duplicates, saved, errors, duration_ms, started_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.marketplace, s.scanned, s.filtered, s.duplicates, s.saved, s.errors, s.durationMs, s.startedAt);
}

function getStats() {
  return {
    offers: db.prepare(`SELECT COUNT(*) as total, SUM(sent_count) as sent FROM offers`).get(),
    coupons: db.prepare(`SELECT COUNT(*) as total, SUM(sent_count) as sent FROM coupons`).get(),
    byMarketplace: db.prepare(`SELECT marketplace, COUNT(*) as total FROM offers GROUP BY marketplace`).all(),
    monitorGroups: db.prepare(`SELECT COUNT(*) as total FROM monitor_groups WHERE enabled = 1`).get(),
    targetGroups: db.prepare(`SELECT COUNT(*) as total FROM target_groups`).get(),
    pendingQueue: db.prepare(`SELECT COUNT(*) as total FROM messages_queue WHERE status = 'pending'`).get(),
    lastRuns: db.prepare(`SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 10`).all(),
    wa: getWaSummary(),
    affiliates: getAffiliatesSummary(),
  };
}

function getWaSummary() {
  const configured = !!(env.WA_PHONE_NUMBER_ID && env.WA_ACCESS_TOKEN);
  return {
    configured,
    phoneId: env.WA_PHONE_NUMBER_ID || '',
    tokenSet: !!env.WA_ACCESS_TOKEN,
    tokenSuffix: env.WA_ACCESS_TOKEN ? env.WA_ACCESS_TOKEN.slice(-6) : '',
    verifyToken: env.WA_WEBHOOK_VERIFY_TOKEN,
    webhookUrl: runtimeConfig.webhookUrl || '',
    targetGroupsCount: WA_TARGET_GROUPS.length,
  };
}

function getAffiliatesSummary() {
  return {
    shopee: env.SHOPEE_AFFILIATE_ID ? '••••' + env.SHOPEE_AFFILIATE_ID.slice(-4) : '',
    mercadolivre: env.ML_AFFILIATE_ID ? '••••' + env.ML_AFFILIATE_ID.slice(-4) : '',
    aliexpress: env.ALIEXPRESS_TRACKING_ID ? '••••' + env.ALIEXPRESS_TRACKING_ID.slice(-4) : '',
    shopeeSet: !!env.SHOPEE_AFFILIATE_ID,
    mlSet: !!env.ML_AFFILIATE_ID,
    aliSet: !!env.ALIEXPRESS_TRACKING_ID,
  };
}

// ============ Formatters ============
const CATEGORY_EMOJI = {
  filamento: '🧵', impressora: '🖨️', 'placa-fria': '🧊', cola: '🧴',
  ferramenta: '🔧', peca: '⚙️', resina: '💧', eletronica: '💡',
  software: '💻', acessorio: '🎁', outro: '🛒',
};

function fmtMoney(cents, currency = 'BRL') {
  const value = cents / 100;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value);
}

function formatOfferMessage(o) {
  const lines = [];
  const cat = o.category ?? 'outro';
  lines.push(`${CATEGORY_EMOJI[cat] ?? '🛒'} *${o.title}*`);
  lines.push('');
  lines.push(`💸 De *${fmtMoney(o.priceOriginal, o.currency)}* por *${fmtMoney(o.priceCurrent, o.currency)}* (-${o.discountPct}%)`);
  if (o.rating && o.reviewsCount) lines.push(`⭐ ${(o.rating).toFixed(1)} (${o.reviewsCount})`);
  if (o.seller) lines.push(`🏪 ${o.seller}`);
  lines.push('');
  lines.push(`🛒 ${(o.marketplace ?? '').toUpperCase()}`);
  lines.push(`🔗 ${o.affiliateUrl}`);
  if (o.imageUrl) lines.push(`🖼️ ${o.imageUrl}`);
  lines.push('');
  lines.push('🔥 *Garimpo 3D — As melhores ofertas do mundo da impressão 3D!*');
  return lines.join('\n');
}

function formatCouponMessage(c) {
  const lines = [];
  lines.push('🎟️ *CUPOM DESCOBERTO!*');
  lines.push('');
  lines.push(`*${c.code}*`);
  lines.push(c.description);
  if (c.discountPct) lines.push(`📉 ${c.discountPct}% OFF`);
  if (c.expiresAt) lines.push(`⏰ Válido até ${new Date(c.expiresAt).toLocaleDateString('pt-BR')}`);
  if (c.url) lines.push(`🔗 ${c.url}`);
  lines.push('');
  lines.push('🔥 *Garimpo 3D — Cupons fresquinhos pra você!*');
  return lines.join('\n');
}

// ============ Scraper base ============
const QUERIES = [
  'filamento 3d','impressora 3d','placa fria 3d','kit bico 3d','ender 3','bambulab',
  'filamento pla petg','resina 3d','cola 3d','pecas impressora 3d','magigoo','bltouch',
];

async function runQueries(name, searcher) {
  const startedAt = new Date();
  let scanned = 0, filtered = 0, duplicates = 0, saved = 0, errors = 0;
  const seen = new Set();
  for (const q of QUERIES) {
    try {
      const batch = await searcher(q, 30);
      scanned += batch.length;
      for (const raw of batch) {
        const key = `${raw.marketplace}:${raw.externalId}`;
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);

        const match = isNicheMatch(raw.title);
        if (!match.match) { filtered++; continue; }
        const discount = calcDiscount(raw.priceOriginal, raw.priceCurrent);
        if (discount < runtimeConfig.minDiscountPct) { filtered++; continue; }

        const affiliateUrl = convertToAffiliate(raw.url, raw.marketplace);
        const normalized = {
          ...raw,
          discountPct: discount,
          category: classifyCategory(raw.title),
          keywords: extractKeywords(raw.title),
          affiliateUrl,
        };

        const { inserted, id } = upsertOffer(raw, normalized);
        if (inserted) {
          saved++;
          const payload = formatOfferMessage({
            ...normalized,
            priceOriginal: raw.priceOriginal,
            priceCurrent: raw.priceCurrent,
            currency: raw.currency,
            marketplace: raw.marketplace,
          });
          enqueueMessage({
            offerId: id,
            whatsappGroupIds: WA_TARGET_GROUPS,
            payload, status: 'pending', attempts: 0, scheduledFor: new Date(),
          });
        }
      }
    } catch (e) {
      errors++;
      warn('scraper', `${name}: erro na query "${q}"`, { err: e.message });
    }
  }
  const stats = {
    marketplace: name, scanned, filtered, duplicates, saved, errors,
    durationMs: Date.now() - startedAt.getTime(), startedAt: startedAt.toISOString(),
  };
  recordScanRun(stats);
  info('scraper', `Scan ${name} concluído`, stats);
  return stats;
}

// ============ Scrapers ============
async function shopeeSearch(query, limit) {
  try {
    const resp = await httpRequest('GET',
      `https://shopee.com.br/api/v4/search/search_items?by=relevancy&keyword=${encodeURIComponent(query)}&limit=${limit}&newest=0&order=desc&page_type=search&scenario=page_relevance&version=2`,
      { headers: { 'Referer': 'https://shopee.com.br/', 'X-Requested-With': 'XMLHttpRequest' }, timeoutMs: 12000 },
    );
    if (resp.status >= 400) return [];
    const data = resp.json();
    const items = data?.data?.items ?? [];
    return items.map(it => ({
      marketplace: 'shopee', externalId: String(it.itemid),
      url: `https://shopee.com.br/product/${it.shopid}/${it.itemid}`,
      title: it.title,
      imageUrl: it.image ? `https://cf.shopee.com.br/file/${it.image}` : undefined,
      priceOriginal: Math.round((it.price_before_discount ?? it.price ?? 0) / 10),
      priceCurrent: Math.round((it.price ?? 0) / 10),
      currency: 'BRL', seller: it.shop_name,
      rating: it.item_rating?.rating_star, reviewsCount: it.item_rating?.rating_count,
      fetchedAt: new Date(),
    })).filter(o => o.title && o.externalId);
  } catch { return []; }
}

async function mlSearch(query, limit) {
  try {
    const resp = await httpRequest('GET',
      `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { timeoutMs: 12000 },
    );
    if (resp.status >= 400) return [];
    const data = resp.json();
    const results = data?.results ?? [];
    return results.map(it => ({
      marketplace: 'mercadolivre', externalId: it.id, url: it.permalink,
      title: it.title, imageUrl: it.thumbnail,
      priceOriginal: Math.round((it.original_price ?? it.price ?? 0) * 100),
      priceCurrent: Math.round((it.price ?? 0) * 100),
      currency: it.currency_id || 'BRL', seller: it.seller?.nickname,
      rating: it.reviews?.rating_average, reviewsCount: it.reviews?.total,
      fetchedAt: new Date(),
    })).filter(o => o.title && o.externalId);
  } catch { return []; }
}

async function aliexpressSearch(query, limit) {
  try {
    const resp = await httpRequest('GET',
      `https://pt.aliexpress.com/gw/api/202409/topsearch/items?query=${encodeURIComponent(query)}&pageSize=${limit}&page=1&sort=BEST_MATCH`,
      { headers: { 'Referer': 'https://pt.aliexpress.com/' }, timeoutMs: 12000 },
    );
    if (resp.status >= 400) return [];
    const data = resp.json();
    const items = data?.data?.items ?? [];
    return items.map(it => ({
      marketplace: 'aliexpress', externalId: it.itemId, url: it.productUrl,
      title: it.title, imageUrl: it.imageUrl,
      priceOriginal: Math.round(parseFloat(it.originalPrice?.value ?? it.price?.value ?? '0') * 100),
      priceCurrent: Math.round(parseFloat(it.price?.value ?? '0') * 100),
      currency: it.price?.currency ?? 'USD', seller: it.seller?.name,
      rating: it.rating, reviewsCount: it.reviewsCount,
      fetchedAt: new Date(),
    })).filter(o => o.title && o.externalId);
  } catch { return []; }
}

async function runScanCycle() {
  await runQueries('shopee', shopeeSearch);
  await runQueries('mercadolivre', mlSearch);
  await runQueries('aliexpress', aliexpressSearch);
}

// ============ WhatsApp client ============
async function sendWhatsApp(groupId, text) {
  if (runtimeConfig.dryRun || !env.WA_PHONE_NUMBER_ID || !env.WA_ACCESS_TOKEN) {
    info('whatsapp', '[DRY-RUN] Mensagem', { to: groupId, len: text.length, preview: text.slice(0, 120) });
    return { success: true, messageId: 'dry-run' };
  }
  try {
    const url = `https://graph.facebook.com/v20.0/${env.WA_PHONE_NUMBER_ID}/messages`;
    const resp = await httpRequest('POST', url, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: groupId, type: 'text', text: { body: text, preview_url: true } }),
      timeoutMs: 20000,
    });
    if (resp.status >= 400) {
      const body = resp.json();
      return { success: false, error: body?.error?.message ?? `HTTP ${resp.status}`, httpStatus: resp.status };
    }
    const body = resp.json();
    return { success: true, messageId: body?.messages?.[0]?.id, httpStatus: resp.status };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function dispatchTick() {
  const pending = getPendingMessages(20);
  if (pending.length === 0) return { processed: 0, sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (const row of pending) {
    let groups = [];
    try { groups = JSON.parse(row.target_groups); } catch { groups = WA_TARGET_GROUPS; }
    if (groups.length === 0) { markMessageFailed(row.id, 'no_target_groups'); failed++; continue; }
    const group = groups[0];
    const result = await sendWhatsApp(group, row.payload);
    if (result.success) {
      markMessageSent(row.id);
      if (row.offer_id) markOfferSent(row.offer_id);
      if (row.coupon_id) markCouponSent(row.coupon_id);
      sent++;
      if (groups.length > 1) {
        enqueueMessage({
          offerId: row.offer_id ?? undefined, couponId: row.coupon_id ?? undefined,
          whatsappGroupIds: groups.slice(1), payload: row.payload,
          status: 'pending', attempts: 0, scheduledFor: new Date(),
        });
      }
    } else {
      const transient = (result.httpStatus === 429) || (result.httpStatus >= 500) ||
        /timeout|ECONNRESET|ETIMEDOUT/i.test(result.error ?? '');
      if (transient && row.attempts < 5) {
        requeueMessage(row.id, 60000 * (row.attempts + 1));
        warn('dispatcher', 'Erro transitório — reenfileirando', { id: row.id, err: result.error });
      } else {
        markMessageFailed(row.id, result.error ?? 'unknown');
        failed++;
        error('dispatcher', 'Falha permanente', { id: row.id, err: result.error });
      }
    }
    await wait(2000 + Math.random() * 2000);
  }
  return { processed: pending.length, sent, failed };
}

// ============ Monitor de grupos ============
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const COUPON_RE = /(?:cupom|c[oó]digo|codigo|code|use|usando|com cupom)[:\s]+([A-Z0-9_-]{3,30})/gi;
const PRICE_RE = /R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:[.,]\d{2})?)/gi;

function extractUrls(text) { return Array.from(text.match(URL_RE) ?? []).map(u => u.replace(/[).,]+$/, '')); }
function extractCoupons(text) {
  const out = [];
  let m;
  COUPON_RE.lastIndex = 0;
  while ((m = COUPON_RE.exec(text)) !== null) {
    const code = m[1].toUpperCase();
    const desc = text.slice(Math.max(0, m.index - 60), m.index + 80).trim();
    out.push({ code, description: desc });
  }
  return out;
}
function extractPrices(text) { return Array.from(text.matchAll(PRICE_RE)).map(m => parseBrazilianPrice(m[1])); }
function parseBrazilianPrice(s) { const cleaned = s.replace(/\./g, '').replace(',', '.'); return parseFloat(cleaned) || 0; }
function detectMarketplaceFromText(text) {
  if (/shopee/i.test(text)) return 'shopee';
  if (/mercado\s*livre|mercadolivre|mlb/i.test(text)) return 'mercadolivre';
  if (/aliexpress/i.test(text)) return 'aliexpress';
  return 'unknown';
}
function extractTitle(text, url) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.includes(url)) continue;
    if (line.length < 10) continue;
    if (/^R\$/i.test(line)) continue;
    if (/^(cupom|c[oó]digo|codigo|use|usando)[:\s]/i.test(line)) continue;
    return line.slice(0, 200);
  }
  return url;
}
function extractExternalId(url, marketplace) {
  try {
    if (marketplace === 'shopee') { const m = url.match(/i\.\d+\.(\d+)/) ?? url.match(/product\/\d+\/(\d+)/); return m?.[1] ?? null; }
    if (marketplace === 'mercadolivre') { const m = url.match(/MLB-?(\d+)/); return m?.[1] ?? null; }
    if (marketplace === 'aliexpress') { const m = url.match(/item\/(\d+)\.html/); return m?.[1] ?? null; }
    return null;
  } catch { return null; }
}

async function onGroupMessage(msg) {
  if (msg.fromMe) return;
  const monitors = listMonitorGroups(true);
  const monitor = monitors.find(m => m.whatsapp_group_id === msg.whatsappGroupId);
  if (!monitor) return;
  if (isMonitorMessageSeen(msg.whatsappMessageId)) return;

  recordMonitorMessage(monitor.id, msg.whatsappMessageId);
  updateMonitorGroupLastSeen(monitor.id);

  const urls = extractUrls(msg.text);
  const coupons = extractCoupons(msg.text);

  info('monitor', 'Mensagem do grupo', { group: monitor.name, urls: urls.length, coupons: coupons.length });

  for (const url of urls) await processUrlFromGroup(url, msg, monitor.id);
  for (const c of coupons) await processCouponFromGroup(c, msg);
}

async function processUrlFromGroup(url, msg, monitorGroupId) {
  const marketplace = detectMarketplace(url);
  if (marketplace === 'unknown') return;
  const match = isNicheMatch(msg.text);
  if (!match.match) return;
  const externalId = extractExternalId(url, marketplace);
  if (!externalId) return;
  if (isOfferSent(marketplace, externalId)) return;

  const affiliateUrl = convertToAffiliate(url, marketplace);
  const title = extractTitle(msg.text, url);
  const prices = extractPrices(msg.text);
  const priceCurrent = prices[0] ?? 0;
  const priceOriginal = prices[1] ?? priceCurrent;

  const raw = {
    marketplace, externalId, url, title,
    priceOriginal: Math.round(priceOriginal * 100),
    priceCurrent: Math.round(priceCurrent * 100),
    currency: 'BRL', fetchedAt: new Date(),
  };
  const discount = calcDiscount(raw.priceOriginal, raw.priceCurrent);
  if (discount < runtimeConfig.minDiscountPct) return;
  const normalized = {
    ...raw, discountPct: discount, category: classifyCategory(raw.title),
    keywords: extractKeywords(raw.title), affiliateUrl,
  };
  const { id, inserted } = upsertOffer(raw, normalized);
  if (!inserted) return;
  const payload = formatOfferMessage({
    ...normalized, priceOriginal: raw.priceOriginal, priceCurrent: raw.priceCurrent,
    currency: raw.currency, marketplace: raw.marketplace,
  });
  enqueueMessage({
    offerId: id, whatsappGroupIds: WA_TARGET_GROUPS, payload,
    status: 'pending', attempts: 0, scheduledFor: new Date(),
  });
}

async function processCouponFromGroup(coupon, msg) {
  const marketplace = detectMarketplaceFromText(msg.text);
  const saved = upsertCoupon({
    marketplace, code: coupon.code, description: coupon.description,
    source: 'monitor', fetchedAt: new Date(),
  });
  if (!saved.inserted) return;
  const payload = formatCouponMessage({ marketplace, code: coupon.code, description: coupon.description });
  enqueueMessage({
    couponId: saved.id, whatsappGroupIds: WA_TARGET_GROUPS, payload,
    status: 'pending', attempts: 0, scheduledFor: new Date(),
  });
}

// ============ Log parser ============
function parseLogLine(line) {
  try {
    const j = JSON.parse(line);
    return {
      ts: j.ts, level: j.level || 'info', component: j.component || '',
      msg: j.msg || '', fields: Object.fromEntries(Object.entries(j).filter(([k]) =>
        !['ts','level','service','env','component','msg'].includes(k))),
    };
  } catch {
    return { ts: new Date().toISOString(), level: 'info', component: '', msg: line, fields: {} };
  }
}
function tailLines(filePath, max = 200) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf8');
    return data.split('\n').filter(Boolean).slice(-max);
  } catch { return []; }
}

// ============ HTTP server ============
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

function serveStaticFile(req, res, relativePath) {
  // relativePath chega já validado; resolve dentro de PUBLIC_DIR
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) return sendText(res, 403, 'forbidden');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendText(res, 404, 'not found: ' + relativePath);
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': getContentType(filePath), 'Content-Length': data.length });
    res.end(data);
  } catch (e) {
    sendText(res, 500, 'error: ' + e.message);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // ============ GET / (index) ============
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStaticFile(req, res, 'admin.html');
    }

    // ============ GET /admin ============
    if (req.method === 'GET' && url.pathname === '/admin') {
      return serveStaticFile(req, res, 'admin.html');
    }

    // ============ Static files ============
    if (req.method === 'GET' && url.pathname.startsWith('/public/')) {
      return serveStaticFile(req, res, url.pathname.replace('/public/', ''));
    }

    // ============ GET /webhook (Meta verification) ============
    if (req.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.WA_WEBHOOK_VERIFY_TOKEN) {
        info('webhook', 'Verificado pelo Meta');
        return sendText(res, 200, challenge ?? '');
      }
      return sendText(res, 403, 'forbidden');
    }

    // ============ POST /webhook (incoming WA messages) ============
    if (req.method === 'POST' && url.pathname === '/webhook') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      const raw = await readBody(req);
      try {
        const payload = JSON.parse(raw);
        const entries = payload?.entry ?? [];
        for (const entry of entries) {
          const changes = entry?.changes ?? [];
          for (const change of changes) {
            const value = change?.value;
            const messages = value?.messages ?? [];
            for (const m of messages) {
              const from = m.from;
              if (!from || !from.endsWith('@g.us')) continue;
              const text = m.text?.body ?? m.caption ?? m.button?.text ?? '';
              if (!text) continue;
              await onGroupMessage({
                whatsappGroupId: from, whatsappMessageId: m.id, text,
                fromMe: !!m.from_me, receivedAt: new Date(),
              });
            }
          }
        }
      } catch (e) {
        error('webhook', 'Erro processando payload', { err: e.message });
      }
      return;
    }

    // ============ GET /health ============
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true, service: 'garimpeiro-3d', env: NODE_ENV, port: PORT,
        uptime: Math.round(process.uptime()), timestamp: new Date().toISOString(),
      });
    }

    // ============ GET /stats ============
    if (req.method === 'GET' && url.pathname === '/stats') {
      return sendJson(res, 200, getStats());
    }

    // ============ GET /config ============
    if (req.method === 'GET' && url.pathname === '/config') {
      return sendJson(res, 200, {
        filters: { include: nicheInclude, exclude: nicheExclude },
        config: {
          scanIntervalMin: runtimeConfig.scanIntervalMin,
          minDiscountPct: runtimeConfig.minDiscountPct,
          dryRun: runtimeConfig.dryRun,
          port: runtimeConfig.port,
          webhookUrl: runtimeConfig.webhookUrl,
        },
        affiliates: {
          shopee: env.SHOPEE_AFFILIATE_ID || '',
          mercadolivre: env.ML_AFFILIATE_ID || '',
          aliexpress: env.ALIEXPRESS_TRACKING_ID || '',
        },
      });
    }

    // ============ POST /config/connection ============
    if (req.method === 'POST' && url.pathname === '/config/connection') {
      const body = JSON.parse(await readBody(req));
      if (body.phoneNumberId) env.WA_PHONE_NUMBER_ID = body.phoneNumberId;
      if (body.accessToken) env.WA_ACCESS_TOKEN = body.accessToken;
      if (body.verifyToken) env.WA_WEBHOOK_VERIFY_TOKEN = body.verifyToken;
      if (body.webhookUrl !== undefined) {
        runtimeConfig.webhookUrl = body.webhookUrl;
        env.WA_WEBHOOK_URL = body.webhookUrl;
        saveSettings();
      }
      // Persistir em .env-like
      try {
        const envFile = path.join(process.cwd(), '.env.runtime');
        const lines = [
          `WA_PHONE_NUMBER_ID=${env.WA_PHONE_NUMBER_ID}`,
          `WA_ACCESS_TOKEN=${env.WA_ACCESS_TOKEN}`,
          `WA_WEBHOOK_VERIFY_TOKEN=${env.WA_WEBHOOK_VERIFY_TOKEN}`,
          `WA_WEBHOOK_URL=${runtimeConfig.webhookUrl}`,
        ];
        fs.writeFileSync(envFile, lines.join('\n'));
      } catch (e) { warn('admin', 'Falha ao persistir .env.runtime', { err: e.message }); }
      info('admin', 'Conexão WA atualizada');
      return sendJson(res, 200, { ok: true });
    }

    // ============ POST /config/test-wa ============
    if (req.method === 'POST' && url.pathname === '/config/test-wa') {
      if (!env.WA_PHONE_NUMBER_ID || !env.WA_ACCESS_TOKEN) {
        return sendJson(res, 400, { ok: false, error: 'credenciais não configuradas' });
      }
      try {
        const r = await httpRequest('GET', `https://graph.facebook.com/v20.0/${env.WA_PHONE_NUMBER_ID}`, {
          headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` }, timeoutMs: 10000,
        });
        const ok = r.status >= 200 && r.status < 300;
        return sendJson(res, ok ? 200 : 500, { ok, status: r.status, body: r.json() });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // ============ POST /config/affiliates ============
    if (req.method === 'POST' && url.pathname === '/config/affiliates') {
      const body = JSON.parse(await readBody(req));
      const cur = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
      cur.affiliates = {
        shopee: (body.shopee ?? '').trim(),
        mercadolivre: (body.mercadolivre ?? '').trim(),
        aliexpress: (body.aliexpress ?? '').trim(),
      };
      fs.writeFileSync(settingsFile, JSON.stringify(cur, null, 2));
      if (cur.affiliates.shopee) env.SHOPEE_AFFILIATE_ID = cur.affiliates.shopee;
      if (cur.affiliates.mercadolivre) env.ML_AFFILIATE_ID = cur.affiliates.mercadolivre;
      if (cur.affiliates.aliexpress) env.ALIEXPRESS_TRACKING_ID = cur.affiliates.aliexpress;
      info('admin', 'Afiliados atualizados');
      return sendJson(res, 200, { ok: true });
    }

    // ============ POST /config/filters ============
    if (req.method === 'POST' && url.pathname === '/config/filters') {
      const body = JSON.parse(await readBody(req));
      nicheInclude = body.include ?? nicheInclude;
      nicheExclude = body.exclude ?? nicheExclude;
      const cur = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
      cur.filters = { include: nicheInclude, exclude: nicheExclude };
      fs.writeFileSync(settingsFile, JSON.stringify(cur, null, 2));
      info('admin', 'Filtros atualizados', { include: nicheInclude.length, exclude: nicheExclude.length });
      return sendJson(res, 200, { ok: true });
    }

    // ============ POST /config/settings ============
    if (req.method === 'POST' && url.pathname === '/config/settings') {
      const body = JSON.parse(await readBody(req));
      if (typeof body.scanIntervalMin === 'number') runtimeConfig.scanIntervalMin = body.scanIntervalMin;
      if (typeof body.minDiscountPct === 'number') runtimeConfig.minDiscountPct = body.minDiscountPct;
      if (typeof body.dryRun === 'boolean') runtimeConfig.dryRun = body.dryRun;
      if (typeof body.port === 'number') runtimeConfig.port = body.port;
      if (typeof body.webhookUrl === 'string') runtimeConfig.webhookUrl = body.webhookUrl;
      saveSettings();
      // Reinicia timers se intervalo mudou
      restartTimers();
      info('admin', 'Configurações operacionais atualizadas', runtimeConfig);
      return sendJson(res, 200, { ok: true });
    }

    // ============ Target groups ============
    if (req.method === 'GET' && url.pathname === '/target-groups') {
      return sendJson(res, 200, { groups: listTargetGroups() });
    }
    if (req.method === 'POST' && url.pathname === '/target-groups') {
      const body = JSON.parse(await readBody(req));
      if (!body.whatsappGroupId) return sendJson(res, 400, { error: 'whatsappGroupId required' });
      const g = addTargetGroup(body.whatsappGroupId);
      // atualizar lista em memória também
      if (!WA_TARGET_GROUPS.includes(body.whatsappGroupId)) WA_TARGET_GROUPS.push(body.whatsappGroupId);
      info('admin', 'Grupo alvo adicionado', { id: g?.id });
      return sendJson(res, 201, g);
    }
    const tgMatch = url.pathname.match(/^\/target-groups\/(\d+)$/);
    if (req.method === 'DELETE' && tgMatch) {
      const id = Number(tgMatch[1]);
      const g = db.prepare(`SELECT * FROM target_groups WHERE id = ?`).get(id);
      if (g) {
        removeTargetGroup(id);
        const idx = WA_TARGET_GROUPS.indexOf(g.whatsapp_group_id);
        if (idx >= 0) WA_TARGET_GROUPS.splice(idx, 1);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ============ Monitor groups ============
    if (req.method === 'GET' && url.pathname === '/monitor-groups') {
      return sendJson(res, 200, { groups: listMonitorGroups(false) });
    }
    if (req.method === 'POST' && url.pathname === '/monitor-groups') {
      const body = JSON.parse(await readBody(req));
      if (!body.name || !body.whatsappGroupId) return sendJson(res, 400, { error: 'name and whatsappGroupId required' });
      const g = addMonitorGroup(body.name, body.whatsappGroupId);
      info('admin', 'Grupo monitorado adicionado', { id: g?.id });
      return sendJson(res, 201, g);
    }
    const mgMatch = url.pathname.match(/^\/monitor-groups\/(\d+)$/);
    if (req.method === 'PATCH' && mgMatch) {
      const id = Number(mgMatch[1]);
      const body = JSON.parse(await readBody(req));
      if (typeof body.enabled === 'boolean') toggleMonitorGroup(id, body.enabled);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && mgMatch) {
      const id = Number(mgMatch[1]);
      removeMonitorGroup(id);
      return sendJson(res, 200, { ok: true });
    }

    // ============ Offers ============
    if (req.method === 'GET' && url.pathname === '/offers/recent') {
      const hours = Number(url.searchParams.get('hours') ?? 24);
      const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
      const rows = db.prepare(`SELECT id, marketplace, title, price_current, price_original, currency, discount_pct, sent_count, first_seen_at
                               FROM offers WHERE first_seen_at >= ? ORDER BY discount_pct DESC LIMIT 200`).all(cutoff);
      return sendJson(res, 200, { count: rows.length, offers: rows });
    }

    // ============ Coupons ============
    if (req.method === 'GET' && url.pathname === '/coupons/pending') {
      const rows = db.prepare(`SELECT * FROM coupons ORDER BY fetched_at DESC LIMIT 200`).all();
      return sendJson(res, 200, { coupons: rows });
    }

    // ============ Queue ============
    if (req.method === 'GET' && url.pathname === '/queue/pending') {
      const rows = db.prepare(`SELECT id, status, attempts, scheduled_for, target_groups, payload, offer_id, coupon_id
                               FROM messages_queue WHERE status IN ('pending','failed') ORDER BY scheduled_for DESC LIMIT 100`).all();
      const msgs = rows.map(r => {
        let groupCount = 0;
        try { groupCount = JSON.parse(r.target_groups).length; } catch {}
        return { ...r, groupCount };
      });
      return sendJson(res, 200, { messages: msgs });
    }

    // ============ Logs ============
    if (req.method === 'GET' && url.pathname === '/logs') {
      const max = Number(url.searchParams.get('max') ?? 200);
      const lines = tailLines(LOG_FILE, max).map(parseLogLine);
      return sendJson(res, 200, { lines });
    }

    // ============ Admin: backup ============
    if (req.method === 'GET' && url.pathname === '/admin/backup') {
      try {
        const data = fs.readFileSync(dbPath);
        const filename = `garimpo-${Date.now()}.db`;
        res.writeHead(200, {
          'Content-Type': 'application/x-sqlite3',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': data.length,
        });
        return res.end(data);
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ============ Admin: restore ============
    if (req.method === 'POST' && url.pathname === '/admin/restore') {
      // Para upload multipart precisaríamos de parser; aqui aceitamos body binário cru
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const data = Buffer.concat(chunks);
          if (data.length < 100) return sendJson(res, 400, { ok: false, error: 'arquivo inválido' });
          // Backup do atual
          if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, dbPath + '.bak');
          fs.writeFileSync(dbPath, data);
          info('admin', 'Banco restaurado', { bytes: data.length });
          return sendJson(res, 200, { ok: true });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.message });
        }
      });
      return;
    }

    // ============ Admin: reset ============
    if (req.method === 'POST' && url.pathname === '/admin/reset') {
      try {
        const tables = ['offers','coupons','monitor_groups','target_groups','messages_queue','scan_runs','seen_messages'];
        for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
        info('admin', 'Banco resetado');
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // ============ POST /scan ============
    if (req.method === 'POST' && url.pathname === '/scan') {
      info('admin', 'Scan manual iniciado');
      runScanCycle().catch(e => error('scan', 'cycle error', { err: e.message }));
      return sendJson(res, 202, { ok: true, message: 'scan iniciado em background' });
    }

    // ============ POST /dispatch ============
    if (req.method === 'POST' && url.pathname === '/dispatch') {
      const r = await dispatchTick();
      return sendJson(res, 200, r);
    }

    // ============ POST /simulate ============
    if (req.method === 'POST' && url.pathname === '/simulate') {
      const body = JSON.parse(await readBody(req));
      await onGroupMessage({
        whatsappGroupId: body.whatsappGroupId,
        whatsappMessageId: body.whatsappMessageId ?? `sim-${Date.now()}`,
        text: body.text ?? '',
        fromMe: false,
        receivedAt: new Date(),
      });
      return sendJson(res, 200, { ok: true });
    }

    // ============ POST /test-send ============
    if (req.method === 'POST' && url.pathname === '/test-send') {
      const body = JSON.parse(await readBody(req));
      if (!body.groupId || !body.text) return sendJson(res, 400, { error: 'groupId and text required' });
      const result = await sendWhatsApp(body.groupId, body.text);
      return sendJson(res, result.success ? 200 : 500, result);
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    error('http', 'Erro no servidor', { err: e.message });
    sendJson(res, 500, { error: 'internal_error', detail: e.message });
  }
});

// ============ Timers ============
let scanTimer = null;
let dispatchTimer = null;

function restartTimers() {
  if (scanTimer) clearInterval(scanTimer);
  if (dispatchTimer) clearInterval(dispatchTimer);
  scanTimer = setInterval(() => {
    runScanCycle().catch(e => error('scan', 'cycle error', { err: e.message }));
  }, Math.max(1, runtimeConfig.scanIntervalMin) * 60_000);
  dispatchTimer = setInterval(() => {
    dispatchTick().then(r => { if (r.processed > 0) info('dispatcher', 'tick', r); })
      .catch(e => error('dispatcher', 'tick error', { err: e.message }));
  }, 60_000);
}

// ============ Boot ============
async function main() {
  info('boot', '🛸 Garimpeiro 3D iniciando', { port: PORT, env: NODE_ENV });

  server.listen(PORT, '0.0.0.0', () => {
    info('boot', `Webhook WA + Painel em :${PORT}`, { panel: `http://localhost:${PORT}/admin` });
  });

  // Seed: garantir que settings.json existe e target_groups vazio inicial
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ filters: { include: nicheInclude, exclude: nicheExclude } }, null, 2));
  }

  restartTimers();
  setTimeout(() => {
    runScanCycle().catch(e => error('scan', 'initial error', { err: e.message }));
  }, 5000);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      info('boot', 'Encerrando', { signal: sig });
      clearInterval(scanTimer);
      clearInterval(dispatchTimer);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

main().catch(e => {
  error('boot', 'Falha fatal', { err: e.message, stack: e.stack });
  process.exit(1);
});
