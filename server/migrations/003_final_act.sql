-- Итоговый акт при выдаче: кто получил машину и с какими замечаниями, PDF акта для клиента.

alter table act_sections
  add column receiver      text not null default 'self' check (receiver in ('self','rep')),  -- лично или представитель
  add column rep_fio       text not null default '',
  add column rep_passport  text not null default '',
  add column poa_no        text not null default '',   -- номер доверенности
  add column poa_date      text not null default '',
  add column outcome       text check (outcome in ('ok','remarks')),  -- итог осмотра получателем
  add column final_remarks text not null default '';

alter table orders
  add column final_act_key text,                -- PDF итогового акта в хранилище
  add column final_act_at  timestamptz;
