create extension if not exists pgcrypto;

create table if not exists novels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  style text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists glossary_terms (
  id uuid primary key default gen_random_uuid(),
  novel_id uuid not null references novels(id) on delete cascade,
  type text not null check (type in ('characters','items','locations','organizations','skills','other')),
  original text not null,
  translation text not null,
  note text default '',
  voice text default '',
  created_at timestamptz not null default now(),
  unique(novel_id,type,original)
);

create table if not exists episodes (
  id uuid primary key default gen_random_uuid(),
  novel_id uuid not null references novels(id) on delete cascade,
  number integer not null,
  title text default '',
  source text default '',
  translation text default '',
  model text default '',
  status text default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(novel_id,number)
);

create index if not exists glossary_novel_idx on glossary_terms(novel_id);
create index if not exists episodes_novel_idx on episodes(novel_id,number);