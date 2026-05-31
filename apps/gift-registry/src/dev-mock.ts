/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const THEMES = [
  { id: "general", accent: "#b5179e", label: "Classic" },
  { id: "wedding", accent: "#b08968", label: "Wedding" },
  { id: "baby", accent: "#56a3a6", label: "Baby" },
  { id: "birthday", accent: "#e8590c", label: "Birthday" },
  { id: "housewarming", accent: "#2f6f4e", label: "Housewarming" },
  { id: "graduation", accent: "#3b5bdb", label: "Graduation" },
];

let REGS: any[] = [
  { id: 1, title: "Maya & Andre's Wedding", recipient: "Maya & Andre", event_date: "2026-09-12", message: "Thank you for celebrating with us!", active: true, currency: "JMD", theme: "wedding", accent: "#b08968", cover_url: null, public_url: location.origin + "/registry/1" },
  { id: 2, title: "Baby Reid is coming!", recipient: "The Reids", event_date: "2026-07-30", message: null, active: true, currency: "JMD", theme: "baby", accent: "#56a3a6", cover_url: null, public_url: location.origin + "/registry/2" },
];
let RID = 2;
const ITEMS: Record<number, any[]> = {
  1: [
    { id: 1, registry_id: 1, name: "Stand Mixer", note: "Any colour but red 🙂", image_url: "https://m.media-amazon.com/images/I/71nXapH6BxL._AC_SL1500_.jpg", source_url: "https://www.amazon.com/dp/B00005UP2P", product_id: null, kind: "item", allow_split: false, price: 32000, qty_wanted: 1, qty_funded: 1, goal_amount: null, raised_amount: 32000, currency: "JMD" },
    { id: 2, registry_id: 1, name: "Dinner Set (8pc)", note: null, image_url: null, source_url: null, product_id: null, kind: "item", allow_split: true, price: 15000, qty_wanted: 1, qty_funded: 0, goal_amount: null, raised_amount: 6000, currency: "JMD" },
    { id: 3, registry_id: 1, name: "Honeymoon fund", note: "Help us get to Negril", image_url: null, source_url: null, product_id: null, kind: "cash", allow_split: true, price: 0, qty_wanted: 1, qty_funded: 0, goal_amount: 50000, raised_amount: 18500, currency: "JMD" },
    { id: 4, registry_id: 1, name: "Cast Iron Skillet", note: null, image_url: null, source_url: null, product_id: null, kind: "item", allow_split: false, price: 8000, qty_wanted: 1, qty_funded: 1, goal_amount: null, raised_amount: 8000, currency: "JMD" },
  ],
  2: [
    { id: 5, registry_id: 2, name: "Crib", note: null, image_url: null, source_url: null, product_id: null, kind: "item", allow_split: false, price: 22000, qty_wanted: 1, qty_funded: 0, goal_amount: null, raised_amount: 0, currency: "JMD" },
    { id: 6, registry_id: 2, name: "Diaper fund", note: "Every bit helps!", image_url: null, source_url: null, product_id: null, kind: "cash", allow_split: true, price: 0, qty_wanted: 1, qty_funded: 0, goal_amount: null, raised_amount: 1500, currency: "JMD" },
    { id: 7, registry_id: 2, name: "Story books", note: null, image_url: null, source_url: null, product_id: null, kind: "item", allow_split: false, price: 3000, qty_wanted: 1, qty_funded: 0, goal_amount: null, raised_amount: 0, currency: "JMD" },
  ],
};
let IID = 7;
const GIFTS: any[] = [
  { id: 1, registry_id: 1, item_id: 1, buyer_name: "Aunt Patsy", buyer_email: "patsy@example.com", message: "So happy for you both!", amount: 32000, currency: "JMD", state: "paid", thanked: true, created_at: new Date(Date.now() - 2 * 864e5).toISOString(), item_name: "Stand Mixer", item_kind: "item", registry_title: "Maya & Andre's Wedding" },
  { id: 2, registry_id: 1, item_id: 3, buyer_name: "The Campbells", buyer_email: "camp@example.com", message: "A little something for the trip ✈️", amount: 12000, currency: "JMD", state: "paid", thanked: false, created_at: new Date(Date.now() - 36e5).toISOString(), item_name: "Honeymoon fund", item_kind: "cash", registry_title: "Maya & Andre's Wedding" },
  { id: 3, registry_id: 1, item_id: 3, buyer_name: "Uncle Ray", buyer_email: "ray@example.com", message: null, amount: 6500, currency: "JMD", state: "paid", thanked: false, created_at: new Date(Date.now() - 5 * 36e5).toISOString(), item_name: "Honeymoon fund", item_kind: "cash", registry_title: "Maya & Andre's Wedding" },
  { id: 4, registry_id: 1, item_id: 2, buyer_name: "Nadine", buyer_email: "nadine@example.com", message: "Toward the dinner set!", amount: 6000, currency: "JMD", state: "paid", thanked: false, created_at: new Date(Date.now() - 9 * 36e5).toISOString(), item_name: "Dinner Set (8pc)", item_kind: "item", registry_title: "Maya & Andre's Wedding" },
];

const goalOf = (i: any) => { const g = i.goal_amount != null ? Number(i.goal_amount) : Number(i.price) * Number(i.qty_wanted || 1); return g > 0 ? g : 0; };
const fundedOf = (i: any) => { const g = goalOf(i); return g > 0 && Number(i.raised_amount) >= g - 0.01; };
const flexOf = (i: any) => i.kind === "cash" || i.allow_split === true;
const serItem = (i: any) => ({ ...i, goal: goalOf(i), raised: Number(i.raised_amount), remaining: goalOf(i) ? Math.max(0, goalOf(i) - Number(i.raised_amount)) : null, funded: fundedOf(i) });

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 85));
    const ri = u.pathname.match(/\/api\/registries\/(\d+)(\/items|\/analytics|\/contributors\.csv|\/invite)?/);
    const im = u.pathname.match(/\/api\/items\/(\d+)/);
    const gm = u.pathname.match(/\/api\/gifts\/(\d+)/);
    const reStat = (id: number) => { const its = ITEMS[id] || []; let goal = 0, raised = 0, funded = 0; for (const i of its) { const g = goalOf(i); const r = Number(i.raised_amount); goal += g > 0 ? g : r; raised += g > 0 ? Math.min(r, g) : r; if (fundedOf(i)) funded++; } return { items: its.length, goal, raised, funded, pct: goal ? Math.min(100, Math.round((raised / goal) * 100)) : 0 }; };
    const ser = (r: any) => ({ ...r, ...reStat(r.id) });

    if (u.pathname === "/api/status") return json({ realtime: true, webhook_registered: true, storage: false, can_register: true, products: true });
    if (u.pathname === "/api/registries" && method === "GET") return json({ registries: REGS.map(ser), connected: true, storage: false, webhook_realtime: true, themes: THEMES });
    if (u.pathname === "/api/registries" && method === "POST") { const r = { id: ++RID, theme: "general", accent: "#b5179e", cover_url: null, ...body, active: true, currency: "JMD", public_url: location.origin + "/registry/" + RID }; REGS.unshift(r); ITEMS[RID] = []; return json({ registry: ser(r) }, 201); }
    if (u.pathname === "/api/products") return json({ products: [
      { id: 101, title: "Le Creuset Dutch Oven 5.5qt", price: 38500, image: "https://m.media-amazon.com/images/I/61gM7TfNJUL._AC_SL1000_.jpg", currency: "JMD" },
      { id: 102, title: "Bamboo Cutting Board Set", price: 4200, image: null, currency: "JMD" },
      { id: 103, title: "Ceramic Vase, Tall", price: 6800, image: null, currency: "JMD" },
    ].filter((p) => !body && (u.searchParams.get("q") ? p.title.toLowerCase().includes((u.searchParams.get("q") || "").toLowerCase()) : true)) });
    if (u.pathname === "/api/upload") return json({ url: "https://placehold.co/1200x480/png" });
    if (ri && ri[2] === "/items" && method === "GET") return json({ items: (ITEMS[Number(ri[1])] || []).map(serItem) });
    if (ri && ri[2] === "/items" && method === "POST") { const it = { id: ++IID, registry_id: Number(ri[1]), name: body.name, note: body.note || null, image_url: body.image_url || null, source_url: body.source_url || null, product_id: body.product_id || null, kind: body.kind === "cash" ? "cash" : "item", allow_split: body.kind === "cash" ? true : !!body.allow_split, price: Number(body.price) || 0, qty_wanted: Number(body.qty_wanted) || 1, qty_funded: 0, goal_amount: body.goal_amount != null ? Number(body.goal_amount) : null, raised_amount: 0, currency: "JMD" }; (ITEMS[Number(ri[1])] ||= []).push(it); return json({ item: serItem(it) }, 201); }
    if (ri && ri[2] === "/analytics") { const id = Number(ri[1]); const st = reStat(id); const gs = GIFTS.filter((g) => g.registry_id === id); const top = (ITEMS[id] || []).map(serItem).sort((a, b) => b.raised - a.raised).slice(0, 5).map((i) => ({ name: i.name, raised: i.raised, goal: i.goal, funded: i.funded })); return json({ raised: st.raised, goal: st.goal, pct: st.pct, items: st.items, funded_items: st.funded, contributors: new Set(gs.map((g) => g.buyer_email)).size, contributions: gs.length, thanked: gs.filter((g) => g.thanked).length, currency: "JMD", top }); }
    if (ri && ri[2] === "/contributors.csv") return new Response("date,gift,contributor,email,amount,currency,thanked,message\n2026-05-01,Stand Mixer,Aunt Patsy,patsy@example.com,32000,JMD,yes,So happy", { status: 200, headers: { "Content-Type": "text/csv" } });
    if (ri && ri[2] === "/invite") return json({ sent: (String(body.emails || "").split(/[\s,;]+/).filter(Boolean)).length, total: (String(body.emails || "").split(/[\s,;]+/).filter(Boolean)).length });
    if (u.pathname === "/api/scrape" && method === "POST") { return json({ name: "Le Creuset Dutch Oven 5.5qt", image: "https://m.media-amazon.com/images/I/61gM7TfNJUL._AC_SL1000_.jpg", price: 38500, source_url: body.url }); }
    if (ri && method === "PATCH") { const r = REGS.find((x) => x.id === Number(ri[1])); Object.assign(r, body); return json({ registry: ser(r) }); }
    if (ri && method === "DELETE") { REGS = REGS.filter((x) => x.id !== Number(ri[1])); return json({ ok: true }); }
    if (gm && method === "PATCH") { const g = GIFTS.find((x) => x.id === Number(gm[1])); if (g) g.thanked = !!body.thanked; return json({ gift: g }); }
    if (im && method === "PATCH") { for (const list of Object.values(ITEMS)) { const it = list.find((x) => x.id === Number(im[1])); if (it) Object.assign(it, { name: body.name ?? it.name, note: body.note !== undefined ? body.note : it.note, price: body.price != null ? Number(body.price) : it.price, qty_wanted: Number(body.qty_wanted) || it.qty_wanted, allow_split: body.allow_split != null ? !!body.allow_split : it.allow_split, goal_amount: body.goal_amount !== undefined ? (body.goal_amount != null ? Number(body.goal_amount) : null) : it.goal_amount, image_url: body.image_url !== undefined ? body.image_url : it.image_url }); } return json({ ok: true }); }
    if (im && method === "DELETE") { for (const k of Object.keys(ITEMS)) { const kk = Number(k); ITEMS[kk] = (ITEMS[kk] || []).filter((x) => x.id !== Number(im[1])); } return json({ ok: true }); }
    if (u.pathname === "/api/gifts") return json({ gifts: GIFTS });
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "island-home-goods", name: "Island Home Goods", currency_code: "JMD", email: "hello@islandhome.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@islandhome.com" },
    scopes: ["orders:write", "offline_access", "products:read", "webhooks:manage"],
  };
}
