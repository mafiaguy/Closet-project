# Devika's Closet 👗

A private online wardrobe — every piece she owns, in one place, with an
AI fitting room powered by Gemini.

## What's inside
- `index.html` — the entire site. No build step, no dependencies.
- `vercel.json` — static hosting config for Vercel.

## Run locally
Just open `index.html` in a browser. That's it.

## Deploy to Vercel
**Via GitHub (recommended):**
1. Push this folder to a GitHub repo (private is fine — Vercel deploys private repos on the free plan).
2. On vercel.com → Add New → Project → import the repo.
3. Framework Preset: **Other**. Leave Build Command and Output Directory **empty**. Deploy.

**Via CLI (no repo needed):**
```bash
npm i -g vercel
cd devika-closet
vercel --prod
```

## The AI fitting room
- Pieces with a real photo show **See the look**.
- New pieces show **Try on** → first use asks for a Gemini API key
  (free at aistudio.google.com → "Get API key").
- The key and every generated look are stored only in the browser
  (localStorage) — nothing is sent anywhere except directly to Google's API.
- Free-tier Gemini allows ~100 image generations/day.

## Updating the wardrobe
The catalogue is embedded in `index.html`. To add pieces, generate
product shots with the extraction prompt and rebuild via the chat
that produced this file — or use the on-site "Upload photo" flow
(those items persist per-browser via localStorage).

## Note
The site carries Devika's photos. Keep the URL private, or add access
protection before sharing widely.
