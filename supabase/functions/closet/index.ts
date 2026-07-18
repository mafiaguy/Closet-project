// Devika's Closet · Supabase Edge Function
// Actions: add (photo -> AI catalogue tile -> DB row), tryon (piece -> her AI fitting), delete
// Secrets required:  GEMINI_API_KEY   (and optionally CLOSET_PIN)
// Deploy:            supabase functions deploy closet

import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const PIN = Deno.env.get("CLOSET_PIN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const MODELS = ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview"];

const BASE_PHOTO_URL = `${SB_URL}/storage/v1/object/public/closet/base/devika.webp`;

// Free fallback: Kolors Virtual Try-On on Hugging Face Spaces.
// Optional secrets: HF_TOKEN (free account token, eases rate limits),
// HF_SPACE (override if the space moves).
const HF_SPACE = Deno.env.get("HF_SPACE") ?? "Kwai-Kolors/Kolors-Virtual-Try-On";
const HF_TOKEN = Deno.env.get("HF_TOKEN") ?? "";

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

const TRYON_PROMPT =
  "Dress the woman from the first image in the garment shown in the second image. Keep her " +
  "face, hair, skin tone, body shape, pose and the background exactly the same. Replace her " +
  "current outfit with the new garment, fitted naturally with realistic drape, lighting and " +
  "shadows. Output a single photorealistic image.";

const supabase = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-closet-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (PIN && req.headers.get("x-closet-pin") !== PIN) {
      return json({ error: "Wrong or missing closet PIN." }, 401);
    }
    if (!GEMINI_KEY) return json({ error: "GEMINI_API_KEY secret is not set." }, 500);

    const body = await req.json();
    switch (body.action) {
      case "add":
        return json(await addItem(body));
      case "tryon":
        return json(await tryOn(body));
      case "set_tryon":
        return json(await setTryon(body));
      case "fetch_link":
        return json(await fetchLink(body));
      case "delete":
        return json(await deleteItem(body));
      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

/* ------------------------------ actions ------------------------------ */

async function addItem(b: {
  image: string; // base64, no data: prefix
  mime: string;
  title?: string;
  brand?: string;
  category?: string;
  skipAi?: boolean;
  imageUrl?: string;
  link?: string;
}) {
  if (b.imageUrl && !b.image) {
    const fetched = await fetchAsB64(b.imageUrl);
    b.image = fetched.data;
    b.mime = fetched.mime;
  }
  if (!b.image) throw new Error("No image provided.");
  let plateUrl: string;
  if (b.skipAi) {
    // the uploaded image is already a clean catalogue shot — store as-is
    plateUrl = await upload(
      `tiles/${crypto.randomUUID()}.${ext(b.mime)}`,
      b.image,
      b.mime || "image/jpeg",
    );
  } else {
    const out = await gemini([
      { inline_data: { mime_type: b.mime || "image/jpeg", data: b.image } },
      { text: EXTRACT_PROMPT },
    ]);
    plateUrl = await upload(
      `tiles/${crypto.randomUUID()}.png`,
      out.data,
      out.mimeType ?? "image/png",
    );
  }
  const { data, error } = await supabase
    .from("wardrobe")
    .insert({
      title: b.title || "Untitled piece",
      brand: b.brand || "",
      category: b.category || "Dress",
      plate_url: plateUrl,
      link: b.link || null,
    })
    .select()
    .single();
  if (error) throw error;
  return { item: data };
}

async function tryOn(b: { id: string }) {
  const { data: row, error } = await supabase
    .from("wardrobe")
    .select("*")
    .eq("id", b.id)
    .single();
  if (error) throw error;
  if (row.tryon_url) return { tryon: row.tryon_url };

  const [base, garment] = await Promise.all([
    fetchAsB64(BASE_PHOTO_URL),
    fetchAsB64(row.plate_url),
  ]);
  let out: { mimeType?: string; data: string };
  try {
    out = await gemini([
      { inline_data: { mime_type: base.mime, data: base.data } },
      { inline_data: { mime_type: garment.mime, data: garment.data } },
      { text: TRYON_PROMPT },
    ]);
  } catch (geminiErr) {
    try {
      out = await Promise.race([
        hfTryOn(base, garment),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error("free GPU queue is too long right now \u2014 try again off-peak (late night works), or use \u2018Upload her look\u2019")),
            100_000,
          )
        ),
      ]);
    } catch (hfErr) {
      throw new Error(
        `Gemini: ${(geminiErr as Error).message} | HF fallback: ${(hfErr as Error).message}`,
      );
    }
  }
  const url = await upload(`looks/${b.id}.png`, out.data, out.mimeType ?? "image/png");
  await supabase.from("wardrobe").update({ tryon_url: url }).eq("id", b.id);
  return { tryon: url };
}

async function setTryon(b: { id: string; image: string; mime: string }) {
  const url = await upload(
    `looks/${b.id}-manual.${ext(b.mime)}`,
    b.image,
    b.mime || "image/jpeg",
  );
  const { error } = await supabase
    .from("wardrobe").update({ tryon_url: url }).eq("id", b.id);
  if (error) throw error;
  return { tryon: url };
}

async function deleteItem(b: { id: string }) {
  const { data: row } = await supabase
    .from("wardrobe").select("*").eq("id", b.id).single();
  const { error } = await supabase.from("wardrobe").delete().eq("id", b.id);
  if (error) throw error;
  // best-effort storage cleanup
  if (row) {
    const paths = [row.plate_url, row.tryon_url]
      .filter(Boolean)
      .map((u: string) => u.split("/object/public/closet/")[1])
      .filter(Boolean);
    if (paths.length) await supabase.storage.from("closet").remove(paths);
  }
  return { ok: true };
}

/* ------------------------------ helpers ------------------------------ */

type Part =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

async function gemini(parts: Part[]) {
  let lastErr = "No image model available on this key.";
  for (const model of MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      },
    );
    if (r.status === 404) continue;
    const j = await r.json();
    if (j.error) {
      lastErr = j.error.message ?? "Gemini error";
      continue;
    }
    const part = j.candidates?.[0]?.content?.parts?.find(
      (p: { inlineData?: { data?: string } }) => p.inlineData?.data,
    );
    if (part) return part.inlineData as { mimeType?: string; data: string };
    lastErr = "The model returned no image — try again.";
  }
  throw new Error(lastErr);
}

async function upload(path: string, b64: string, mime: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const { error } = await supabase.storage
    .from("closet")
    .upload(path, bytes, { contentType: mime, upsert: true });
  if (error) throw error;
  return `${SB_URL}/storage/v1/object/public/closet/${path}`;
}

async function fetchLink(b: { url: string }) {
  let base: { title: string | null; image: string | null; brand: string | null } | null = null;
  try {
    const direct = await fetchLinkDirect(b.url);
    if (direct.title || direct.image) base = direct;
  } catch (_) { /* fall through */ }
  if (!base) base = await fetchLinkViaMicrolink(b.url);
  let images: string[] = [];
  try { images = await harvestImages(b.url); } catch (_) { /* optional */ }
  if (base.image && !images.includes(base.image)) images.unshift(base.image);
  return { ...base, images: images.slice(0, 8) };
}

// render the page like a real browser and collect the product gallery
async function harvestImages(url: string): Promise<string[]> {
  const r = await fetch("https://r.jina.ai/" + url, {
    headers: { "Accept": "text/plain", "X-Timeout": "20" },
  });
  if (!r.ok) return [];
  const md = await r.text();
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    u = u.replace(/[)\],.]+$/, "");
    if (seen.has(u)) return;
    if (/\.(svg)(\?|$)/i.test(u)) return;
    if (/logo|icon|sprite|favicon|avatar|placeholder|tracking|pixel/i.test(u)) return;
    seen.add(u); found.push(u);
  };
  for (const m of md.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g)) push(m[1]);
  for (const m of md.matchAll(/https?:\/\/[^\s"'<>)\]]+\.(?:jpe?g|png|webp)[^\s"'<>)\]]*/gi)) push(m[0]);
  return found;
}

async function fetchLinkViaMicrolink(url: string) {
  const r = await fetch("https://api.microlink.io/?url=" + encodeURIComponent(url));
  const j = await r.json();
  if (j.status !== "success" || !j.data) {
    throw new Error("The store blocks fetching \u2014 upload a screenshot of the product instead.");
  }
  return {
    title: (j.data.title ?? "").split(/\s*[|\u2013\u2014]\s*/)[0].trim(),
    image: j.data.image?.url ?? j.data.logo?.url ?? null,
    brand: j.data.publisher ?? null,
  };
}

async function fetchLinkDirect(url: string) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });
  if (!r.ok) throw new Error(`The store blocked the request (${r.status}). Upload a screenshot of the product instead.`);
  const html = await r.text();

  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:property|name)=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const val = /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && val && !(key in meta)) meta[key] = val;
  }
  const decode = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
     .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();

  let title = meta["og:title"] ?? meta["twitter:title"] ??
    (/<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? "");
  title = decode(title).split(/\s*[|\u2013\u2014]\s*/)[0].split(/\s+-\s+/)[0].trim();

  let image = meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"] ?? null;
  if (image) {
    try { image = new URL(decode(image), r.url).href; } catch { image = null; }
  }
  const site = meta["og:site_name"] ? decode(meta["og:site_name"]) : null;
  return { title, image, brand: site };
}

function ext(mime: string) {
  if (!mime) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

// --- Hugging Face Spaces fallback: Kolors Virtual Try-On (official client) ---
async function hfTryOn(
  base: { mime: string; data: string },
  garment: { mime: string; data: string },
) {
  // lazy import: if the package fails to load, only this fallback path
  // errors — the rest of the function keeps working
  let GradioClient;
  try {
    ({ Client: GradioClient } = await import("npm:@gradio/client@1"));
  } catch (e) {
    throw new Error("gradio client failed to load in the edge runtime: " + (e as Error).message);
  }
  const opts: Record<string, unknown> = {};
  // deno-lint-ignore no-explicit-any
  if (HF_TOKEN) (opts as any).hf_token = HF_TOKEN;
  const client = await GradioClient.connect(HF_SPACE, opts);

  const toBlob = (img: { mime: string; data: string }) =>
    new Blob([Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0))], {
      type: img.mime,
    });

  const result = await client.predict("/tryon", [
    toBlob(base),     // person_img
    toBlob(garment),  // garment_img
    0,                // seed
    true,             // randomize_seed
  ]);

  // returns [result_image, seed, info]
  // deno-lint-ignore no-explicit-any
  const data = result.data as any[];
  const img = data?.[0];
  const info = typeof data?.[2] === "string" ? data[2] : "";
  const url: string | null = img?.url ?? null;
  if (!url) {
    throw new Error(
      info && info !== "Success"
        ? `space says: ${info}`
        : "space returned no image (overloaded) \u2014 try again in a minute",
    );
  }
  const fetched = await fetchAsB64(url);
  return { mimeType: fetched.mime, data: fetched.data };
}

async function fetchAsB64(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch ${url} (${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return { mime: r.headers.get("content-type") ?? "image/webp", data: btoa(s) };
}
