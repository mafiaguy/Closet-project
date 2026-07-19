// fetch-images.mjs — open every linked piece in REAL Chrome and save its
// product image into the wardrobe. Bot walls don't apply to an actual browser
// on a residential IP: to the store, this is just you, shopping.
//
// Setup (once):   npm i playwright
// Usage:          SUPABASE_URL=... SERVICE_ROLE_KEY=... node scripts/fetch-images.mjs
// Flags:
//   --force            refresh images for ALL linked pieces (default: only missing)
//   --ids=id1,id2      only these piece ids
//
// A Chrome window opens and walks the links; if a store shows a captcha,
// solve it by hand and the job continues.

import { chromium } from "playwright";

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SERVICE_ROLE_KEY;
if (!SB || !KEY) {
  console.error("Set SUPABASE_URL and SERVICE_ROLE_KEY");
  process.exit(1);
}
const H = KEY.startsWith("sb_")
  ? { apikey: KEY }
  : { apikey: KEY, Authorization: `Bearer ${KEY}` };

const args = process.argv.slice(2);
const force = args.includes("--force");
const idsArg = args.find((a) => a.startsWith("--ids="));
const onlyIds = idsArg ? idsArg.slice(6).split(",") : null;

const rows = await (await fetch(
  `${SB}/rest/v1/wardrobe?select=id,title,link,plate_url&link=not.is.null&order=created_at.desc`,
  { headers: H },
)).json();
if (!Array.isArray(rows)) {
  console.error("Could not list wardrobe:", rows);
  process.exit(1);
}
const targets = rows.filter((r) =>
  onlyIds ? onlyIds.includes(r.id) : (force || !r.plate_url)
);
console.log(`${targets.length} piece(s) need images`);
if (!targets.length) process.exit(0);

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
});

let ok = 0, fail = 0;
for (const row of targets) {
  try {
    console.log(`\n→ ${row.title}`);
    await page.goto(row.link, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4500); // let the gallery render (and you solve any captcha)

    const imgUrl = await page.evaluate(() => {
      const bad = /logo|icon|sprite|favicon|placeholder|badge/i;
      const og = document.querySelector('meta[property="og:image"]');
      if (og && og.content && !bad.test(og.content)) return og.content;
      let best = null, size = 0;
      for (const im of document.images) {
        const s = im.naturalWidth * im.naturalHeight;
        if (im.naturalWidth >= 350 && s > size && !bad.test(im.src)) {
          best = im.src; size = s;
        }
      }
      return best;
    });
    if (!imgUrl) { console.log("  ✗ no usable image on the page"); fail++; continue; }

    // download inside the page session (same cookies, same fingerprint)
    const b64 = await page.evaluate(async (u) => {
      const r = await fetch(u);
      const blob = await r.blob();
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result.split(",")[1]);
        fr.readAsDataURL(blob);
      });
    }, imgUrl);
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length < 5000) { console.log("  ✗ image too small, skipped"); fail++; continue; }

    const path = `tiles/${row.id}.jpg`;
    const up = await fetch(`${SB}/storage/v1/object/closet/${path}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "image/jpeg", "x-upsert": "true" },
      body: bytes,
    });
    if (!up.ok) throw new Error(`upload ${up.status}: ${await up.text()}`);

    const publicUrl = `${SB}/storage/v1/object/public/closet/${path}`;
    const patch = await fetch(`${SB}/rest/v1/wardrobe?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ plate_url: publicUrl }),
    });
    if (!patch.ok) throw new Error(`row update ${patch.status}`);
    console.log(`  ✓ saved (${Math.round(bytes.length / 1024)} KB) ${imgUrl.slice(0, 70)}…`);
    ok++;
    await page.waitForTimeout(2500); // politeness between stores
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
    fail++;
  }
}
await browser.close();
console.log(`\nDone: ${ok} saved, ${fail} failed. Hard-refresh the site.`);
