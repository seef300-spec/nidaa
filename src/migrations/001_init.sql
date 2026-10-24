-- نداء: المخطط الأولي
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  logo            bytea,
  logo_mime       text,
  logo_version    int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  timezone             text NOT NULL DEFAULT 'Asia/Riyadh',
  day_start_hour       int  NOT NULL DEFAULT 4 CHECK (day_start_hour BETWEEN 0 AND 23),
  pickup_instructions  text NOT NULL DEFAULT '',
  order_ttl_hours      int  NOT NULL DEFAULT 12 CHECK (order_ttl_hours BETWEEN 1 AND 72),
  link_grace_hours     int  NOT NULL DEFAULT 6 CHECK (link_grace_hours BETWEEN 1 AND 72),
  recall_cooldown_sec  int  NOT NULL DEFAULT 30 CHECK (recall_cooldown_sec BETWEEN 10 AND 600),
  display_autoshow     boolean NOT NULL DEFAULT true,
  display_skip_sec     int  NOT NULL DEFAULT 180 CHECK (display_skip_sec BETWEEN 0 AND 3600),
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON branches (tenant_id);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username       text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner','staff')),
  active         boolean NOT NULL DEFAULT true,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE user_branches (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id  uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE sessions (
  token_hash    bytea PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE display_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX ON display_devices (branch_id);

-- طلبات الاقتران: الشاشة تعرض رمزًا، والموظف المسجّل يُدخله.
CREATE TABLE pairing_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_hash   bytea NOT NULL UNIQUE,
  code          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  claimed_at    timestamptz,
  device_id     uuid REFERENCES display_devices(id) ON DELETE CASCADE,
  device_token  text,          -- يُسلَّم مرة واحدة ثم يُمسح
  failed_claims int NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX pairing_code_open ON pairing_requests (code) WHERE claimed_at IS NULL;

CREATE TABLE order_counters (
  branch_id      uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  business_date  date NOT NULL,
  last_number    int  NOT NULL,
  PRIMARY KEY (branch_id, business_date)
);

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id          uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  business_date      date NOT NULL,
  number             int  NOT NULL,
  public_token       text NOT NULL UNIQUE,
  external_ref       text,
  external_source    text,
  external_id        text,
  note               text,
  status             text NOT NULL CHECK (status IN ('preparing','ready','delivered','cancelled')),
  cancel_reason      text CHECK (cancel_reason IN ('staff','expired','api')),
  version            int  NOT NULL DEFAULT 1,
  created_via        text NOT NULL DEFAULT 'staff' CHECK (created_via IN ('staff','api')),
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  ready_at           timestamptz,
  first_called_at    timestamptz,
  last_called_at     timestamptz,
  call_count         int NOT NULL DEFAULT 0,
  delivered_at       timestamptz,
  cancelled_at       timestamptz,
  first_opened_at    timestamptz,
  last_seen_at       timestamptz,
  customer_ack_at    timestamptz,
  expires_at         timestamptz NOT NULL,
  link_expires_at    timestamptz NOT NULL,
  display_state      text CHECK (display_state IN ('queued','done')),
  display_rank       timestamptz,
  display_shown_at   timestamptz,
  display_done_reason text,
  UNIQUE (branch_id, business_date, number)
);
CREATE INDEX orders_branch_status ON orders (branch_id, status, created_at DESC);
CREATE INDEX orders_branch_created ON orders (branch_id, created_at DESC, id DESC);
CREATE INDEX orders_branch_ref ON orders (branch_id, lower(external_ref));
CREATE INDEX orders_display ON orders (branch_id, display_rank) WHERE display_state = 'queued';
CREATE UNIQUE INDEX orders_external ON orders (branch_id, external_source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX orders_expiry ON orders (expires_at) WHERE status IN ('preparing','ready');

-- كل جهاز فتح رابط الطلب (معرّف عشوائي يولّده المتصفح، بلا بيانات شخصية)
CREATE TABLE order_viewers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  client_id        text NOT NULL,
  platform         text NOT NULL DEFAULT 'unknown',
  standalone       boolean NOT NULL DEFAULT false,
  capability       text NOT NULL DEFAULT 'unknown',
  permission       text NOT NULL DEFAULT 'unknown',
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, client_id)
);

CREATE TABLE push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  viewer_id     uuid REFERENCES order_viewers(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('webpush','apns_alert','apns_liveactivity')),
  endpoint      text NOT NULL,         -- webpush endpoint أو رمز جهاز APNs
  p256dh        text,
  auth          text,
  apns_env      text CHECK (apns_env IN ('sandbox','production')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','closed')),
  closed_reason text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind, endpoint)
);

CREATE TABLE calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq         int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL,
  actor_id    uuid,
  UNIQUE (order_id, seq)
);

-- محاولات التنبيه: مُرسل ← مقبول من خدمة الإشعارات ← مؤكد من الجهاز
CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id          uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  subscription_id  uuid REFERENCES push_subscriptions(id) ON DELETE SET NULL,
  viewer_id        uuid REFERENCES order_viewers(id) ON DELETE SET NULL,
  channel          text NOT NULL CHECK (channel IN ('webpush','apns_alert','apns_liveactivity','page')),
  sent_at          timestamptz,
  accepted_at      timestamptz,
  failed_at        timestamptz,
  provider_status  int,
  error            text,
  attempts         int NOT NULL DEFAULT 0,
  receipt_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON deliveries (call_id);
CREATE INDEX ON deliveries (order_id);
CREATE UNIQUE INDEX deliveries_page ON deliveries (call_id, viewer_id) WHERE channel = 'page';

CREATE TABLE order_events (
  id           bigserial PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  branch_id    uuid NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user','display','customer','system','api')),
  actor_id     uuid,
  actor_label  text,
  action       text NOT NULL,
  from_status  text,
  to_status    text,
  data         jsonb
);
CREATE INDEX ON order_events (order_id, at);

CREATE TABLE idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL UNIQUE,
  key_hash     bytea NOT NULL,
  scopes       text[] NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE app_settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

CREATE TABLE error_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  source   text NOT NULL,
  message  text NOT NULL,
  context  jsonb
);
CREATE INDEX ON error_log (at DESC);
