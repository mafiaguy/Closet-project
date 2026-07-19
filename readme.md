# Devika's Closet 👗

A private online wardrobe with an AI catalogue and fitting room.

## Structure
- `index.html` — the entire site (static, no build )
- `devika-base.webp` — her base photo for AI try-on
- `supabase/setup.sql` — database schema + storage bucket
- `supabase/functions/closet/index.ts` — the AI edge function
- `vercel.json` — static hosting config

## Supabase setup (one time, ~10 min)

1. **Create a project** at supabase.com (free tier).

2. **Run the schema**: Dashboard → SQL Editor → paste `supabase/setup.sql` → Run.

3. **Upload the base photo**: Dashboard → Storage → `closet` bucket →
   create folder `base` → upload `devika-base.webp` → rename to `devika.webp`
   (final path must be `closet/base/devika.webp`).

4. **Deploy the function** (from this folder):
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <YOUR_PROJECT_REF>
   supabase secrets set GEMINI_API_KEY=<your_gemini_key> CLOSET_PIN=<any_pin_or_skip>
   supabase functions deploy closet
   ```

5. **Wire the frontend**: open `index.html`, find the config block near the
   top of the `<script>`:
   ```js
   var SB_URL  = "https://<ref>.supabase.co";
   var SB_ANON = "<anon public key>";   // Project Settings → API
   var SB_PIN  = "<same as CLOSET_PIN, or empty>";
   ```

6. **Redeploy to Vercel** (`git push`, or `vercel --prod`).

## What the backend gives you
- **Upload a photo of any dress** → the function calls Gemini with the
  ghost-mannequin extraction prompt → a clean catalogue tile appears in
  the wardrobe automatically, stored in Supabase (shared across all
  devices and visitors — no more per-browser wardrobe).
- **Try on** for those pieces runs server-side with your Gemini key —
  Devika never needs her own key. Each look generates once, then it's
  saved for everyone.
- **Delete** removes the piece and its images.
- Writes go through the function only (service role); the site's anon
  key is read-only. Optional `CLOSET_PIN` gates all writes.

If `SB_URL` is left empty, the site still works fully in-browser
(localStorage + personal Gemini key) exactly as before.

## Costs
Free tiers all the way: Vercel (hosting), Supabase (DB + storage +
2M function invocations/mo), Gemini (~100 image generations/day).

## Migrating the 20 built-in pieces (recommended)
The pieces from our chat sessions are embedded inside `index.html`, so they
don't use the backend (their "Try on" asks for a browser API key). Move them
into Supabase once, and every piece becomes shared + server-side:

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SERVICE_ROLE_KEY=<service_role key: Project Settings -> API -> service_role> \
node scripts/migrate.mjs --write

git add . && git commit -m "migrate to supabase" && git push
```

Run it once only (re-running duplicates rows). The service_role key is
secret — never put it in index.html; it's used only by this local script.
