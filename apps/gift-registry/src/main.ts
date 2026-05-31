import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, fmtDate, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Registry { id: number; title: string; recipient: string | null; event_date: string | null; message: string | null; active: boolean; currency: string; theme: string; accent: string; cover_url: string | null; items: number; funded: number; goal: number; raised: number; pct: number; public_url: string; }
interface Item { id: number; registry_id: number; name: string; note: string | null; image_url: string | null; source_url: string | null; product_id: string | null; kind: string; allow_split: boolean; price: number; qty_wanted: number; qty_funded: number; goal: number; raised: number; remaining: number | null; funded: boolean; currency: string; }
interface Gift { id: number; registry_id: number; item_id: number; buyer_name: string | null; buyer_email: string | null; message: string | null; amount: number; currency: string; state: string; thanked: boolean; created_at: string; item_name: string | null; item_kind?: string; registry_title: string | null; }
interface Theme { id: string; accent: string; label: string; }
interface Caps { storage: boolean; webhook_realtime: boolean; products: boolean; themes: Theme[]; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let shell: ReturnType<typeof mountShell>;
let caps: Caps = { storage: false, webhook_realtime: false, products: false, themes: [{ id: "general", accent: "#b5179e", label: "Classic" }] };

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "gift",
    brandLogo: "/logo.svg",
    title: "Gift Registry",
    subtitle: `${merchantName} · registries your customers fund online`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "registries", label: "Registries", icon: "gift", render: renderRegistries },
      { id: "gifts", label: "Gifts received", icon: "heart", render: renderGifts },
    ],
  });
})();

/* ---------------------------------------------------------------- Registries */
async function renderRegistries(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { registries: Registry[]; connected: boolean; storage: boolean; webhook_realtime: boolean; themes: Theme[] };
  try { data = await bvApi("/api/registries"); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";
  const regs = data.registries;
  caps = { storage: data.storage, webhook_realtime: data.webhook_realtime, products: caps.products, themes: data.themes?.length ? data.themes : caps.themes };
  bvApi<{ products: boolean }>("/api/status").then((s) => { caps.products = !!s.products; }).catch(() => {});

  host.append(statRow([
    { k: "Registries", v: String(regs.length), icon: "gift" },
    { k: "Gifts funded", v: String(regs.reduce((s, r) => s + r.funded, 0)), tone: "ok", icon: "heart" },
    { k: "Raised", v: fmtMoney(regs.reduce((s, r) => s + r.raised, 0), currency), tone: "accent", icon: "coins" },
  ]));

  const add = h("button", { class: "primary", onClick: () => openRegistry(null) }, iconEl("plus", 15), "New registry");
  if (!regs.length) { host.append(card({ title: "Registries", action: add, body: emptyState({ icon: "gift", title: "No registries yet", text: "Create a registry, add the gifts (or a cash fund) you'd like, and share the link." }) })); return; }

  const grid = h("div", { class: "gr-grid" });
  for (const r of regs) {
    grid.append(h("div", { class: "gr-card" + (r.active ? "" : " is-off") },
      h("span", { class: "gr-stripe", style: { background: r.accent } }),
      h("div", { class: "gr-card-body" },
        h("div", { class: "gr-card-head" }, h("strong", null, r.title), r.active ? pill("live", "ok") : pill("off")),
        h("div", { class: "bv-muted gr-meta" }, [r.recipient ? `For ${r.recipient}` : null, r.event_date ? fmtDate(r.event_date) : null].filter(Boolean).join(" · ") || "—"),
        h("div", { class: "gr-prog" }, h("div", { class: "gr-bar" }, h("i", { style: { width: `${r.pct}%`, background: r.accent } })), h("div", { class: "bv-muted gr-prog-label" }, `${fmtMoney(r.raised, r.currency)} of ${fmtMoney(r.goal, r.currency)} raised · ${r.pct}%`)),
        h("div", { class: "gr-link" }, h("input", { class: "gr-link-input", readonly: true, value: r.public_url }), h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(r.public_url); flash("Link copied", "success"); } }, iconEl("copy", 14))),
        h("div", { class: "gr-actions" },
          h("button", { class: "ghost sm", onClick: () => manageItems(r) }, iconEl("list", 14), `Gifts (${r.items})`),
          h("button", { class: "ghost sm", onClick: () => openAnalytics(r) }, iconEl("chart", 14)),
          h("a", { class: "gr-open", href: r.public_url, target: "_blank", rel: "noopener", title: "Open public page" }, iconEl("external", 14)),
          h("button", { class: "ghost sm", onClick: () => openRegistry(r) }, iconEl("edit", 14)),
          h("button", { class: "ghost sm", onClick: async () => { if (!confirm(`Delete “${r.title}” and all its gifts?`)) return; await bvApi(`/api/registries/${r.id}`, { method: "DELETE" }); shell.select("registries"); } }, iconEl("trash", 14))))));
  }
  host.append(card({ title: "Registries", action: add, body: grid }));
  const notes: HTMLElement[] = [];
  if (!data.connected) notes.push(h("div", { class: "gr-note bv-muted" }, iconEl("alert", 14), "Connecting to your Inkress account — online gifting activates momentarily."));
  if (data.webhook_realtime) notes.push(h("div", { class: "gr-note bv-muted" }, iconEl("bell", 14), "Real-time funding is on — gifts mark as funded the moment a guest pays."));
  notes.forEach((n) => host.append(n));
}

function openRegistry(r: Registry | null) {
  const title = h("input", { value: r?.title || "", placeholder: "e.g. Maya & Andre's Wedding" }) as HTMLInputElement;
  const recipient = h("input", { value: r?.recipient || "", placeholder: "Who is it for? (optional)" }) as HTMLInputElement;
  const date = h("input", { type: "date", value: r?.event_date?.slice(0, 10) || "" }) as HTMLInputElement;
  const message = h("textarea", { rows: "2", placeholder: "A note for your guests (optional)" }) as HTMLTextAreaElement;
  message.value = r?.message || "";
  const active = h("input", { type: "checkbox", checked: r ? r.active : true }) as HTMLInputElement;

  // Theme + accent
  let theme = r?.theme || "general";
  let accent = r?.accent || caps.themes.find((t) => t.id === theme)?.accent || "#b5179e";
  const accentIn = h("input", { type: "color", value: accent }) as HTMLInputElement;
  accentIn.addEventListener("input", () => { accent = accentIn.value; });
  const themeSel = h("select", null, ...caps.themes.map((t) => h("option", { value: t.id, selected: t.id === theme }, t.label))) as HTMLSelectElement;
  themeSel.addEventListener("change", () => { theme = themeSel.value; const t = caps.themes.find((x) => x.id === theme); if (t) { accent = t.accent; accentIn.value = t.accent; } });

  // Cover image (S3)
  let coverUrl = r?.cover_url || "";
  const coverPreview = h("div", { class: "gr-cover-preview" + (coverUrl ? "" : " is-empty"), style: coverUrl ? { backgroundImage: `url('${coverUrl}')` } : {} });
  const fileInput = h("input", { type: "file", accept: "image/*", style: { display: "none" }, onChange: async (e: any) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader(); reader.onload = async () => {
      try { const up = await bvApi<{ url: string }>("/api/upload", { method: "POST", body: JSON.stringify({ data: reader.result }) }); coverUrl = up.url; coverPreview.style.backgroundImage = `url('${coverUrl}')`; coverPreview.classList.remove("is-empty"); flash("Cover uploaded", "success"); }
      catch (err: any) { toast(err?.message || "Upload failed", "error"); }
    }; reader.readAsDataURL(file);
  } }) as HTMLInputElement;
  const coverBtn = h("button", { class: "ghost sm", disabled: !caps.storage, title: caps.storage ? "" : "Image hosting not configured", onClick: () => fileInput.click() }, iconEl("download", 14), "Upload cover");
  const clearCover = h("button", { class: "ghost sm", onClick: () => { coverUrl = ""; coverPreview.style.backgroundImage = ""; coverPreview.classList.add("is-empty"); } }, "Clear");

  const body = h("div", { class: "gr-form" },
    field("Registry title", title),
    h("div", { class: "gr-form-grid" }, field("Recipient", recipient), field("Event date", date)),
    field("Message", message),
    h("div", { class: "gr-form-grid" }, field("Theme", themeSel), field("Accent", accentIn)),
    field("Cover image", h("div", { class: "gr-cover-row" }, coverPreview, h("div", { class: "gr-imgbtns" }, coverBtn, coverUrl ? clearCover : null, fileInput))),
    r ? h("label", { class: "gr-check" }, active, " Active (accepting gifts)") : null);
  const save = async () => {
    if (!title.value.trim()) { toast("A title is required", "warning"); return; }
    const payload: any = { title: title.value, recipient: recipient.value || null, event_date: date.value || null, message: message.value || null, theme, accent, cover_url: coverUrl || null };
    try { if (r) { payload.active = active.checked; await bvApi(`/api/registries/${r.id}`, { method: "PATCH", body: JSON.stringify(payload) }); } else await bvApi("/api/registries", { method: "POST", body: JSON.stringify(payload) }); flash(r ? "Saved" : "Registry created", "success"); shell.select("registries"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: r ? "Edit registry" : "New registry", body, actions: [{ label: r ? "Save" : "Create", primary: true, onClick: () => { void save(); } }] });
}

/* --------------------------------------------------------------- Manage items */
function manageItems(r: Registry) {
  const list = h("div", { class: "gr-items" });

  // Type toggle: gift item vs cash fund
  let kind: "item" | "cash" = "item";
  const segItem = h("button", { class: "gr-seg on", onClick: () => setKind("item") }, iconEl("gift", 14), "Gift item") as HTMLButtonElement;
  const segCash = h("button", { class: "gr-seg", onClick: () => setKind("cash") }, iconEl("coins", 14), "Cash fund") as HTMLButtonElement;

  const urlIn = h("input", { placeholder: "Paste a product link (Amazon, any store)…" }) as HTMLInputElement;
  const img = h("input", { placeholder: "Image URL (optional)" }) as HTMLInputElement;
  const name = h("input", { placeholder: "Gift name, e.g. Stand Mixer" }) as HTMLInputElement;
  const price = h("input", { type: "number", min: "0", step: "0.01", placeholder: "0.00" }) as HTMLInputElement;
  const qty = h("input", { type: "number", min: "1", value: "1", placeholder: "1" }) as HTMLInputElement;
  const goal = h("input", { type: "number", min: "0", step: "0.01", placeholder: "Target amount (optional)" }) as HTMLInputElement;
  const note = h("input", { placeholder: "Note (optional)" }) as HTMLInputElement;
  const split = h("input", { type: "checkbox" }) as HTMLInputElement;
  const thumb = h("span", { class: "gr-thumb is-empty" });
  let srcUrl = "";
  let productId = "";
  const setThumb = () => { const u = img.value.trim(); thumb.style.backgroundImage = u ? `url('${u}')` : ""; thumb.classList.toggle("is-empty", !u); };
  img.addEventListener("input", setThumb);

  const scanBtn = h("button", { class: "ghost sm", onClick: () => { void scrape(); } }, iconEl("link", 14), "Fetch") as HTMLButtonElement;
  const catalogBtn = h("button", { class: "ghost sm", onClick: () => openCatalog(), title: "Pick from your products" }, iconEl("box", 14), "Catalog") as HTMLButtonElement;
  const scrape = async () => {
    const u = urlIn.value.trim(); if (!u) return;
    scanBtn.disabled = true; scanBtn.replaceChildren(document.createTextNode("Fetching…"));
    try {
      const d = await bvApi<{ name?: string; image?: string; price?: number; source_url?: string }>("/api/scrape", { method: "POST", body: JSON.stringify({ url: u }) });
      if (d.name && !name.value) name.value = d.name;
      if (d.image) { img.value = d.image; setThumb(); }
      if (d.price && !price.value) price.value = String(d.price);
      srcUrl = d.source_url || u; productId = "";
      flash("Pulled in the product", "success");
    } catch (err: any) { toast(err?.message || "Couldn't fetch that link", "warning"); }
    finally { scanBtn.disabled = false; scanBtn.replaceChildren(iconEl("link", 14), document.createTextNode("Fetch")); }
  };
  const openCatalog = () => {
    const search = h("input", { placeholder: "Search your products…" }) as HTMLInputElement;
    const results = h("div", { class: "gr-cat-results" });
    const load = async () => {
      results.innerHTML = ""; results.append(h("div", { class: "bv-muted", style: { padding: "8px 0" } }, "Loading…"));
      try {
        const d = await bvApi<{ products: { id: number; title: string; price: number; image: string | null; currency: string }[]; unavailable?: boolean }>(`/api/products?q=${encodeURIComponent(search.value.trim())}`);
        results.innerHTML = "";
        if (d.unavailable) { results.append(h("div", { class: "bv-muted", style: { padding: "8px 0" } }, "Catalog access isn't enabled for this app.")); return; }
        if (!d.products.length) { results.append(h("div", { class: "bv-muted", style: { padding: "8px 0" } }, "No products found.")); return; }
        for (const p of d.products) results.append(h("button", { class: "gr-cat-row", onClick: () => { name.value = p.title; price.value = String(p.price); if (p.image) { img.value = p.image; setThumb(); } productId = String(p.id); srcUrl = ""; document.querySelector(".bv-scrim")?.remove(); flash("Added from catalog", "success"); } },
          h("span", { class: "gr-cat-thumb" + (p.image ? "" : " is-empty"), style: p.image ? { backgroundImage: `url('${p.image}')` } : {} }),
          h("span", { class: "gr-cat-main" }, h("strong", null, p.title), h("span", { class: "bv-muted" }, fmtMoney(p.price, p.currency)))));
      } catch (err: any) { results.innerHTML = ""; results.append(h("div", { class: "bv-muted" }, err?.message || "Couldn't load products")); }
    };
    let t: any; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
    openModal({ title: "Add from catalog", body: h("div", { class: "gr-catalog" }, search, results), actions: [{ label: "Close", onClick: () => {} }] });
    void load();
  };

  const giftFields = h("div", { class: "gr-item-fields" }, name, h("div", { class: "gr-item-form-grid" }, price, qty), img, note,
    h("label", { class: "gr-check" }, split, " Allow group gifting (guests chip in toward this gift)"));
  const cashFields = h("div", { class: "gr-item-fields", style: { display: "none" } }, name, goal, img, note);
  const urlRow = h("div", { class: "gr-url-row" }, urlIn, scanBtn, caps.products ? catalogBtn : null);
  const addBtn = h("button", { class: "primary sm", onClick: () => { void add(); } }, iconEl("plus", 14), "Add");
  const form = h("div", { class: "gr-item-form" },
    h("div", { class: "gr-seg-row" }, segItem, segCash),
    urlRow,
    h("div", { class: "gr-item-form2" }, thumb, h("div", { style: { flex: "1" } }, giftFields, cashFields)),
    addBtn);

  const setKind = (k: "item" | "cash") => {
    kind = k;
    segItem.classList.toggle("on", k === "item"); segCash.classList.toggle("on", k === "cash");
    giftFields.style.display = k === "item" ? "" : "none";
    cashFields.style.display = k === "cash" ? "" : "none";
    urlRow.style.display = k === "item" ? "" : "none";
    name.placeholder = k === "cash" ? "Fund name, e.g. Honeymoon fund" : "Gift name, e.g. Stand Mixer";
    if (k === "cash") cashFields.prepend(name); else giftFields.prepend(name);
  };

  const reload = async () => {
    list.innerHTML = "";
    let items: Item[];
    try { items = (await bvApi<{ items: Item[] }>(`/api/registries/${r.id}/items`)).items; }
    catch (err: any) { list.append(h("div", { class: "bv-muted" }, err?.message || "Couldn't load")); return; }
    if (!items.length) { list.append(h("div", { class: "bv-muted", style: { padding: "8px 0" } }, "No gifts yet — add your first below.")); return; }
    for (const it of items) {
      const tag = it.kind === "cash" ? pill("cash fund", "accent") : it.allow_split ? pill("group", "accent") : null;
      const meta = it.kind === "cash" || it.allow_split ? `${fmtMoney(it.raised, it.currency)}${it.goal ? ` / ${fmtMoney(it.goal, it.currency)}` : ""}` : `${fmtMoney(it.price, it.currency)} · ${it.qty_funded}/${it.qty_wanted}`;
      list.append(h("div", { class: "gr-item-row" },
        h("span", { class: "gr-row-thumb" + (it.image_url ? "" : " is-empty"), style: it.image_url ? { backgroundImage: `url('${it.image_url}')` } : {} }),
        h("div", { class: "gr-item-main" }, h("strong", null, it.name), tag, it.note ? h("div", { class: "bv-muted" }, it.note) : null),
        h("div", { class: "gr-item-meta" }, h("span", null, meta), it.funded ? pill("funded", "ok") : null),
        h("button", { class: "ghost sm", onClick: () => { void editItem(it); } }, iconEl("edit", 13)),
        h("button", { class: "ghost sm", onClick: async () => { await bvApi(`/api/items/${it.id}`, { method: "DELETE" }); await reload(); refreshCount(); } }, iconEl("trash", 13))));
    }
  };
  const add = async () => {
    if (!name.value.trim()) { toast("A name is required", "warning"); return; }
    if (kind === "item" && !(Number(price.value) > 0)) { toast("Gift name and a price are required", "warning"); return; }
    try {
      const payload: any = kind === "cash"
        ? { kind: "cash", name: name.value, goal_amount: Number(goal.value) || null, note: note.value || null, image_url: img.value || null }
        : { kind: "item", name: name.value, price: Number(price.value), qty_wanted: Number(qty.value) || 1, allow_split: split.checked, note: note.value || null, image_url: img.value || null, source_url: srcUrl || null, product_id: productId || null };
      await bvApi(`/api/registries/${r.id}/items`, { method: "POST", body: JSON.stringify(payload) });
      name.value = ""; price.value = ""; qty.value = "1"; goal.value = ""; note.value = ""; img.value = ""; urlIn.value = ""; srcUrl = ""; productId = ""; split.checked = false; setThumb();
      await reload(); refreshCount(); flash(kind === "cash" ? "Cash fund added" : "Gift added", "success");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  const editItem = async (it: Item) => {
    const en = h("input", { value: it.name }) as HTMLInputElement;
    const ei = h("input", { value: it.image_url || "", placeholder: "https://…/image.jpg" }) as HTMLInputElement;
    const eo = h("input", { value: it.note || "" }) as HTMLInputElement;
    let bodyEls: HTMLElement[];
    let ep: HTMLInputElement, eq: HTMLInputElement, es: HTMLInputElement, eg: HTMLInputElement;
    if (it.kind === "cash") {
      eg = h("input", { type: "number", min: "0", step: "0.01", value: it.goal ? String(it.goal) : "" }) as HTMLInputElement;
      bodyEls = [field("Name", en), field("Target amount (optional)", eg), field("Image URL", ei), field("Note", eo)];
    } else {
      ep = h("input", { type: "number", min: "0", step: "0.01", value: String(it.price) }) as HTMLInputElement;
      eq = h("input", { type: "number", min: "1", value: String(it.qty_wanted) }) as HTMLInputElement;
      es = h("input", { type: "checkbox", checked: it.allow_split }) as HTMLInputElement;
      bodyEls = [field("Name", en), h("div", { class: "gr-form-grid" }, field("Price", ep), field("Qty wanted", eq)), h("label", { class: "gr-check" }, es, " Allow group gifting"), field("Image URL", ei), field("Note", eo)];
    }
    openModal({ title: it.kind === "cash" ? "Edit cash fund" : "Edit gift", body: h("div", { class: "gr-form" }, ...bodyEls), actions: [{ label: "Save", primary: true, onClick: () => { void (async () => {
      try {
        const payload: any = it.kind === "cash"
          ? { name: en.value, goal_amount: Number(eg!.value) || null, note: eo.value || null, image_url: ei.value || null }
          : { name: en.value, price: Number(ep!.value), qty_wanted: Number(eq!.value) || 1, allow_split: es!.checked, note: eo.value || null, image_url: ei.value || null };
        await bvApi(`/api/items/${it.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        document.querySelector(".bv-scrim")?.remove(); await reload(); refreshCount();
      } catch (err: any) { toast(err?.message || "error", "error"); }
    })(); } }] });
  };
  const refreshCount = () => { shell.select("registries"); };
  openModal({ title: `Gifts · ${r.title}`, body: h("div", { class: "gr-manage" }, list, h("div", { class: "gr-divider" }), form), actions: [{ label: "Done", onClick: () => {} }] });
  void reload();
}

/* ----------------------------------------------------------------- Analytics */
async function openAnalytics(r: Registry) {
  const body = h("div", { class: "gr-analytics" }, h("div", { class: "bv-muted" }, "Loading…"));
  openModal({ title: `Analytics · ${r.title}`, body, actions: [{ label: "Export contributors (CSV)", onClick: () => { window.open(`/api/registries/${r.id}/contributors.csv`, "_blank"); } }, { label: "Invite guests", onClick: () => openInvite(r) }, { label: "Close", onClick: () => {} }] });
  try {
    const a = await bvApi<{ raised: number; goal: number; pct: number; items: number; funded_items: number; contributors: number; contributions: number; thanked: number; currency: string; top: { name: string; raised: number; goal: number; funded: boolean }[] }>(`/api/registries/${r.id}/analytics`);
    body.innerHTML = "";
    body.append(statRow([
      { k: "Raised", v: fmtMoney(a.raised, a.currency), tone: "accent", icon: "coins" },
      { k: "Funded", v: `${a.pct}%`, tone: "ok", icon: "chart" },
      { k: "Contributors", v: String(a.contributors), icon: "heart" },
    ]));
    body.append(h("div", { class: "gr-prog", style: { margin: "10px 0 14px" } }, h("div", { class: "gr-bar" }, h("i", { style: { width: `${a.pct}%`, background: r.accent } })), h("div", { class: "bv-muted gr-prog-label" }, `${fmtMoney(a.raised, a.currency)} of ${fmtMoney(a.goal, a.currency)} · ${a.funded_items} of ${a.items} gifts funded · ${a.thanked}/${a.contributions} thanked`)));
    if (a.top?.length) {
      body.append(h("div", { class: "bv-label", style: { margin: "4px 0 6px" } }, "Top gifts"));
      const tbl = h("div", { class: "gr-top" });
      for (const t of a.top) tbl.append(h("div", { class: "gr-top-row" }, h("span", null, t.name), h("span", { class: "bv-muted" }, `${fmtMoney(t.raised, a.currency)}${t.goal ? ` / ${fmtMoney(t.goal, a.currency)}` : ""}`), t.funded ? pill("funded", "ok") : pill("open")));
      body.append(tbl);
    }
  } catch (err: any) { body.innerHTML = ""; body.append(h("div", { class: "bv-muted" }, err?.message || "Couldn't load analytics")); }
}

function openInvite(r: Registry) {
  const ta = h("textarea", { rows: "4", placeholder: "guest1@email.com, guest2@email.com …" }) as HTMLTextAreaElement;
  openModal({ title: `Invite guests · ${r.title}`, body: h("div", { class: "gr-form" }, h("p", { class: "bv-muted" }, "Email the registry link to your guest list (comma or newline separated)."), field("Guest emails", ta)), actions: [{ label: "Send invites", primary: true, onClick: () => { void (async () => {
    try { const res = await bvApi<{ sent: number; total: number }>(`/api/registries/${r.id}/invite`, { method: "POST", body: JSON.stringify({ emails: ta.value }) }); document.querySelector(".bv-scrim")?.remove(); flash(`Invited ${res.sent} of ${res.total}`, "success"); }
    catch (err: any) { toast(err?.message || "Couldn't send invites", "error"); }
  })(); } }] });
}

/* --------------------------------------------------------------------- Gifts */
async function renderGifts(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let gifts: Gift[];
  try { gifts = (await bvApi<{ gifts: Gift[] }>("/api/gifts?refresh=1")).gifts; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  const unthanked = gifts.filter((g) => !g.thanked).length;
  host.append(statRow([
    { k: "Gifts received", v: String(gifts.length), icon: "heart" },
    { k: "Total raised", v: fmtMoney(gifts.reduce((s, g) => s + g.amount, 0), currency), tone: "accent", icon: "coins" },
    { k: "To thank", v: String(unthanked), tone: unthanked ? "accent" : "ok", icon: "check" },
  ]));

  host.append(card({ title: "Gifts received", body: gifts.length ? dataTable<Gift>({
    columns: [
      { head: "When", cell: (g) => h("span", { class: "bv-muted" }, relTime(g.created_at)) },
      { head: "Gift", cell: (g) => h("div", null, h("strong", null, g.item_name || "—"), g.registry_title ? h("div", { class: "bv-muted" }, g.registry_title) : null) },
      { head: "From", cell: (g) => h("div", null, h("span", null, g.buyer_name || "—"), g.buyer_email ? h("div", { class: "bv-muted gr-gift-msg" }, g.buyer_email) : null, g.message ? h("div", { class: "bv-muted gr-gift-msg" }, `"${g.message}"`) : null) },
      { head: "Amount", num: true, cell: (g) => fmtMoney(g.amount, g.currency) },
      { head: "Thank-you", cell: (g) => thankToggle(g) },
    ], rows: gifts,
  }) : emptyState({ icon: "heart", title: "No gifts yet", text: "When guests fund a gift, it shows up here." }) }));
}

function thankToggle(g: Gift) {
  const btn = h("button", { class: g.thanked ? "ghost sm" : "primary sm", onClick: async () => {
    try { const next = !g.thanked; await bvApi(`/api/gifts/${g.id}`, { method: "PATCH", body: JSON.stringify({ thanked: next }) }); g.thanked = next; btn.className = next ? "ghost sm" : "primary sm"; btn.replaceChildren(...content(next)); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  } }, ...content(g.thanked));
  function content(t: boolean) { return [iconEl(t ? "check" : "send", 13), document.createTextNode(t ? " Thanked" : " Mark thanked")]; }
  return btn;
}

function field(label: string, el: HTMLElement) { return h("label", { class: "gr-field" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Gift Registry couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
