-- Два сайта: для клиентов и партнёров (основной домен) и для сотрудников (поддомен).

-- ссылки партнёра: кэшбэк задаёт сам партнёр, клиент его отдельно не видит
create table partner_links (
  id         uuid primary key default gen_random_uuid(),
  partner_id uuid not null references users(id) on delete cascade,
  code       text not null unique,
  title      text not null default '',
  cashback   integer not null default 0 check (cashback between 0 and 100000),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index partner_links_partner on partner_links(partner_id);

alter table orders
  add column partner_id      uuid references users(id) on delete set null,
  add column partner_link_id uuid references partner_links(id) on delete set null;
create index orders_partner on orders(partner_id);
create index orders_client_phone on orders(client_phone);

-- личный кабинет клиента: вход по коду из SMS на телефон из заявки, без пароля
create table client_codes (
  phone      text primary key,
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   smallint not null default 0
);
create table client_sessions (
  token_hash text primary key,
  phone      text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index client_sessions_phone on client_sessions(phone);
