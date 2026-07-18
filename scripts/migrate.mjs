// Devika's Closet · one-time migration of embedded pieces into Supabase
//
// Usage (from the repo root, Node 18+):
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SERVICE_ROLE_KEY=<service_role key from Project Settings -> API> \
//   node scripts/migrate.mjs --write
//
// Without --write it migrates but leaves index.html untouched (dry-ish run).
// Run it ONCE — running again will duplicate the rows.

import { readFileSync, writeFileSync } from "node:fs";

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SERVICE_ROLE_KEY;
if (!SB || !KEY) {
  console.error("Set SUPABASE_URL and SERVICE_ROLE_KEY environment variables first.");
  process.exit(1);
}

const AUTH = KEY.startsWith("sb_")
  ? { apikey: KEY }
  : { apikey: KEY, Authorization: `Bearer ${KEY}` };

const htmlPath = new URL("../index.html", import.meta.url);
let html = readFileSync(htmlPath, "utf8");

const marker = "var ITEMS = ";
const start = html.indexOf(marker);
const end = html.indexOf("];", start);
if (start < 0 || end < 0) {
  console.error("Could not find the embedded ITEMS array in index.html");
  process.exit(1);
}
const items = JSON.parse(html.slice(start + marker.length, end + 1));
console.log(`Found ${items.length} embedded pieces\n`);

async function upload(path, dataUri) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUri);
  if (!m) return null;
  const r = await fetch(`${SB}/storage/v1/object/closet/${path}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": m[1], "x-upsert": "true" },
    body: Buffer.from(m[2], "base64"),
  });
  if (!r.ok) throw new Error(`upload ${path}: ${r.status} ${await r.text()}`);
  return `${SB}/storage/v1/object/public/closet/${path}`;
}

for (const it of items) {
  const plate = it.plate ? await upload(`tiles/${it.id}.webp`, it.plate) : null;
  const tryon = it.tryon ? await upload(`looks/${it.id}.webp`, it.tryon) : null;
  const r = await fetch(`${SB}/rest/v1/wardrobe`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      title: it.title,
      brand: it.brand || "",
      category: it.category || "Dress",
      plate_url: plate,
      tryon_url: tryon,
    }),
  });
  if (!r.ok) throw new Error(`insert "${it.title}": ${r.status} ${await r.text()}`);
  console.log("  ✓", it.title);
}

if (process.argv.includes("--write")) {
  html = html.slice(0, start) + marker + "[]" + html.slice(end + 2);
  writeFileSync(htmlPath, html);
  console.log("\nindex.html rewritten: embedded pieces removed — the closet now loads from Supabase.");
  console.log("Commit and redeploy: git add . && git commit -m 'migrate to supabase' && git push");
} else {
  console.log("\nMigrated. Re-run with --write to empty the embedded list in index.html, then redeploy.");
}
