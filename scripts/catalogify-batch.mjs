// Devika's Closet · fully automated bulk cataloguer
//
// Drop raw outfit photos (the Instagram crops) into batch/raw/ and run.
// For EACH photo it will automatically:
//   1. ask Gemini to name + categorise the piece        (text model)
//   2. generate the clean ghost-mannequin catalogue tile (image model)
//   3. upload tile to storage, attach the original photo as "the look"
//   4. insert the wardrobe row
// Resumable: progress saved to batch/done.json — re-run anytime, it skips
// what's finished. Rate-limited + retries on 429.
//
// Requires a Gemini key with billing enabled (GCP free trial works).
//
// Usage (repo root, Node 18+):
//   GEMINI_API_KEY=AIza... \
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SERVICE_ROLE_KEY=<sb_secret_...> \
//   node scripts/catalogify-batch.mjs

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";

const GKEY = process.env.GEMINI_API_KEY;
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SERVICE_ROLE_KEY;
if (!GKEY || !SB || !KEY) {
  console.error("Set GEMINI_API_KEY, SUPABASE_URL and SERVICE_ROLE_KEY.");
  process.exit(1);
}
const AUTH = KEY.startsWith("sb_") ? { apikey: KEY } : { apikey: KEY, Authorization: `Bearer ${KEY}` };

const RAW = "batch/raw";
const DONE_FILE = "batch/done.json";
const IMG_MODELS = ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview"];
const TXT_MODEL = "gemini-2.5-flash";
const DELAY_MS = 7000; // stay under image-gen RPM limits
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const EXTRACT_PROMPT =
  "Edit this photo: remove the person completely and keep only the clothing, presented as a " +
  "professional e-commerce product photograph in invisible ghost-mannequin style. The garment " +
  "keeps its natural worn shape and volume, but no skin, hair, hands, face, or phone is visible. " +
  "Seamlessly reconstruct any fabric that was hidden behind arms, hair, bag, or phone so the " +
  "garment is complete, with clean smooth edges. Do not change the garment's color, print, " +
  "fabric texture, or design in any way. If the outfit has multiple pieces, show them together " +
  "as one neatly styled set. Background: plain warm-ivory studio backdrop (#F0EBDF), soft even " +
  "lighting, subtle soft shadow under the garment, centered with even margins, portrait 3:4. " +
  "No text, no watermark, no props, no visible mannequin.";

const NAME_PROMPT =
  'Look at the outfit this woman is wearing. Reply with JSON only, no markdown: ' +
  '{"title":"<elegant 3-5 word product name, e.g. Lilac Halter Maxi Dress>",' +
  '"category":"<exactly one of: Dress, Top, Bottom, Co-ord, Saree, Ethnic, Outerwear>"}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gemini(model, parts, attempt = 0) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GKEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }] }) },
  );
  if (r.status === 429 && attempt < 5) {
    const wait = 20000 * (attempt + 1);
    console.log(`    rate-limited, waiting ${wait / 1000}s...`);
    await sleep(wait);
    return gemini(model, parts, attempt + 1);
  }
  const j = await r.json();
  if (j.error) throw new Error(`${model}: ${j.error.message}`);
  return j;
}

async function makeTile(img) {
  for (const m of IMG_MODELS) {
    try {
      const j = await gemini(m, [{ inline_data: { mime_type: img.mime, data: img.data } }, { text: EXTRACT_PROMPT }]);
      const p = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (p) return { mime: p.inlineData.mimeType ?? "image/png", data: p.inlineData.data };
    } catch (e) {
      if (!String(e).includes("not found") && !String(e).includes("404")) throw e;
    }
  }
  throw new Error("no image model produced a tile");
}

async function nameIt(img) {
  try {
    const j = await gemini(TXT_MODEL, [{ inline_data: { mime_type: img.mime, data: img.data } }, { text: NAME_PROMPT }]);
    const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const m = /\{[\s\S]*\}/.exec(txt);
    const o = JSON.parse(m[0]);
    const cats = ["Dress", "Top", "Bottom", "Co-ord", "Saree", "Ethnic", "Outerwear"];
    return { title: String(o.title).slice(0, 60), category: cats.includes(o.category) ? o.category : "Dress" };
  } catch {
    return { title: "Untitled piece", category: "Dress" };
  }
}

async function upload(path, mime, buf) {
  const r = await fetch(`${SB}/storage/v1/object/closet/${path}`, {
    method: "POST", headers: { ...AUTH, "Content-Type": mime, "x-upsert": "true" }, body: buf,
  });
  if (!r.ok) throw new Error(`upload: ${r.status} ${await r.text()}`);
  return `${SB}/storage/v1/object/public/closet/${path}`;
}

// ---- main ----
if (!existsSync(RAW)) { mkdirSync(RAW, { recursive: true }); console.error(`Created ${RAW}/ — drop the outfit photos in and re-run.`); process.exit(1); }
const done = existsSync(DONE_FILE) ? JSON.parse(readFileSync(DONE_FILE, "utf8")) : {};
const files = readdirSync(RAW).filter((f) => MIME[extname(f).toLowerCase()]);
const todo = files.filter((f) => !done[f]);
console.log(`${files.length} photos, ${todo.length} to process\n`);

let i = 0;
for (const f of todo) {
  i++;
  const ext = extname(f).toLowerCase();
  const img = { mime: MIME[ext], data: readFileSync(join(RAW, f)).toString("base64") };
  try {
    const meta = await nameIt(img);
    const tile = await makeTile(img);
    const id = crypto.randomUUID();
    const plate_url = await upload(`tiles/${id}.png`, tile.mime, Buffer.from(tile.data, "base64"));
    const tryon_url = await upload(`looks/${id}${ext}`, img.mime, readFileSync(join(RAW, f)));
    const r = await fetch(`${SB}/rest/v1/wardrobe`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ title: meta.title, brand: "", category: meta.category, plate_url, tryon_url }),
    });
    if (!r.ok) throw new Error(`insert: ${r.status} ${await r.text()}`);
    done[f] = { title: meta.title, category: meta.category };
    writeFileSync(DONE_FILE, JSON.stringify(done, null, 2));
    console.log(`[${i}/${todo.length}] \u2713 ${meta.category} \u00b7 ${meta.title}   (${f})`);
  } catch (e) {
    console.log(`[${i}/${todo.length}] \u2717 ${f}: ${e.message}`);
  }
  await sleep(DELAY_MS);
}
console.log("\nRun complete. Re-run to retry any \u2717 failures. Hard-refresh the site.");
