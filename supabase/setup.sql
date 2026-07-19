-- Devika's Closet · run this once in the Supabase SQL editor

create table if not exists public.wardrobe (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text not null,
  brand text not null default '',
  category text not null default 'Dress',
  plate_url text,   -- catalogue tile (AI-generated)
  tryon_url text,   -- her AI fitting (generated on demand)
  link text,        -- store page URL, when added from a link
  pending_images jsonb  -- harvested photo candidates awaiting approval
);

alter table public.wardrobe enable row level security;

-- the site (anon key) may only read; all writes go through the edge
-- function, which uses the service role
drop policy if exists "public read" on public.wardrobe;
create policy "public read" on public.wardrobe for select using (true);

-- public storage bucket for tiles, looks, and the base photo
insert into storage.buckets (id, name, public)
values ('closet', 'closet', true)
on conflict (id) do nothing;
