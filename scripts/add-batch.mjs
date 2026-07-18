// Devika's Closet · bulk add pieces to the Supabase wardrobe
//
// Folder layout (next to this script's parent, i.e. repo root):
//   batch/tiles/  -> clean catalogue images, named "Category - Title.png"
//                    e.g. "Dress - Lilac Halter Maxi.png"
//                    categories: Dress, Top, Bottom, Co-ord, Saree, Ethnic, Outerwear
//   batch/looks/  -> OPTIONAL: photo of her wearing it, SAME filename
//                    (any extension) -> becomes the "See the look" image
//
// Usage (Node 18+, from repo root):
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SERVICE_ROLE_KEY=<sb_secret_... key> \
//   node scripts/add-batch.mjs
//
// Safe to re-run only with NEW files (already-added ones will duplicate).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SERVICE_ROLE_KEY;
if (!SB || !KEY) {
  console.error("Set SUPABASE_URL and SERVICE_ROLE_KEY environment variables first.");
  process.exit(1);
}
const AUTH = KEY.startsWith("sb_")
  ? { apikey: KEY }
  : { apikey: KEY, Authorization: `Bearer ${KEY}` };

const TILES = "batch/tiles";
const LOOKS = "batch/looks";
const CATS = ["Dress", "Top", "Bottom", "Co-ord", "Saree", "Ethnic", "Outerwear"];
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

if (!existsSync(TILES)) {
  console.error(`Folder ${TILES}/ not found. Create it and drop your tiles in.`);
  process.exit(1);
}

async function upload(path, filePath) {
  const mime = MIME[extname(filePath).toLowerCase()] ?? "image/jpeg";
  const r = await fetch(`${SB}/storage/v1/object/closet/${path}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": mime, "x-upsert": "true" },
    body: readFileSync(filePath),
  });
  if (!r.ok) throw new Error(`upload ${path}: ${r.status} ${await r.text()}`);
  return `${SB}/storage/v1/object/public/closet/${path}`;
}

function findLook(stem) {
  if (!existsSync(LOOKS)) return null;
  const hit = readdirSync(LOOKS).find(
    (f) => f.replace(extname(f), "").toLowerCase() === stem.toLowerCase(),
  );
  return hit ? join(LOOKS, hit) : null;
}

const tiles = readdirSync(TILES).filter((f) => MIME[extname(f).toLowerCase()]);
console.log(`Found ${tiles.length} tiles\n`);

for (const f of tiles) {
  const stem = basename(f, extname(f));
  const m = /^\s*([^-]+?)\s*-\s*(.+)$/.exec(stem);
  const category = m && CATS.includes(m[1].trim()) ? m[1].trim() : "Dress";
  const title = m ? m[2].trim() : stem;
  const id = crypto.randomUUID();

  const plate_url = await upload(`tiles/${id}${extname(f).toLowerCase()}`, join(TILES, f));
  let tryon_url = null;
  const look = findLook(stem);
  if (look) tryon_url = await upload(`looks/${id}${extname(look).toLowerCase()}`, look);

  const r = await fetch(`${SB}/rest/v1/wardrobe`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ title, brand: "", category, plate_url, tryon_url }),
  });
  if (!r.ok) throw new Error(`insert "${title}": ${r.status} ${await r.text()}`);
  console.log(`  \u2713 ${category} \u00b7 ${title}${look ? "  (+look)" : ""}`);
}
console.log("\nDone. Hard-refresh the site.");
