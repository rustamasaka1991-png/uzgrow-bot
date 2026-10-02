// Ma'lumotlar bazasi sxemasi. Idempotent: necha marta ishga tushirilsa ham xavfsiz.
// `npm run setup` / `npm run migrate` (yoki POST /api/setup, SETUP_KEY bilan) orqali qo'llaniladi.

/**
 * Sxema versiyasi: SCHEMA_SQL o'zgarganda oshiriladi. Ilova ishga tushganda bazadagi versiya eski bo'lsa
 * (deploy migratsiyadan oldin chiqib qolsa) — idempotent migratsiya avtomatik bir marta bajariladi (ensureSchema).
 */
export const SCHEMA_VERSION = '2026-09-30.2';

export const SCHEMA_SQL = /* sql */ `
create table if not exists staff (
  id                    bigint generated always as identity primary key,
  role                  text not null check (role in ('operator', 'manager')),
  full_name             text not null,
  position              text not null default '',
  description           text not null default '',
  greeting              text,
  photo_file_id         text,
  photo_unique_id       text,
  client_photo_file_id  text,
  tg_user_id            bigint unique,
  tg_username           text,
  invite_code           text unique,
  is_active             boolean not null default true,
  is_online             boolean not null default true,
  sort_order            integer not null default 0,
  active_conversation_id bigint,
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists clients (
  tg_user_id             bigint primary key,
  first_name             text not null default '',
  last_name              text,
  username               text,
  language_code          text,
  active_conversation_id bigint,
  bot_blocked            boolean not null default false,
  created_at             timestamptz not null default now(),
  last_seen_at           timestamptz not null default now()
);

create table if not exists conversations (
  id                   bigint generated always as identity primary key,
  client_id            bigint not null references clients(tg_user_id) on delete cascade,
  staff_id             bigint not null references staff(id) on delete cascade,
  auto_replied         boolean not null default false,
  unread_staff         integer not null default 0,
  unread_client        integer not null default 0,
  last_message_at      timestamptz,
  last_message_preview text,
  last_sender          text,
  created_at           timestamptz not null default now(),
  unique (client_id, staff_id)
);

create table if not exists messages (
  id                 bigint generated always as identity primary key,
  conversation_id    bigint not null references conversations(id) on delete cascade,
  sender             text not null check (sender in ('client', 'staff', 'bot')),
  kind               text not null default 'text',
  text               text,
  entities           jsonb,
  file_id_client     text,
  file_id_staff      text,
  file_unique_id     text,
  file_name          text,
  mime_type          text,
  file_size          bigint,
  meta               jsonb,
  client_chat_msg_id bigint,
  staff_chat_id      bigint,
  staff_chat_msg_id  bigint,
  via                text not null default 'bot' check (via in ('bot', 'webapp')),
  created_at         timestamptz not null default now()
);

create table if not exists processed_updates (
  bot        text not null,
  update_id  bigint not null,
  created_at timestamptz not null default now(),
  primary key (bot, update_id)
);

create table if not exists user_state (
  bot        text not null,
  tg_user_id bigint not null,
  state      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (bot, tg_user_id)
);

create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Bitta saqlangan xabarga tegishli, bot yuborgan QO'SHIMCHA Telegram xabarlari: alohida sarlavha
-- ("👤 Ism" — stiker/joylashuv/kontakt/video-xabar oldidan), uzun matn bo'laklari, uzun izoh davomi,
-- tahrir haqidagi xabarlar, "📥 Botda ochish" nusxalari. Ularning har biriga Reply qilinsa ham to'g'ri
-- suhbat topiladi (asosiy xabar id si messages.staff_chat_msg_id / client_chat_msg_id da).
create table if not exists message_links (
  bot        text not null check (bot in ('client', 'staff')),
  chat_id    bigint not null,
  tg_msg_id  bigint not null,
  message_id bigint not null references messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (bot, chat_id, tg_msg_id)
);

-- Mini App: so'rovlar chastotasi cheklovi (qat'iy oyna hisoblagichlari, src/webapp/guards.ts)
create table if not exists rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (key, window_start)
);

-- Mini App: takroriy yuborishdan himoya (clientNonce -> saqlangan xabar, src/webapp/guards.ts)
create table if not exists webapp_sends (
  conversation_id bigint not null references conversations(id) on delete cascade,
  sender          text not null check (sender in ('client', 'staff')),
  nonce           text not null,
  message_id      bigint,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, sender, nonce)
);

-- Keyinroq qo'shilgan ustunlar (mavjud bazalar uchun ham idempotent)
alter table messages add column if not exists edited_at timestamptz;
-- Yetkazish: da'vo qilingan vaqt (bir nechta parallel webhook bitta xabarni ikki marta yubormasligi uchun)
alter table messages add column if not exists delivery_claimed_at timestamptz;
-- Yetkazish qayta urinib bo'lmaydigan sabab bilan muvaffaqiyatsiz bo'lsa (masalan, fayl juda katta)
alter table messages add column if not exists delivery_error text;
-- Vaqtinchalik xatodan (Telegram 429 retry_after, 5xx, tarmoq) keyin xodimga qayta yetkazish mumkin bo'lgan vaqt.
-- Band (delivery_claimed_at) saqlanadi; shu vaqt kelganda (2 daqiqalik TTL ni kutmasdan) navbat uni yana oladi.
alter table messages add column if not exists delivery_retry_at timestamptz;
-- Xodim xodimlar botini bloklagan/to'xtatgan (xabarlar yetkazilmaydi, u qaytganda yetkaziladi)
alter table staff add column if not exists bot_blocked boolean not null default false;
-- Bloklashdan oldingi onlayn holati (qaytganda tiklanadi)
alter table staff add column if not exists online_before_block boolean;
-- Kutib turgan xabarlarni fonda yetkazish (POST /api/redeliver) shu vaqtga rejalashtirilgan (takroriy chaqiruvlarsiz)
alter table staff add column if not exists redeliver_at timestamptz;
-- Xodim aktiv suhbatni oxirgi marta aniq tanlagan vaqt (Reply'siz xabar kimga ketishini aniqlash uchun)
alter table staff add column if not exists active_set_at timestamptz;
-- Mijozlar uchun qisqa havola nomi: https://t.me/<mijoz_boti>?start=<link_code> (masalan "aziza")
alter table staff add column if not exists link_code text;
-- v1 da mijozlarga doimiy pastki menyu (reply keyboard) yuborilgan; v2 da u mijozning birinchi /start ida bir marta
-- olib tashlanadi. Ustun qo'shilgan paytda mavjud mijozlar — true, keyin yaratilganlar — false (menyu olmagan).
alter table clients add column if not exists legacy_keyboard boolean not null default true;
alter table clients alter column legacy_keyboard set default false;

-- Aylanma (circular) tashqi kalitlar: faqat mavjud bo'lmasa qo'shiladi
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_active_conversation_fk' and conrelid = 'clients'::regclass) then
    alter table clients
      add constraint clients_active_conversation_fk
      foreign key (active_conversation_id) references conversations(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_active_conversation_fk' and conrelid = 'staff'::regclass) then
    alter table staff
      add constraint staff_active_conversation_fk
      foreign key (active_conversation_id) references conversations(id) on delete set null;
  end if;
end $$;

create unique index if not exists staff_link_code_uidx on staff (lower(link_code)) where link_code is not null;
create index if not exists messages_conversation_idx on messages (conversation_id, id);
create index if not exists messages_staff_map_idx on messages (staff_chat_id, staff_chat_msg_id) where staff_chat_msg_id is not null;
create index if not exists messages_client_map_idx on messages (client_chat_msg_id) where client_chat_msg_id is not null;
create index if not exists conversations_staff_idx on conversations (staff_id, last_message_at desc nulls last);
create index if not exists conversations_client_idx on conversations (client_id, last_message_at desc nulls last);
create index if not exists processed_updates_created_idx on processed_updates (created_at);
create index if not exists message_links_message_idx on message_links (message_id);
create index if not exists rate_limits_window_idx on rate_limits (window_start);
create index if not exists webapp_sends_created_idx on webapp_sends (created_at);
create index if not exists messages_edited_idx on messages (conversation_id, edited_at) where edited_at is not null;
-- Xodimga hali yetkazilmagan mijoz xabarlari (qayta yetkazish navbati)
create index if not exists messages_pending_staff_idx on messages (conversation_id, id)
  where sender = 'client' and staff_chat_msg_id is null and delivery_error is null;

-- Panel rollari: admin va ROP (rahbar). Developer(lar) — ADMIN_IDS env dagi Telegram ID lar (bazada emas).
create table if not exists panel_roles (
  tg_user_id bigint primary key,
  role       text not null check (role in ('admin', 'rop')),
  name       text not null default '',
  added_by   bigint,
  created_at timestamptz not null default now()
);

-- Mijozlarning operator/menejerlar ustidan shikoyatlari (draft — mijoz hali matnni yozmagan)
create table if not exists complaints (
  id              bigint generated always as identity primary key,
  client_id       bigint not null references clients(tg_user_id) on delete cascade,
  staff_id        bigint not null references staff(id) on delete cascade,
  conversation_id bigint references conversations(id) on delete set null,
  text            text,
  status          text not null default 'draft' check (status in ('draft', 'new', 'resolved')),
  created_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  resolved_at     timestamptz,
  resolved_by     bigint
);
create index if not exists complaints_status_idx on complaints (status, submitted_at desc);
create index if not exists complaints_client_draft_idx on complaints (client_id) where status = 'draft';

-- Ommaviy xabarlar (ROP/developer → barcha mijozlar), bir nechta so'rov davomida bo'laklab yuboriladi
create table if not exists broadcasts (
  id               bigint generated always as identity primary key,
  created_by       bigint not null,
  content          jsonb not null,
  status           text not null default 'pending' check (status in ('pending', 'running', 'done', 'cancelled')),
  total            integer not null default 0,
  sent             integer not null default 0,
  failed           integer not null default 0,
  blocked          integer not null default 0,
  last_client_id   bigint not null default 0,
  locked_until     timestamptz,
  progress_chat_id bigint,
  progress_msg_id  bigint,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

-- Xavfsizlik: Supabase publishable/anon kaliti orqali jadvallarni o'qib bo'lmasin.
-- Server "postgres" roli bilan ulanadi va RLS dan o'tadi.
alter table staff             enable row level security;
alter table clients           enable row level security;
alter table conversations     enable row level security;
alter table messages          enable row level security;
alter table processed_updates enable row level security;
alter table user_state        enable row level security;
alter table settings          enable row level security;
alter table message_links     enable row level security;
alter table rate_limits       enable row level security;
alter table webapp_sends      enable row level security;
alter table panel_roles       enable row level security;
alter table complaints        enable row level security;
alter table broadcasts        enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on staff, clients, conversations, messages, processed_updates, user_state, settings, message_links, rate_limits, webapp_sends, panel_roles, complaints, broadcasts from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on staff, clients, conversations, messages, processed_updates, user_state, settings, message_links, rate_limits, webapp_sends, panel_roles, complaints, broadcasts from authenticated;
  end if;
end $$;
`;
