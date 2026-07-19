// worker-harvest.mjs — background worker (GitHub Actions) that finds pieces
// with a store link but no photo, opens each link in headless Chromium,
// harvests every gallery image candidate, and writes them to pending_images.
// NOTHING is saved as the piece's photo here — the user approves the right
// colour on the site, which is when the image actually lands in the bucket.
//
// Env: SUPABASE_URL, SERVICE_ROLE_KEY

import { chromium } from "playwright";

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("Missing env"); process.exit(1); }
const H = KEY.startsWith("sb_") ? { apikey: KEY } : { apikey: KEY, Authorization: `Bearer ${KEY}` };

const rows = await (await fetch(
  `${SB}/rest/v1/wardrobe?select=id,title,link,plate_url,pending_images&link=not.is.null&plate_url=is.null`,
  { headers: H },
)).json();
const targets = (Array.isArray(rows) ? rows : []).filter((r) => !(r.pending_images && r.pending_images.length));
console.log(`${targets.length} piece(s) to harvest`);
if (!targets.length) process.exit(0);

const bad = /logo|icon|sprite|favicon|placeholder|badge|\.svg(\?|$)/i;

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
  locale: "en-IN",
});
const page = await ctx.newPage();

async function harvestFromPage(url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000);
  return await page.evaluate(() => {
    const bad = /logo|icon|sprite|favicon|placeholder|badge/i;
    const out = [];
    const seen = new Set();
    const push = (u) => { if (u && !seen.has(u) && !bad.test(u)) { seen.add(u); out.push(u); } };
    const og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) push(og.content);
    const imgs = [...document.images]
      .filter((im) => im.naturalWidth >= 300 && im.naturalHeight >= 300)
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    for (const im of imgs) push(im.currentSrc || im.src);
    return out.slice(0, 10);
  });
}

async function harvestFromSearchIndex(title, host) {
  const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36" };
  const q = encodeURIComponent(`${title} ${host}`);
  const p = await fetch(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, { headers: UA });
  const html = await p.text();
  const vm = /vqd=["']?([\d-]+)/.exec(html);
  if (!vm) return [];
  const r = await fetch(`https://duckduckgo.com/i.js?l=in-en&o=json&q=${q}&vqd=${vm[1]}&p=1`,
    { headers: { ...UA, Referer: "https://duckduckgo.com/" } });
  if (!r.ok) return [];
  const j = await r.json();
  const res = j.results ?? [];
  const store = res.filter((x) => (x.url ?? "").includes(host));
  return (store.length ? store : res).slice(0, 8).map((x) => x.image).filter((u) => u && !bad.test(u));
}

let done = 0;
for (const row of targets) {
  try {
    console.log(`\n→ ${row.title}`);
    const host = new URL(row.link).hostname.replace(/^www\./, "");
    let candidates = [];
    try { candidates = await harvestFromPage(row.link); } catch (e) { console.log("  page:", e.message); }
    if (candidates.length < 2) {
      const extra = await harvestFromSearchIndex(row.title, host);
      for (const u of extra) if (!candidates.includes(u)) candidates.push(u);
    }
    candidates = candidates.filter((u) => !bad.test(u)).slice(0, 10);
    if (!candidates.length) { console.log("  nothing found"); continue; }
    const patch = await fetch(`${SB}/rest/v1/wardrobe?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ pending_images: candidates }),
    });
    if (!patch.ok) throw new Error(`patch ${patch.status}: ${await patch.text()}`);
    console.log(`  ✓ ${candidates.length} candidates queued for approval`);
    done++;
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
  }
}
await browser.close();
console.log(`\n${done} piece(s) now await approval on the site.`);
