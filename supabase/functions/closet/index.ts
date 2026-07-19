// Devika's Closet · Supabase Edge Function
// Actions: add (photo -> AI catalogue tile -> DB row), tryon (piece -> her AI fitting), delete
// Secrets required:  GEMINI_API_KEY   (and optionally CLOSET_PIN)
// Deploy:            supabase functions deploy closet

import { createClient } from "npm:@supabase/supabase-js@2";

// third-party libs (gradio client) can leak unhandled rejections that would
// otherwise kill the worker mid-request — absorb them and log instead
addEventListener("unhandledrejection", (e) => {
  console.error("unhandled rejection absorbed:", e.reason);
  e.preventDefault();
});

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const PIN = Deno.env.get("CLOSET_PIN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const MODELS = ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview"];

const BASE_PHOTO_URL = `${SB_URL}/storage/v1/object/public/closet/base/devika.webp`;

// Free fallback: Kolors Virtual Try-On on Hugging Face Spaces.
// Optional secrets: HF_TOKEN (free account token, eases rate limits),
// HF_SPACE (override if the space moves).
const HF_SPACE = Deno.env.get("HF_SPACE") ?? "yisol/IDM-VTON";
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
      case "approve_image":
        return json(await approveImage(body));
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
  if (!b.image && !b.link) throw new Error("No image provided.");
  if (!b.image) {
    // image-less link add: hang the piece now, fetch-images job fills the photo later
    const { data, error } = await supabase.from("wardrobe").insert({
      title: b.title || "Untitled piece",
      brand: b.brand || "",
      category: b.category || "Dress",
      plate_url: null,
      link: b.link || null,
    }).select().single();
    if (error) throw new Error(error.message);
    return { item: data };
  }
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

async function approveImage(b: { id: string; url: string }) {
  if (!b.id || !b.url) throw new Error("Missing id or url.");
  let plateUrl: string;
  try {
    const r = await fetch(b.url, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
    });
    if (!r.ok) throw new Error(String(r.status));
    const mime = r.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length < 4000) throw new Error("too small");
    plateUrl = await upload(`tiles/${b.id}.jpg`, bytes, mime);
  } catch (_) {
    plateUrl = b.url; // CDN hotlink fallback — image CDNs rarely block direct loads
  }
  const { data, error } = await supabase.from("wardrobe")
    .update({ plate_url: plateUrl, pending_images: null })
    .eq("id", b.id).select().single();
  if (error) throw new Error(error.message);
  return { item: data };
}

const junkTitle = (t: string | null | undefined) =>
  !t || t.trim().length < 4 ||
  /maintenance|access denied|denied|robot|captcha|attention required|just a moment|error|blocked|unavailable|forbidden|security|verify|login|sign in|are you a human/i.test(t);

async function fetchLink(b: { url: string }) {
  const url = await resolveUrl(b.url); // expand shortlinks (dl.flipkart.com etc.)
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();

  let base: { title: string | null; image: string | null; brand: string | null } | null = null;
  try {
    const direct = await fetchLinkDirect(url);
    // a junk title with no image is a bot wall, not a success — keep going
    if (direct.image || !junkTitle(direct.title)) base = direct;
  } catch (_) { /* next layer */ }
  if (!base || !base.image) {
    try {
      const m = await fetchLinkViaMicrolink(url);
      base = {
        title: !junkTitle(base?.title) ? base!.title : m.title,
        image: m.image ?? base?.image ?? null,
        brand: m.brand ?? base?.brand ?? null,
      };
    } catch (_) { /* next layer */ }
  }
  let images: string[] = [];
  let jinaTitle: string | null = null;
  try {
    const j = await jinaRead(url);
    images = j.images;
    jinaTitle = j.title;
  } catch (_) { /* optional */ }

  const slug = slugInfo(url);
  let title = ([base?.title, jinaTitle, slug.title].find((t) => !junkTitle(t)) ?? "").trim();
  let brand = base?.brand ?? null;
  if (brand && /https?:|[\[\]()]/.test(brand)) brand = null;

  const junkImage = (u: string | null | undefined) =>
    !u || /logo|icon|favicon|sprite|placeholder|app-?store|play-?store|badge|\/web\/assets\//i.test(u);
  images = images.filter((u) => !junkImage(u));
  const image = (!junkImage(base?.image) ? base?.image : null) ?? images[0] ?? null;
  if (image && !images.includes(image)) images.unshift(image);

  // last resort for walled stores: the search index has the images even
  // when the store blocks us — crawlers are whitelisted through the wall
  let guessed = false;
  if (!images.length && title) {
    // walled store: relay titles may belong to related products — the URL's own
    // slug is the only text guaranteed to describe THIS item
    if (!junkTitle(slug.title)) title = slug.title!.trim();
    const q = slug.id ? title + " " + slug.id : title;
    try {
      images = await searchIndexImages(q, host);
      guessed = images.length > 0;
    } catch (_) { /* best effort */ }
  }
  if (!title && !images.length) {
    throw new Error("This store blocks every fetching route \u2014 upload a screenshot of the piece instead.");
  }
  return {
    title,
    // guesses from the web index are offered, never assumed
    image: guessed ? null : (image ?? images[0] ?? null),
    guessed,
    brand,
    category: slug.category,
    images: images.slice(0, 8),
  };
}

async function searchIndexImages(query: string, host: string): Promise<string[]> {
  const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36" };
  const q = encodeURIComponent(query + (host ? " " + host : ""));
  const page = await fetch(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, { headers: UA });
  const html = await page.text();
  const vm = /vqd=["']?([\d-]+)/.exec(html);
  if (!vm) return [];
  const r = await fetch(
    `https://duckduckgo.com/i.js?l=in-en&o=json&q=${q}&vqd=${vm[1]}&p=1`,
    { headers: { ...UA, "Referer": "https://duckduckgo.com/" } },
  );
  if (!r.ok) return [];
  const j = await r.json();
  // deno-lint-ignore no-explicit-any
  const results: any[] = j.results ?? [];
  const fromStore = results.filter((x) =>
    (x.url ?? "").includes(host) || (x.image ?? "").includes(host.split(".")[0]),
  );
  const pool = fromStore.length ? fromStore : results;
  return pool.slice(0, 8).map((x) => x.image).filter(Boolean);
}

async function resolveUrl(url: string): Promise<string> {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
    });
    let final = r.url || url;
    // shorteners that "redirect" via a JS interstitial instead of HTTP 3xx
    // (dl.flipkart.com, fkrt.cc, myntr.it, amzn.to ...) — the real product URL
    // is inside the interstitial HTML
    const h = (() => { try { return new URL(final).hostname; } catch { return ""; } })();
    if (/dl\.flipkart\.com|fkrt\.|myntr\.it|amzn\.|bit\.ly|tinyurl/i.test(h)) {
      const html = await r.text();
      const direct =
        /https?:\/\/(?:www\.)?(?:flipkart\.com|myntra\.com|amazon\.[a-z.]+|ajio\.com|meesho\.com|savana\.com)\/[^"'<>\s)\\]+/i
          .exec(html);
      if (direct) {
        final = direct[0].replace(/&amp;/g, "&");
      } else {
        const meta = /content=["']\d+;\s*url=([^"']+)["']/i.exec(html);
        if (meta) final = meta[1].replace(/&amp;/g, "&");
      }
    }
    return final;
  } catch { return url; }
}

// title / brand / category hidden in the URL path itself — unblockable
function slugInfo(url: string) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    let best = "";
    for (const s of segs) {
      if (/-/.test(s) && !/^\d+$/.test(s) && !/\.(html?|php)$/i.test(s) && s.length > best.length) best = s;
    }
    const title = best
      ? best.replace(/\d{6,}/g, "").replace(/-+/g, " ").trim()
          .split(" ").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ").slice(0, 70)
      : null;
    const p = u.pathname.toLowerCase();
    let category: string | null = null;
    if (/saree|sari/.test(p)) category = "Saree";
    else if (/kurta|kurti|anarkali|lehenga|ethnic|salwar/.test(p)) category = "Ethnic";
    else if (/bottom|jean|trouser|pant|skirt|short|palazzo|legging/.test(p)) category = "Bottom";
    else if (/jacket|blazer|coat|shrug|outerwear/.test(p)) category = "Outerwear";
    else if (/co-?ord|two-piece/.test(p)) category = "Co-ord";
    else if (/dress|gown|jumpsuit/.test(p)) category = "Dress";
    else if (/top|shirt|tshirt|t-shirt|tee|blouse|sweater/.test(p)) category = "Top";
    const idm = u.pathname.match(/\/(\d{5,})(?:\/|$)/);
    return { title, category, id: idm ? idm[1] : null };
  } catch { return { title: null, category: null, id: null }; }
}

// Jina reader gives us the rendered title too, not just images
async function jinaRead(url: string): Promise<{ title: string | null; images: string[] }> {
  const r = await fetch("https://r.jina.ai/" + url, {
    headers: { "Accept": "text/plain", "X-Timeout": "20" },
  });
  if (!r.ok) return { title: null, images: [] };
  const md = await r.text();
  const tm = /^Title:\s*(.+)$/m.exec(md);
  const title = tm ? tm[1].split(/\s*[|\u2013\u2014]\s*/)[0].trim() : null;
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
  return { title, images: found };
}


async function fetchLinkViaMicrolink(url: string) {
  const r = await fetch("https://api.microlink.io/?url=" + encodeURIComponent(url));
  const j = await r.json();
  if (j.status !== "success" || !j.data) {
    throw new Error("The store blocks fetching \u2014 upload a screenshot of the product instead.");
  }
  return {
    title: (j.data.title ?? "").split(/\s*[|\u2013\u2014]\s*/)[0].trim(),
    image: j.data.image?.url ?? null,
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

  // discover the try-on endpoint at runtime — spaces rename these
  // deno-lint-ignore no-explicit-any
  const api: any = await client.view_api();
  const named: Record<string, unknown> = api?.named_endpoints ?? {};
  const unnamed: Record<string, unknown> = api?.unnamed_endpoints ?? {};
  const imgParams = (ep: unknown) =>
    ((ep as { parameters?: unknown[] })?.parameters ?? [])
      .filter((p) => /image/i.test(JSON.stringify(p ?? {}))).length;

  // deno-lint-ignore no-explicit-any
  let endpoint: any = null;
  for (const name of Object.keys(named)) {
    if (/try|tryon|infer|generate|run/i.test(name) && imgParams(named[name]) >= 2) { endpoint = name; break; }
  }
  if (endpoint === null) {
    for (const name of Object.keys(named)) if (imgParams(named[name]) >= 2) { endpoint = name; break; }
  }
  if (endpoint === null) {
    for (const idx of Object.keys(unnamed)) if (imgParams(unnamed[idx]) >= 2) { endpoint = Number(idx); break; }
  }
  if (endpoint === null) {
    throw new Error(
      "space has no two-image endpoint; it exposes: " +
      (Object.keys(named).join(", ") || "(none named)") +
      " \u2014 set the HF_SPACE secret to a different try-on space",
    );
  }
  console.log("using space endpoint:", endpoint);

  // build arguments generically from the endpoint's own parameter schema
  // deno-lint-ignore no-explicit-any
  const epInfo: any = named[endpoint as string] ?? unnamed[String(endpoint)];
  // deno-lint-ignore no-explicit-any
  const params: any[] = epInfo?.parameters ?? [];
  const imgs = [toBlob(base), toBlob(garment)];
  let imgIdx = 0;
  const args = params.map((p) => {
    const sig = JSON.stringify(p ?? {});
    if (/imageeditor/i.test(sig)) {
      return { background: imgs[Math.min(imgIdx++, 1)], layers: [], composite: null };
    }
    if (/image/i.test(sig)) return imgs[Math.min(imgIdx++, 1)];
    if (p?.parameter_has_default) return p.parameter_default;
    if (/bool/i.test(sig)) return !/crop/i.test(sig);
    if (/int|float|number/i.test(sig)) return /step/i.test(sig) ? 30 : 42;
    if (/str/i.test(sig)) return "an elegant dress, exactly as shown";
    return null;
  });
  console.log("arg shapes:", args.map((a) => (a instanceof Blob ? "img" : typeof a)).join(","));
  const result = await client.predict(endpoint, args);

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
