create table if not exists users(
  id serial primary key,
  name text not null,
  role text not null check (role in ('admin','developer','viewer'))
);
insert into users(name,role) select * from (values ('Admin Asha','admin'),('Dev Ravi','developer'),('Dev Meena','developer'),('Viewer Kiran','viewer')) v
  where not exists (select 1 from users);

create table if not exists projects(
  id serial primary key,
  name text not null unique,
  description text,
  repo_url text,
  created_by int references users(id),
  created_at timestamptz not null default now()
);

create table if not exists deployments(
  id serial primary key,
  project_id int not null references projects(id) on delete cascade,
  external_id text,                       -- idempotency key (CI run id / GitHub deployment id)
  version text,                           -- nullable: records may be incomplete
  environment text not null default 'production',
  status text not null default 'success' check (status in ('pending','success','failed','rolled_back','cancelled')),
  commit_sha text,
  deployed_by text,
  notes text,
  deployed_at timestamptz not null default now(),   -- when it happened
  received_at timestamptz not null default now(),   -- when we heard about it
  unique (project_id, external_id)
);
create index if not exists idx_dep_proj_time on deployments(project_id, deployed_at desc);

create table if not exists changes(
  id serial primary key,
  project_id int not null references projects(id) on delete cascade,
  deployment_id int references deployments(id) on delete set null,
  external_id text,
  commit_sha text,
  message text,
  author text,
  committed_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  unique (project_id, external_id)
);
create index if not exists idx_chg_proj_time on changes(project_id, committed_at desc);

create table if not exists incidents(
  id serial primary key,
  project_id int not null references projects(id) on delete cascade,
  external_id text,
  fingerprint text not null,              -- hash of normalised title: duplicates + recurrence
  title text not null,
  description text,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','investigating','identified','resolved')),
  assignees int[] not null default '{}',
  resolution text,
  occurred_at timestamptz not null default now(),   -- when the failure started
  reported_at timestamptz not null default now(),   -- when someone reported it
  resolved_at timestamptz,
  report_count int not null default 1,
  version int not null default 1,                   -- optimistic locking
  reported_by int references users(id),
  unique (project_id, external_id)
);
create index if not exists idx_inc_proj on incidents(project_id, occurred_at desc);
create index if not exists idx_inc_fp on incidents(project_id, fingerprint);

create table if not exists incident_suspects(
  id serial primary key,
  incident_id int not null references incidents(id) on delete cascade,
  kind text not null check (kind in ('deployment','change')),
  ref_id int not null,
  score numeric not null default 0,
  reason text,
  source text not null default 'auto' check (source in ('auto','manual')),
  unique (incident_id, kind, ref_id)
);

create table if not exists incident_updates(
  id serial primary key,
  incident_id int not null references incidents(id) on delete cascade,
  user_id int references users(id),
  kind text not null default 'comment',
  body text not null,
  client_id text,                          -- idempotency key for retried posts
  created_at timestamptz not null default now(),
  unique (incident_id, client_id)
);

create table if not exists audit_logs(
  id serial primary key,
  user_id int references users(id),
  action text not null,
  entity text not null,
  entity_id int,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
