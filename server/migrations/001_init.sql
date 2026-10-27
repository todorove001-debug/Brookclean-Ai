-- Brookclean: базовая схема. Перевозка автомобилей автовозами из Владивостока,
-- с возможной перегрузкой на терминале (Новосибирск).

create extension if not exists pgcrypto;

-- сотрудники: менеджер, водитель, партнёр, приёмщик терминала
create table users (
  id            uuid primary key default gen_random_uuid(),
  role          text not null check (role in ('manager','driver','partner','terminal')),
  name          text not null,
  phone         text not null unique,            -- логин, только цифры: 79001234567
  password_hash text not null,
  status        text not null default 'pending' check (status in ('pending','active','blocked','rejected')),
  terminal_city text,                            -- для приёмщика: Владивосток / Новосибирск
  partner_code  text,                            -- для партнёра
  license       text,                            -- для водителя при регистрации
  created_at    timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user on sessions(user_id);

-- компании-перевозчики; base — чья это база: 'common' или город терминала
create table companies (
  id         uuid primary key default gen_random_uuid(),
  base       text not null default 'common',
  name       text not null,
  short_name text,
  inn        text,
  kpp        text,
  ogrn       text,
  address    text,
  director   text,
  phone      text,
  email      text,
  bank       text,
  bik        text,
  account    text,
  corr       text,
  created_at timestamptz not null default now()
);

-- водители: общая база менеджера и отдельная база терминала
create table drivers (
  id            uuid primary key default gen_random_uuid(),
  base          text not null default 'common',
  user_id       uuid unique references users(id) on delete set null,
  own           boolean not null default false,  -- собственный водитель или наёмный
  name          text not null,
  phone         text,
  company_id    uuid references companies(id) on delete set null,
  tractor_model text,
  tractor_plate text,
  trailer_model text,
  trailer_plate text,
  docs          jsonb not null default '{}',     -- распознанные поля: паспорт, ВУ, СТС
  created_at    timestamptz not null default now()
);

create sequence trip_no_seq start 1;
create table trips (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,             -- R-01
  origin       text not null default 'Владивосток',
  load_city    text not null default 'Владивосток',
  dest         text not null,
  status       text not null default 'forming' check (status in ('forming','formed')),
  driver_id    uuid references drivers(id) on delete set null,
  truck        text,
  trailer      text,
  carrier      text,
  load_date    date,
  current_city text,                              -- последняя отметка на маршруте
  advance      integer not null default 0,
  created_at   timestamptz not null default now()
);

create table trip_events (
  id      bigserial primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  at      timestamptz not null default now(),
  city    text,
  note    text not null,
  public  boolean not null default true          -- видно клиенту в трекинге
);
create index trip_events_trip on trip_events(trip_id, at);

-- заказ клиента: автомобиль, договор, оплата
create sequence order_no_seq start 1000;
create table orders (
  no               integer primary key default nextval('order_no_seq'),
  created_at       timestamptz not null default now(),
  car              text not null,
  vin              text not null,
  year             integer not null,
  color            text not null,
  body             text not null check (body in ('sedan','cross','van')),
  value            integer not null,                -- оценочная стоимость, ₽
  city             text not null,                   -- город доставки
  client_fio       text not null,
  client_phone     text not null,
  passport_series  text,
  passport_number  text,
  passport_issued  text,
  passport_date    date,
  address          text,
  tariff           integer not null,
  cashback         integer not null default 0,      -- в договоре отдельно не показывается
  insurance        integer not null,
  partner_code     text,
  transfer_city    text,                            -- перегрузка на терминале, если есть
  track_token      text not null unique,
  -- подписание простой электронной подписью
  doc_hash         text,
  signed_at        timestamptz,
  signed_phone     text,
  signed_ip        text,
  -- данные акта по машине
  plate            text,
  pts_type         text,
  pts_no           text,
  keys_count       text,
  extra_docs       text,
  -- оплата
  pay_delivery     boolean not null default false,
  pay_insurance    boolean not null default false,
  pay_to           text,
  pay_form         text,
  policy_no        text,
  delivered_at     timestamptz
);

-- плечи перевозки: одно прямое или два через терминал
create table order_legs (
  order_no  integer not null references orders(no) on delete cascade,
  idx       smallint not null check (idx in (0,1)),
  trip_id   uuid references trips(id) on delete set null,
  from_city text not null,
  to_city   text not null,
  primary key (order_no, idx)
);
create index order_legs_trip on order_legs(trip_id);

create table sign_codes (
  order_no   integer primary key references orders(no) on delete cascade,
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   smallint not null default 0
);

-- передача машины: приёмка, погрузка, терминал, выгрузка
create table stages (
  order_no integer not null references orders(no) on delete cascade,
  stage    text not null check (stage in ('priemka','pogruzka','term_in','term_out','vygruzka')),
  place      text,
  started_at timestamptz not null default now(),  -- дата в имени папки этапа
  done_at    timestamptz,
  mode     jsonb,                                  -- облегчённая или полная съёмка на погрузке с терминала
  primary key (order_no, stage)
);

-- файлы этапа; при пересъёмке старый файл помечается replaced и остаётся для истории
create table media (
  id            uuid primary key default gen_random_uuid(),
  order_no      integer not null references orders(no) on delete cascade,
  stage         text not null,
  kind          text not null check (kind in ('photo','video','act','signature')),
  slot          smallint not null default 0,
  storage_key   text not null,
  mime          text,
  size          bigint,
  original_name text,
  uploaded_by   uuid references users(id) on delete set null,
  uploaded_as   text,                              -- от чьего имени: водитель на устройстве приёмщика
  replaced      boolean not null default false,
  created_at    timestamptz not null default now()
);
create unique index media_current on media(order_no, stage, kind, slot) where not replaced and kind in ('photo','video');
create index media_order on media(order_no, stage);

-- раздел сквозного акта приёма-передачи
create table act_sections (
  order_no      integer not null references orders(no) on delete cascade,
  stage         text not null,
  give_role     text not null,
  give_name     text not null,
  take_role     text not null,
  take_name     text not null,
  named         boolean not null default false,    -- ФИО сторон исправили вручную
  give_sig      jsonb,                             -- {mediaId, at, deviceUser, deviceName}
  take_sig      jsonb,
  disagree      boolean not null default false,
  dis_comment   text not null default '',
  absent        boolean not null default false,
  absent_reason text not null default '',
  cond          jsonb not null default '{}',
  cond_other    text not null default '',
  notes         text not null default '',
  driver_mode   boolean not null default false,    -- экран приёмщика передан водителю
  closed_at     timestamptz,
  primary key (order_no, stage)
);

-- журнал дефектов: отметка живёт через все этапы, история — кто и что менял
create table defect_marks (
  id          bigserial primary key,
  order_no    integer not null references orders(no) on delete cascade,
  code        text not null,
  part        text not null default '',
  x           real not null,
  y           real not null,
  first_stage text not null,
  removed     boolean not null default false
);
create index defect_marks_order on defect_marks(order_no);

create table mark_history (
  id         bigserial primary key,
  mark_id    bigint not null references defect_marks(id) on delete cascade,
  stage      text not null,
  action     text not null check (action in ('add','refine','remove')),
  code       text,
  from_code  text,
  to_code    text,
  reason     text,
  src        text,                                 -- manual / ai
  photo_slot smallint,
  by_manager boolean not null default false,
  who        text not null,
  role       text not null,
  user_id    uuid references users(id) on delete set null,
  at         timestamptz not null default now()
);
create index mark_history_mark on mark_history(mark_id, at);

-- журнал действий: кто, что и когда изменил
create table audit_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  user_id   uuid references users(id) on delete set null,
  action    text not null,
  entity    text not null,
  entity_id text,
  data      jsonb
);
create index audit_entity on audit_log(entity, entity_id);

create table settings (
  key   text primary key,
  value jsonb not null
);
insert into settings(key, value) values
  ('term_out_rule', '"byStay"'),     -- byStay: меньше суток на терминале — облегчённая съёмка; light / full
  ('direct_wait_days', '5');
