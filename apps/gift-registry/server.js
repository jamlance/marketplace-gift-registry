import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, createInkressOrder, getInkressOrder, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";
import { putObject, storageConfigured, decodeDataUrl, isAllowedImage } from "@inkress/apps-core/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[gift-registry] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("gift_registry", `
  CREATE TABLE IF NOT EXISTS registries (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    title TEXT NOT NULL, recipient TEXT, event_date DATE, message TEXT, active BOOLEAN NOT NULL DEFAULT true,
    currency TEXT NOT NULL DEFAULT 'JMD', merchant_name TEXT, merchant_logo TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS items (
    id BIGSERIAL PRIMARY KEY, registry_id BIGINT NOT NULL, merchant_id BIGINT NOT NULL,
    name TEXT NOT NULL, note TEXT, price NUMERIC NOT NULL, qty_wanted INTEGER NOT NULL DEFAULT 1, qty_funded INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'JMD', sort INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS contributions (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, registry_id BIGINT NOT NULL, item_id BIGINT NOT NULL,
    buyer_name TEXT, buyer_email TEXT, message TEXT, amount NUMERIC, currency TEXT, state TEXT NOT NULL DEFAULT 'awaiting',
    ref TEXT, inkress_order_id TEXT, payment_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_gr_items ON items (registry_id, sort, id);
  CREATE INDEX IF NOT EXISTS idx_gr_contribs ON contributions (merchant_id, created_at DESC);
  ALTER TABLE items ADD COLUMN IF NOT EXISTS image_url TEXT;
  ALTER TABLE items ADD COLUMN IF NOT EXISTS source_url TEXT;
  ALTER TABLE registries ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'general';
  ALTER TABLE registries ADD COLUMN IF NOT EXISTS accent TEXT NOT NULL DEFAULT '#b5179e';
  ALTER TABLE registries ADD COLUMN IF NOT EXISTS cover_url TEXT;
  ALTER TABLE items ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'item';
  ALTER TABLE items ADD COLUMN IF NOT EXISTS allow_split BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE items ADD COLUMN IF NOT EXISTS goal_amount NUMERIC;
  ALTER TABLE items ADD COLUMN IF NOT EXISTS raised_amount NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN IF NOT EXISTS product_id TEXT;
  ALTER TABLE contributions ADD COLUMN IF NOT EXISTS thanked BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE contributions ADD COLUMN IF NOT EXISTS thanked_at TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("gift_registry", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
const THEMES = {
  general: { accent: "#b5179e", label: "Classic" },
  wedding: { accent: "#b08968", label: "Wedding" },
  baby: { accent: "#56a3a6", label: "Baby" },
  birthday: { accent: "#e8590c", label: "Birthday" },
  housewarming: { accent: "#2f6f4e", label: "Housewarming" },
  graduation: { accent: "#3b5bdb", label: "Graduation" },
};
const cleanAccent = (s) => (/^#[0-9a-fA-F]{6}$/.test(String(s || "")) ? s : null);

// Effective funding goal for an item (cash funds use goal_amount; gift items default to price × qty).
const itemGoal = (i) => { const g = i.goal_amount != null ? Number(i.goal_amount) : Number(i.price) * Number(i.qty_wanted || 1); return g > 0 ? round2(g) : 0; };
const itemRaised = (i) => round2(i.raised_amount || 0);
const itemFunded = (i) => { const g = itemGoal(i); return g > 0 && itemRaised(i) >= g - 0.01; };
const itemRemaining = (i) => { const g = itemGoal(i); return g > 0 ? Math.max(0, round2(g - itemRaised(i))) : null; };
const isFlexible = (i) => i.kind === "cash" || i.allow_split === true;

async function registryStats(regId) {
  const items = await db.q(`SELECT price, qty_wanted, goal_amount, raised_amount, kind FROM items WHERE registry_id=$1`, [regId]);
  let goal = 0, raised = 0, funded = 0;
  for (const i of items) { const g = itemGoal(i); const r = itemRaised(i); goal += g > 0 ? g : r; raised += g > 0 ? Math.min(r, g) : r; if (itemFunded(i)) funded++; }
  return { items: items.length, goal: round2(goal), raised: round2(raised), funded, pct: goal ? Math.min(100, Math.round((raised / goal) * 100)) : 0 };
}
const serializeReg = (r, stats, req) => ({ id: r.id, title: r.title, recipient: r.recipient, event_date: r.event_date, message: r.message, active: r.active, currency: r.currency, theme: r.theme || "general", accent: r.accent || THEMES.general.accent, cover_url: r.cover_url || null, items: stats?.items || 0, funded: stats?.funded || 0, goal: stats?.goal || 0, raised: stats?.raised || 0, pct: stats?.pct || 0, public_url: `${PUBLIC_BASE(req)}/registry/${r.id}` });
const serializeItem = (i) => ({ id: i.id, registry_id: i.registry_id, name: i.name, note: i.note, image_url: i.image_url, source_url: i.source_url, product_id: i.product_id, kind: i.kind || "item", allow_split: i.allow_split === true, price: Number(i.price), qty_wanted: i.qty_wanted, qty_funded: i.qty_funded, goal: itemGoal(i), raised: itemRaised(i), remaining: itemRemaining(i), funded: itemFunded(i), currency: i.currency });
const cleanUrl = (u) => { const s = String(u || "").trim(); return /^https?:\/\//i.test(s) ? s.slice(0, 2000) : null; };
const serializeContrib = (c) => ({ id: c.id, registry_id: c.registry_id, item_id: c.item_id, buyer_name: c.buyer_name, buyer_email: c.buyer_email, message: c.message, amount: Number(c.amount), currency: c.currency, state: c.state, thanked: c.thanked === true, created_at: c.created_at });

app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try {
      await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) });
      await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid, url };
    } catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), storage: storageConfigured(), can_register: Boolean(canRegister), products: (req.session.scope || []).includes("products:read") });
});

app.get("/api/registries", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM registries WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  const out = []; for (const r of rows) out.push(serializeReg(r, await registryStats(r.id), req));
  res.json({ registries: out, connected: await tokens.hasToken(req.session.merchantId), storage: storageConfigured(), webhook_realtime: Boolean(WEBHOOK_SECRET), themes: Object.entries(THEMES).map(([id, t]) => ({ id, ...t })) });
});
app.post("/api/registries", core.requireSession, async (req, res) => {
  const b = req.body || {}; const m = req.session.data?.merchant || {};
  if (!String(b.title || "").trim()) return res.status(400).json({ error: "bad_input", message: "A registry title is required." });
  const theme = THEMES[b.theme] ? b.theme : "general";
  const accent = cleanAccent(b.accent) || THEMES[theme].accent;
  const row = await db.one(`INSERT INTO registries (merchant_id, title, recipient, event_date, message, currency, merchant_name, merchant_logo, theme, accent, cover_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.session.merchantId, b.title.trim(), b.recipient || null, /^\d{4}-\d{2}-\d{2}$/.test(b.event_date) ? b.event_date : null, b.message || null, m.currency_code || "JMD", m.name || null, m.logo || m.logo_url || null, theme, accent, cleanUrl(b.cover_url)]);
  res.status(201).json({ registry: serializeReg(row, { items: 0 }, req) });
});
app.patch("/api/registries/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const r = await db.one(`SELECT * FROM registries WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!r) return res.status(404).json({ error: "not_found" });
  const theme = b.theme !== undefined ? (THEMES[b.theme] ? b.theme : r.theme) : r.theme;
  const u = await db.one(`UPDATE registries SET title=$1, recipient=$2, event_date=$3, message=$4, active=$5, theme=$6, accent=$7, cover_url=$8 WHERE id=$9 RETURNING *`,
    [b.title ?? r.title, b.recipient ?? r.recipient, b.event_date !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.event_date) ? b.event_date : null) : r.event_date, b.message ?? r.message, b.active != null ? !!b.active : r.active,
      theme, b.accent !== undefined ? (cleanAccent(b.accent) || r.accent) : r.accent, b.cover_url !== undefined ? cleanUrl(b.cover_url) : r.cover_url, r.id]);
  res.json({ registry: serializeReg(u, await registryStats(r.id), req) });
});
app.delete("/api/registries/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM items WHERE registry_id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  await db.run(`DELETE FROM registries WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

app.get("/api/registries/:id/items", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM items WHERE registry_id=$1 AND merchant_id=$2 ORDER BY sort, id`, [req.params.id, req.session.merchantId]);
  res.json({ items: rows.map(serializeItem) });
});
app.post("/api/registries/:id/items", core.requireSession, async (req, res) => {
  const b = req.body || {}; const m = req.session.data?.merchant || {};
  const reg = await db.one(`SELECT * FROM registries WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!reg) return res.status(404).json({ error: "not_found" });
  const kind = b.kind === "cash" ? "cash" : "item";
  if (!String(b.name || "").trim()) return res.status(400).json({ error: "bad_input", message: "A name is required." });
  if (kind === "item" && !(round2(b.price) > 0)) return res.status(400).json({ error: "bad_input", message: "Item name and a price are required." });
  const goal = b.goal_amount != null && round2(b.goal_amount) > 0 ? round2(b.goal_amount) : null;
  if (kind === "cash" && goal == null && !(round2(b.price) > 0)) { /* open-ended cash fund — allowed */ }
  const sortRow = await db.one(`SELECT COALESCE(MAX(sort),0)+1 AS s FROM items WHERE registry_id=$1`, [reg.id]);
  const row = await db.one(`INSERT INTO items (registry_id, merchant_id, name, note, image_url, source_url, product_id, kind, allow_split, goal_amount, price, qty_wanted, currency, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [reg.id, req.session.merchantId, b.name.trim(), b.note || null, cleanUrl(b.image_url), cleanUrl(b.source_url), b.product_id != null ? String(b.product_id) : null,
      kind, kind === "cash" ? true : b.allow_split === true, goal, round2(b.price), Math.max(1, Number(b.qty_wanted) || 1), m.currency_code || "JMD", sortRow.s]);
  res.status(201).json({ item: serializeItem(row) });
});
app.patch("/api/items/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const it = await db.one(`SELECT * FROM items WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!it) return res.status(404).json({ error: "not_found" });
  const goal = b.goal_amount !== undefined ? (round2(b.goal_amount) > 0 ? round2(b.goal_amount) : null) : it.goal_amount;
  const u = await db.one(`UPDATE items SET name=$1, note=$2, image_url=$3, source_url=$4, price=$5, qty_wanted=$6, allow_split=$7, goal_amount=$8 WHERE id=$9 RETURNING *`,
    [b.name ?? it.name, b.note !== undefined ? (b.note || null) : it.note, b.image_url !== undefined ? cleanUrl(b.image_url) : it.image_url, b.source_url !== undefined ? cleanUrl(b.source_url) : it.source_url,
      b.price != null ? round2(b.price) : it.price, b.qty_wanted != null ? Math.max(1, Number(b.qty_wanted)) : it.qty_wanted, b.allow_split != null ? !!b.allow_split : it.allow_split, goal, it.id]);
  res.json({ item: serializeItem(u) });
});
app.delete("/api/items/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM items WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

// Catalog picker — pull merchant's own products so a gift can be a real fulfillable item.
app.get("/api/products", core.requireSession, async (req, res) => {
  if (!(req.session.scope || []).includes("products:read")) return res.json({ products: [], unavailable: true });
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `products?limit=30&order=id desc${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const products = (r?.result?.entries || []).map((p) => {
      const cur = p.currency || {}; const raw = Number(p.price ?? 0);
      return { id: p.id, title: p.title || p.name || `Product ${p.id}`, price: cur.is_float === true ? raw / 100 : raw, image: p.image_url || p.image || null, currency: cur.code || req.session.data?.merchant?.currency_code || "JMD" };
    });
    res.json({ products });
  } catch (err) { res.status(502).json({ error: "products_failed", message: err?.message }); }
});

// Cover / item image upload to S3.
app.post("/api/upload", core.requireSession, async (req, res) => {
  if (!storageConfigured()) return res.status(503).json({ error: "storage_off", message: "Image hosting isn't configured — paste an image URL instead." });
  const decoded = decodeDataUrl(req.body?.data);
  if (!decoded || !isAllowedImage(decoded.contentType)) return res.status(400).json({ error: "bad_image", message: "Upload a JPG, PNG, WEBP or GIF." });
  try { const { url } = await putObject({ prefix: `gift-registry/${req.session.merchantId}`, body: decoded.body, contentType: decoded.contentType }); res.json({ url }); }
  catch (err) { res.status(502).json({ error: "upload_failed", message: err?.message }); }
});

// Paste-a-URL: fetch the product page and pull OpenGraph title/image/price.
app.post("/api/scrape", core.requireSession, async (req, res) => {
  const url = cleanUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: "bad_url", message: "Paste a full product link (https://…)." });
  try {
    const host = new URL(url).hostname;
    if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(host)) return res.status(400).json({ error: "blocked" });
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketplaceBot/1.0)", "Accept": "text/html" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
    const html = (await r.text()).slice(0, 600000);
    const meta = (p) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${p}["'][^>]*>`, "i")); const c = m && m[0].match(/content=["']([^"']*)["']/i); return c ? decode(c[1]) : null; };
    const title = meta("og:title") || decode((html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim()) || null;
    const image = meta("og:image:secure_url") || meta("og:image") || meta("og:image:url") || null;
    const priceRaw = meta("og:price:amount") || meta("product:price:amount") || meta("price") || null;
    const price = priceRaw ? (Number(String(priceRaw).replace(/[^0-9.]/g, "")) || null) : null;
    res.json({ name: title, image: cleanUrl(image), price, source_url: url });
  } catch { res.status(502).json({ error: "scrape_failed", message: "Couldn't read that page — fill the gift in by hand." }); }
});

// Contributions/gifts received + thank-you tracker
app.get("/api/gifts", core.requireSession, async (req, res) => {
  if (req.query.refresh === "1") {
    const awaiting = await db.q(`SELECT * FROM contributions WHERE merchant_id=$1 AND state='awaiting' AND inkress_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 25`, [req.session.merchantId]);
    for (const c of awaiting) {
      try { const ink = await getInkressOrder(core.cfg, req.session.accessToken, c.inkress_order_id); if (ink && isPaidStatus(ink)) await settleContribution(c); } catch { /* */ }
    }
  }
  const rows = await db.q(`SELECT c.*, i.name AS item_name, i.kind AS item_kind, r.title AS registry_title FROM contributions c
    LEFT JOIN items i ON i.id=c.item_id LEFT JOIN registries r ON r.id=c.registry_id
    WHERE c.merchant_id=$1 AND c.state='paid' ORDER BY c.created_at DESC LIMIT 300`, [req.session.merchantId]);
  res.json({ gifts: rows.map((c) => ({ ...serializeContrib(c), item_name: c.item_name, item_kind: c.item_kind, registry_title: c.registry_title })) });
});
app.patch("/api/gifts/:id", core.requireSession, async (req, res) => {
  const thanked = !!req.body?.thanked;
  const u = await db.one(`UPDATE contributions SET thanked=$1, thanked_at=${thanked ? "now()" : "NULL"} WHERE id=$2 AND merchant_id=$3 RETURNING *`, [thanked, req.params.id, req.session.merchantId]);
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json({ gift: serializeContrib(u) });
});

// Per-registry analytics
app.get("/api/registries/:id/analytics", core.requireSession, async (req, res) => {
  const reg = await db.one(`SELECT * FROM registries WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!reg) return res.status(404).json({ error: "not_found" });
  const items = await db.q(`SELECT * FROM items WHERE registry_id=$1`, [reg.id]);
  const stats = await registryStats(reg.id);
  const contribs = await db.q(`SELECT c.*, i.name AS item_name FROM contributions c LEFT JOIN items i ON i.id=c.item_id WHERE c.registry_id=$1 AND c.state='paid' ORDER BY c.created_at DESC`, [reg.id]);
  const top = items.map(serializeItem).sort((a, b) => b.raised - a.raised).slice(0, 5).map((i) => ({ name: i.name, raised: i.raised, goal: i.goal, funded: i.funded }));
  res.json({
    raised: stats.raised, goal: stats.goal, pct: stats.pct, items: stats.items, funded_items: stats.funded,
    contributors: new Set(contribs.map((c) => (c.buyer_email || c.buyer_name || c.id))).size, contributions: contribs.length,
    thanked: contribs.filter((c) => c.thanked).length, currency: reg.currency, top,
  });
});
app.get("/api/registries/:id/contributors.csv", core.requireSession, async (req, res) => {
  const reg = await db.one(`SELECT * FROM registries WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!reg) return res.status(404).send("Not found");
  const rows = await db.q(`SELECT c.*, i.name AS item_name FROM contributions c LEFT JOIN items i ON i.id=c.item_id WHERE c.registry_id=$1 AND c.state='paid' ORDER BY c.created_at`, [reg.id]);
  const csv = ["date,gift,contributor,email,amount,currency,thanked,message"];
  for (const c of rows) csv.push([String(c.created_at).slice(0, 10), c.item_name || "", c.buyer_name || "", c.buyer_email || "", round2(c.amount), c.currency || reg.currency, c.thanked ? "yes" : "no", String(c.message || "").replace(/[\r\n]+/g, " ")].map(csvCell).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${(reg.title || "registry").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-contributors.csv"`);
  res.send(csv.join("\n"));
});

// Guest invites — email the registry link to a list of addresses.
app.post("/api/registries/:id/invite", core.requireSession, async (req, res) => {
  if (!sesConfigured()) return res.status(503).json({ error: "email_off", message: "Email isn't configured for invites yet." });
  const reg = await db.one(`SELECT * FROM registries WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!reg) return res.status(404).json({ error: "not_found" });
  const emails = (Array.isArray(req.body?.emails) ? req.body.emails : String(req.body?.emails || "").split(/[\s,;]+/)).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 100);
  if (!emails.length) return res.status(400).json({ error: "no_emails", message: "Add at least one valid email." });
  const url = `${PUBLIC_BASE(req)}/registry/${reg.id}`;
  let sent = 0;
  for (const to of emails) { try { await sendEmail({ to, subject: `You're invited: ${reg.title}`, html: inviteEmail(reg, url) }); sent++; } catch { /* */ } }
  res.json({ sent, total: emails.length });
});

app.get("/registry/:id", async (req, res) => {
  const r = await db.one(`SELECT * FROM registries WHERE id=$1`, [req.params.id]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!r || !r.active) return res.status(404).send(publicShell("Unavailable", `<div class="pad"><h1>Registry unavailable</h1></div>`));
  const items = await db.q(`SELECT * FROM items WHERE registry_id=$1 ORDER BY sort, id`, [r.id]).catch(() => []);
  res.send(registryPage(r, items));
});
app.get("/registry/:id/gift/:itemId", async (req, res) => {
  const r = await db.one(`SELECT * FROM registries WHERE id=$1`, [req.params.id]).catch(() => null);
  const it = await db.one(`SELECT * FROM items WHERE id=$1 AND registry_id=$2`, [req.params.itemId, req.params.id]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!r || !r.active || !it) return res.status(404).send(publicShell("Unavailable", `<div class="pad"><h1>Gift unavailable</h1></div>`, r?.accent));
  if (itemFunded(it) && !isFlexible(it)) return res.send(publicShell(it.name, `<div class="pad"><h1>All taken 🎉</h1><p class="blurb">This gift has been fully funded. Thank you!</p><a class="back" href="/registry/${r.id}">← Back to registry</a></div>`, r.accent));
  res.send(giftPage(r, it));
});
app.post("/api/public/registry/:id/item/:itemId", express.json(), async (req, res) => {
  const r = await db.one(`SELECT * FROM registries WHERE id=$1`, [req.params.id]).catch(() => null);
  if (!r || !r.active) return res.status(404).json({ error: "closed" });
  const it = await db.one(`SELECT * FROM items WHERE id=$1 AND registry_id=$2`, [req.params.itemId, r.id]).catch(() => null);
  if (!it) return res.status(404).json({ error: "no_item" });
  const remaining = itemRemaining(it);
  if (!isFlexible(it) && itemFunded(it)) return res.status(400).json({ error: "funded", message: "This gift is already fully funded." });
  if (remaining != null && remaining <= 0.01 && !(it.kind === "cash" && it.goal_amount == null)) return res.status(400).json({ error: "funded", message: "This gift is already fully funded." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "bad_email", message: "Enter a valid email." });
  // Amount: flexible items accept a buyer-chosen amount (capped at remaining); whole gifts charge the price.
  let amount;
  if (isFlexible(it)) {
    amount = round2(req.body?.amount);
    if (!(amount > 0)) return res.status(400).json({ error: "bad_amount", message: "Enter how much you'd like to give." });
    if (remaining != null && amount > remaining + 0.01) amount = remaining;
  } else {
    amount = round2(it.price);
    if (remaining != null && amount > remaining + 0.01) amount = remaining;
  }
  if (!(amount > 0)) return res.status(400).json({ error: "bad_amount", message: "Enter a valid amount." });
  let accessToken;
  try { accessToken = await tokens.accessTokenFor(r.merchant_id); } catch { return res.status(503).json({ error: "not_connected", message: "This registry isn't ready for gifts yet." }); }
  const name = String(req.body?.name || "Guest").trim();
  const ref = `gift-${r.merchant_id}-${it.id}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const [first, ...rest] = name.split(/\s+/);
  const title = it.kind === "cash" ? `Contribution to ${it.name} — ${r.title}` : isFlexible(it) ? `${it.name} (contribution) — ${r.title}` : `${it.name} — ${r.title}`;
  let created;
  try {
    created = await createInkressOrder(core.cfg, accessToken, {
      referenceId: ref, total: amount, currencyCode: it.currency, kind: "online", title,
      customer: { email, first_name: first || "Guest", last_name: rest.join(" ") || "" },
      metaData: { source: "gift-registry", registry_id: r.id, registry: r.title, item_id: it.id, item: it.name, contribution: isFlexible(it) },
    });
  } catch (err) { return res.status(502).json({ error: "order_failed", message: err?.message }); }
  await db.run(`INSERT INTO contributions (merchant_id, registry_id, item_id, buyer_name, buyer_email, message, amount, currency, ref, inkress_order_id, payment_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [r.merchant_id, r.id, it.id, name, email, String(req.body?.message || "").slice(0, 400) || null, amount, it.currency, ref, created.id != null ? String(created.id) : null, created.payment_url || null]);
  res.json({ payment_url: created.payment_url });
});

// Mark a contribution paid: idempotent, credits the item's raised amount + sends thanks.
async function settleContribution(c) {
  const moved = await db.one(`UPDATE contributions SET state='paid' WHERE id=$1 AND state<>'paid' RETURNING *`, [c.id]).catch(() => null);
  if (!moved) return false;
  await db.run(`UPDATE items SET raised_amount = round((COALESCE(raised_amount,0) + $1)::numeric, 2),
    qty_funded = CASE WHEN price > 0 THEN LEAST(qty_wanted, FLOOR((COALESCE(raised_amount,0) + $1) / price)::int) ELSE qty_funded END WHERE id=$2`, [round2(moved.amount), moved.item_id]);
  emailThanks(moved).catch(() => {});
  return true;
}

// Webhook receiver — real-time funding on matching paid orders.
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const ref = o.reference_id || o.metadata?.reference_id;
    let c = null;
    if (o.id != null) c = await db.one(`SELECT * FROM contributions WHERE merchant_id=$1 AND inkress_order_id=$2`, [merchantId, String(o.id)]).catch(() => null);
    if (!c && ref) c = await db.one(`SELECT * FROM contributions WHERE merchant_id=$1 AND ref=$2`, [merchantId, String(ref)]).catch(() => null);
    if (c) await settleContribution(c);
  } catch (err) { console.error(`[gift-registry] webhook failed: ${err?.message}`); }
});

async function emailThanks(c) {
  if (!sesConfigured() || !c.buyer_email) return;
  const it = await db.one(`SELECT * FROM items WHERE id=$1`, [c.item_id]).catch(() => null);
  const r = await db.one(`SELECT * FROM registries WHERE id=$1`, [c.registry_id]).catch(() => null);
  await sendEmail({ to: c.buyer_email, subject: `Thank you for your gift 🎁`, html: thanksEmail(r, it, c) });
}

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[gift-registry] listening on ${HOST}:${PORT}`));

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function decode(s) { return String(s ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim(); }
function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c, minimumFractionDigits: 0 }).format(n); } catch { return `${c} ${n}`; } }
function thanksEmail(r, it, c) {
  return `<div style="font-family:system-ui,sans-serif;max-width:460px;margin:0 auto;text-align:center;color:#1a1a1a;">
    <div style="font-size:40px;">🎁</div><h2 style="margin:4px 0;">Thank you, ${esc(c.buyer_name || "friend")}!</h2>
    <p style="color:#555;">Your gift of <b>${esc(it?.name || "")}</b> for ${esc(r?.recipient || r?.title || "")} is confirmed.</p>
    <p style="color:#888;font-size:13px;">${money(Number(c.amount), c.currency)}</p>
    <p style="color:#aaa;font-size:12px;">via Marketplace</p></div>`;
}
function inviteEmail(r, url) {
  const accent = r.accent || "#b5179e";
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;text-align:center;color:#1a1a1a;">
    <div style="font-size:38px;">🎁</div><h2 style="margin:6px 0;">${esc(r.title)}</h2>
    ${r.recipient ? `<p style="color:#555;margin:2px 0;">A registry for ${esc(r.recipient)}</p>` : ""}
    ${r.message ? `<p style="color:#666;font-style:italic;max-width:40ch;margin:10px auto;">"${esc(r.message)}"</p>` : ""}
    <p style="margin:18px 0;"><a href="${esc(url)}" style="background:${accent};color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block;">View the registry</a></p>
    <p style="color:#aaa;font-size:12px;">powered by Marketplace</p></div>`;
}
function publicShell(title, inner, accent = "#b5179e") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#faf7fb;color:#1f2430;min-height:100vh;padding:24px 16px}
  .wrap{max-width:560px;margin:0 auto}
  .card{background:#fff;border:1px solid #ece6ef;border-radius:18px;box-shadow:0 14px 44px rgba(40,20,40,.1);overflow:hidden;max-width:430px;margin:0 auto}
  .accent{height:4px;background:${accent}} .pad{padding:26px}
  .cover{display:block;width:100%;max-width:560px;height:200px;object-fit:cover;border-radius:18px;margin:0 auto 16px;border:1px solid #ece6ef}
  .logo{width:60px;height:60px;border-radius:16px;object-fit:cover;margin:0 auto 12px;display:block;border:1px solid #eee}
  h1{font-size:1.55rem;margin:0 0 6px;text-align:center} .blurb{color:#6b7280;text-align:center;margin:0 0 8px}
  .price{text-align:center;font-size:1.9rem;font-weight:800;margin:8px 0 12px}
  input,textarea{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d8d0db;border-radius:10px;font-size:15px;margin-bottom:10px;font-family:inherit}
  button.buy{width:100%;padding:14px;border:0;border-radius:10px;background:${accent};color:#fff;font-size:15px;font-weight:700;cursor:pointer}
  .back{display:inline-block;margin-top:14px;color:${accent};text-decoration:none}
  .reg-head{text-align:center;margin:6px 0 22px}
  .reg-head .eyebrow{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:${accent};font-weight:700;margin-bottom:6px}
  .reg-head h1{font-size:1.9rem}.reg-meta{display:inline-flex;flex-wrap:wrap;gap:6px 14px;justify-content:center;color:#6b7280;font-size:.92rem;margin-top:2px}
  .reg-msg{max-width:42ch;margin:12px auto 0;color:#574a57;font-style:italic}
  .reg-prog{max-width:340px;margin:16px auto 0}.reg-prog .bar{height:8px}.reg-prog .lbl{font-size:.78rem;color:#8a7d8a;margin-top:6px;text-align:center}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
  .item{background:#fff;border:1px solid #ece6ef;border-radius:16px;overflow:hidden;box-shadow:0 6px 20px rgba(40,20,40,.06);display:flex;flex-direction:column}
  .item .thumb{aspect-ratio:4/3;background:#f6f1f7 center/cover no-repeat;display:block;border-bottom:1px solid #f0e9f2}
  .item .body{padding:14px;display:flex;flex-direction:column;gap:6px;flex:1}
  .item h3{margin:0;font-size:1rem;line-height:1.25}.item .note{color:#6b7280;font-size:.85rem;margin:0}
  .tag{display:inline-block;font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${accent};background:${accent}1a;border-radius:20px;padding:2px 8px;align-self:flex-start}
  .bar{height:7px;background:#f0e9f2;border-radius:5px;overflow:hidden}.bar i{display:block;height:100%;background:${accent}}
  .item-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto;padding-top:6px}
  .item-foot .p{font-weight:800}.gift-btn{padding:8px 14px;border-radius:9px;background:${accent};color:#fff;text-decoration:none;font-weight:600;font-size:.85rem;white-space:nowrap}
  .taken{color:#16a34a;font-weight:600;font-size:.85rem}.srclink{color:#9b8ea0;font-size:.78rem;text-decoration:none}
  .gift-hero{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;border:1px solid #eee;margin-bottom:14px;background:#f6f1f7}
  .amt-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.amt-row button{flex:1;min-width:64px;padding:9px;border:1px solid #d8d0db;border-radius:9px;background:#fff;cursor:pointer;font-weight:600;color:#555}
  .amt-row button.on{border-color:${accent};color:${accent};background:${accent}12}
  .foot{text-align:center;color:#b3a1b3;font-size:12px;margin-top:24px}</style></head>
  <body><div class="wrap">${inner}<div class="foot">powered by Marketplace</div></div></body></html>`;
}
function registryPage(r, items) {
  const accent = r.accent || "#b5179e";
  const cover = r.cover_url ? `<img class="cover" src="${esc(r.cover_url)}" alt="">` : "";
  const logo = r.merchant_logo ? `<img class="logo" src="${esc(r.merchant_logo)}" alt="">` : "";
  let goal = 0, raised = 0;
  for (const i of items) { const g = itemGoal(i); const rr = itemRaised(i); goal += g > 0 ? g : rr; raised += g > 0 ? Math.min(rr, g) : rr; }
  const pct = goal ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
  const cards = items.length ? items.map((i) => {
    const funded = itemFunded(i) && !isFlexible(i);
    const g = itemGoal(i), rr = itemRaised(i);
    const p = g ? Math.min(100, Math.round((rr / g) * 100)) : 0;
    const thumb = i.image_url ? `<span class="thumb" style="background-image:url('${esc(i.image_url)}')"></span>` : "";
    const flexible = isFlexible(i);
    const showBar = flexible || i.qty_wanted > 1 || rr > 0;
    const label = i.kind === "cash" ? `${money(rr, i.currency)} raised${g ? ` of ${money(g, i.currency)}` : ""}` : flexible ? `${money(rr, i.currency)} of ${money(g, i.currency)}` : `${money(g, i.currency)}`;
    return `<div class="item">${thumb}<div class="body">${i.kind === "cash" ? `<span class="tag">Cash fund</span>` : flexible ? `<span class="tag">Group gift</span>` : ""}
      <h3>${esc(i.name)}</h3>${i.note ? `<p class="note">${esc(i.note)}</p>` : ""}
      ${showBar ? `<div class="bar"><i style="width:${p}%"></i></div>` : ""}
      <div class="item-foot"><span class="p">${esc(label)}</span>
      ${funded ? `<span class="taken">✓ Funded</span>` : `<a class="gift-btn" href="/registry/${r.id}/gift/${i.id}">${i.kind === "cash" || flexible ? "Chip in" : "Give gift"}</a>`}</div></div></div>`;
  }).join("") : `<p class="blurb">No gifts have been added yet.</p>`;
  return publicShell(r.title, `${cover}<div class="reg-head">${cover ? "" : logo}
    <div class="eyebrow">Gift Registry</div><h1>${esc(r.title)}</h1>
    <div class="reg-meta">${r.recipient ? `<span>For ${esc(r.recipient)}</span>` : ""}${r.event_date ? `<span>${esc(String(r.event_date).slice(0, 10))}</span>` : ""}</div>
    ${r.message ? `<p class="reg-msg">“${esc(r.message)}”</p>` : ""}
    ${goal ? `<div class="reg-prog"><div class="bar"><i style="width:${pct}%"></i></div><div class="lbl">${money(raised, r.currency)} of ${money(goal, r.currency)} raised · ${pct}%</div></div>` : ""}</div>
    <div class="grid">${cards}</div>`, accent);
}
function giftPage(r, it) {
  const accent = r.accent || "#b5179e";
  const hero = it.image_url ? `<img class="gift-hero" src="${esc(it.image_url)}" alt="">` : "";
  const flexible = isFlexible(it);
  const g = itemGoal(it), rr = itemRaised(it);
  const remaining = itemRemaining(it);
  const pct = g ? Math.min(100, Math.round((rr / g) * 100)) : 0;
  const suggestions = flexible ? [1000, 2500, 5000].filter((v) => remaining == null || v <= remaining).concat(remaining != null && remaining > 0 ? [remaining] : []) : [];
  const uniqSug = [...new Set(suggestions)].slice(0, 4);
  const amountBlock = flexible
    ? `${g ? `<div class="bar" style="margin-bottom:8px"><i style="width:${pct}%"></i></div><p class="blurb" style="margin-top:0">${money(rr, it.currency)} raised${g ? ` of ${money(g, it.currency)}` : ""}${remaining != null ? ` · ${money(remaining, it.currency)} to go` : ""}</p>` : ""}
       ${uniqSug.length ? `<div class="amt-row">${uniqSug.map((v) => `<button type="button" data-amt="${v}">${money(v, it.currency)}</button>`).join("")}</div>` : ""}
       <input id="amt" type="number" min="1" step="1" placeholder="Amount to give (${esc(it.currency)})">`
    : `<div class="price">${money(g, it.currency)}</div>`;
  return publicShell(it.name, `<div class="card"><div class="accent"></div><div class="pad">
    ${hero}
    <h1>${esc(it.name)}</h1>
    <p class="blurb">${it.kind === "cash" ? "A contribution toward" : "A gift for"} ${esc(r.recipient || r.title)}</p>
    ${it.note ? `<p class="blurb">${esc(it.note)}</p>` : ""}
    ${amountBlock}
    ${it.source_url ? `<p style="text-align:center;margin:-4px 0 12px"><a class="srclink" href="${esc(it.source_url)}" target="_blank" rel="noopener">View product ↗</a></p>` : ""}
    <input id="n" required placeholder="Your name" autocomplete="name">
    <input id="em" type="email" required placeholder="you@email.com" autocomplete="email">
    <textarea id="msg" rows="2" placeholder="Add a note for ${esc(r.recipient || "them")} (optional)"></textarea>
    <button class="buy" id="buy">${it.kind === "cash" || flexible ? "Give this amount" : "Give this gift"}</button>
    <div id="out" style="display:none;color:#6b7280;text-align:center;margin-top:10px"></div>
    <div style="text-align:center"><a class="back" href="/registry/${r.id}">← Back to registry</a></div>
    <script>${flexible ? `document.querySelectorAll('.amt-row button').forEach(b=>b.addEventListener('click',()=>{document.getElementById('amt').value=b.dataset.amt;document.querySelectorAll('.amt-row button').forEach(x=>x.classList.remove('on'));b.classList.add('on');}));` : ""}
    document.getElementById('buy').addEventListener('click',async()=>{const n=document.getElementById('n').value,em=document.getElementById('em').value,msg=document.getElementById('msg').value;const amt=${flexible ? "Number(document.getElementById('amt').value)" : "0"};if(!n||!em){show('Enter your name and email.');return;}${flexible ? "if(!(amt>0)){show('Enter how much you would like to give.');return;}" : ""}const b=document.getElementById('buy');b.disabled=true;b.textContent='Creating your link…';const rr=await fetch('/api/public/registry/${r.id}/item/${it.id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,email:em,message:msg,amount:amt})});const j=await rr.json();if(j.payment_url){window.location.href=j.payment_url;}else{b.disabled=false;b.textContent='${it.kind === "cash" || flexible ? "Give this amount" : "Give this gift"}';show(j.message||'Something went wrong.');}});
    function show(t){const m=document.getElementById('out');m.style.display='block';m.textContent=t;}</script></div></div>`, accent);
}
