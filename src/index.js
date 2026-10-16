const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const db = require('./db');

const app = express();
const bus = new EventEmitter(); bus.setMaxListeners(0);
app.use(express.json({ verify: (req, _res, buf) => { req.raw = buf; } }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------- helpers ---------- */
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const q = (t, p) => db.query(t, p);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const push = (pid, type, id) => bus.emit(`p${pid}`, { type, id });
const audit = (user, action, entity, id, details = {}) =>
  q('insert into audit_logs(user_id,action,entity,entity_id,details) values($1,$2,$3,$4,$5)',
    [user ? user.id : null, action, entity, id, details]);
const getInc = async id => (await q('select * from incidents where id=$1', [id])).rows[0];

/* ---------- auth (demo-grade: pick a seeded user with the x-user-id header) ---------- */
const auth = h(async (req, res, next) => {
  const { rows } = await q('select * from users where id=$1', [parseInt(req.get('x-user-id'), 10) || 1]);
  if (!rows[0]) return bad(res, 'unknown user', 401);
  req.user = rows[0]; next();
});
const allow = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : bad(res, `role '${req.user.role}' is not allowed to do this`, 403);
const WRITE = allow('admin', 'developer');

/* ---------- failure <-> deployment correlation ---------- */
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'error', 'failed', 'failure', 'down', 'production', 'issue']);
const words = s => [...new Set((s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])].filter(w => !STOP.has(w));

// Scores every deployment in the 48h before the incident started (+5 min clock-skew grace).
async function correlate(inc) {
  const { rows: deps } = await q(
    `select * from deployments where project_id=$1 and status<>'cancelled'
       and deployed_at <= $2::timestamptz + interval '5 minutes'
       and deployed_at >= $2::timestamptz - interval '48 hours'`, [inc.project_id, inc.occurred_at]);
  const kw = words(`${inc.title} ${inc.description || ''}`);
  for (const d of deps) {
    const { rows: chg } = await q(
      `select * from changes where project_id=$1 and (deployment_id=$2 or (commit_sha is not null and commit_sha=$3))`,
      [inc.project_id, d.id, d.commit_sha]);
    const hrs = Math.max(0, (new Date(inc.occurred_at) - new Date(d.deployed_at)) / 36e5);
    let score = 60 * Math.exp(-hrs / 6);                       // recency
    const why = [`deployed ${hrs.toFixed(1)}h before the incident`];
    if (d.environment === 'production') { score += 15; why.push('production'); }
    if (['failed', 'rolled_back'].includes(d.status)) { score += 15; why.push(`status ${d.status}`); }
    const text = words([d.notes, ...chg.map(c => c.message)].join(' '));
    const hits = kw.filter(w => text.includes(w));
    if (hits.length) { score += Math.min(20, hits.length * 10); why.push(`keyword match: ${hits.join(', ')}`); }
    if (chg.length) why.push(`${chg.length} change(s) shipped`);
    score = Math.min(100, Math.round(score));
    if (score < 20) continue;
    await q(`insert into incident_suspects(incident_id,kind,ref_id,score,reason) values($1,'deployment',$2,$3,$4)
             on conflict (incident_id,kind,ref_id) do update set score=excluded.score, reason=excluded.reason
             where incident_suspects.source='auto'`, [inc.id, d.id, score, why.join('; ')]);
  }
}
// A late-arriving deployment/change may explain incidents we already have -> re-score them.
async function recorrelate(pid, ts) {
  const { rows } = await q(
    `select * from incidents where project_id=$1 and occurred_at between $2::timestamptz - interval '5 minutes'
       and $2::timestamptz + interval '48 hours'`, [pid, ts]);
  for (const i of rows) await correlate(i);
}

/* ---------- idempotent upserts (duplicate / delayed / incomplete / out-of-order events) ---------- */
async function upsertDeployment(pid, b) {
  const { rows } = await q(
    `insert into deployments(project_id,external_id,version,environment,status,commit_sha,deployed_by,notes,deployed_at)
     values($1,$2,$3,coalesce($4,'production'),coalesce($5,'success'),$6,$7,$8,coalesce($9::timestamptz,now()))
     on conflict (project_id,external_id) do update set
       version=coalesce($3,deployments.version), environment=coalesce($4,deployments.environment),
       status=case when $5='pending' and deployments.status<>'pending' then deployments.status else coalesce($5,deployments.status) end,
       commit_sha=coalesce($6,deployments.commit_sha), deployed_by=coalesce($7,deployments.deployed_by),
       notes=coalesce($8,deployments.notes), deployed_at=coalesce($9::timestamptz,deployments.deployed_at)
     returning *, (xmax=0) as created`,
    [pid, b.external_id || null, b.version || null, b.environment || null, b.status || null,
      b.commit_sha || null, b.deployed_by || null, b.notes || null, b.deployed_at || null]);
  push(pid, 'deployment', rows[0].id);
  await recorrelate(pid, rows[0].deployed_at);
  return rows[0];
}
async function upsertChange(pid, b) {
  const { rows } = await q(
    `insert into changes(project_id,external_id,commit_sha,message,author,committed_at,deployment_id)
     values($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),$7)
     on conflict (project_id,external_id) do update set
       commit_sha=coalesce($3,changes.commit_sha), message=coalesce($4,changes.message), author=coalesce($5,changes.author),
       committed_at=coalesce($6::timestamptz,changes.committed_at), deployment_id=coalesce($7,changes.deployment_id)
     returning *, (xmax=0) as created`,
    [pid, b.external_id || null, b.commit_sha || null, b.message || null, b.author || null, b.committed_at || null, b.deployment_id || null]);
  push(pid, 'change', rows[0].id);
  await recorrelate(pid, rows[0].committed_at);
  return rows[0];
}

/* ---------- public routes (no x-user-id): health, SSE stream, GitHub webhook ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/projects/:pid/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const key = `p${req.params.pid}`;
  const fn = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on(key, fn);
  const t = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { bus.off(key, fn); clearInterval(t); });
});

app.post('/api/webhooks/github/:pid', h(async (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret) {
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(req.raw || '').digest('hex');
    const got = req.get('x-hub-signature-256') || '';
    if (got.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(sig))) return bad(res, 'bad signature', 401);
  }
  const pid = +req.params.pid, ev = req.get('x-github-event'), p = req.body;
  if (ev === 'push') {
    for (const c of p.commits || [])
      await upsertChange(pid, { external_id: `commit:${c.id}`, commit_sha: c.id, message: c.message, author: c.author && c.author.name, committed_at: c.timestamp });
  } else if (ev === 'deployment') {
    const d = p.deployment;
    await upsertDeployment(pid, { external_id: `gh:${d.id}`, version: d.ref, environment: d.environment, commit_sha: d.sha, deployed_by: d.creator && d.creator.login, status: 'pending', deployed_at: d.created_at });
  } else if (ev === 'deployment_status') {
    const d = p.deployment, s = p.deployment_status;
    const status = s.state === 'success' ? 'success' : ['failure', 'error'].includes(s.state) ? 'failed' : 'pending';
    await upsertDeployment(pid, { external_id: `gh:${d.id}`, version: d.ref, environment: d.environment, commit_sha: d.sha, deployed_by: d.creator && d.creator.login, status, deployed_at: s.created_at });
  }
  await audit(null, 'webhook', 'github', null, { event: ev, delivery: req.get('x-github-delivery') });
  res.json({ ok: true, event: ev });
}));

/* ---------- authenticated API ---------- */
const api = express.Router();
api.use(auth);

api.get('/users', h(async (_req, res) => res.json((await q('select * from users order by id')).rows)));

// projects
api.get('/projects', h(async (_req, res) => res.json((await q(
  `select p.*, (select count(*) from incidents i where i.project_id=p.id and i.status<>'resolved')::int open_incidents
   from projects p order by p.id`)).rows)));
api.post('/projects', WRITE, h(async (req, res) => {
  const { name, description, repo_url } = req.body;
  if (!name) return bad(res, 'name is required');
  const { rows } = await q('insert into projects(name,description,repo_url,created_by) values($1,$2,$3,$4) returning *',
    [name, description || null, repo_url || null, req.user.id]);
  await audit(req.user, 'create', 'project', rows[0].id, { name });
  res.status(201).json(rows[0]);
}));
api.get('/projects/:pid', h(async (req, res) => {
  const { rows } = await q('select * from projects where id=$1', [req.params.pid]);
  rows[0] ? res.json(rows[0]) : bad(res, 'not found', 404);
}));
api.delete('/projects/:pid', allow('admin'), h(async (req, res) => {
  await q('delete from projects where id=$1', [req.params.pid]);
  await audit(req.user, 'delete', 'project', +req.params.pid);
  res.status(204).end();
}));

// deployments
api.get('/projects/:pid/deployments', h(async (req, res) =>
  res.json((await q('select * from deployments where project_id=$1 order by deployed_at desc limit 200', [req.params.pid])).rows)));
api.post('/projects/:pid/deployments', WRITE, h(async (req, res) => {
  const row = await upsertDeployment(+req.params.pid, req.body);
  await audit(req.user, row.created ? 'create' : 'update', 'deployment', row.id);
  res.status(row.created ? 201 : 200).json(row);
}));

// changes (commits)
api.get('/projects/:pid/changes', h(async (req, res) =>
  res.json((await q('select * from changes where project_id=$1 order by committed_at desc limit 200', [req.params.pid])).rows)));
api.post('/projects/:pid/changes', WRITE, h(async (req, res) => {
  const row = await upsertChange(+req.params.pid, req.body);
  await audit(req.user, row.created ? 'create' : 'update', 'change', row.id);
  res.status(row.created ? 201 : 200).json(row);
}));

// timeline: ordered by when things HAPPENED, so late-arriving records slot into the right place
api.get('/projects/:pid/timeline', h(async (req, res) => res.json((await q(
  `select 'deployment' kind, id, deployed_at ts, coalesce(version,'(unknown version)')||' -> '||environment||' ['||status||']' title, deployed_by detail
     from deployments where project_id=$1
   union all select 'change', id, committed_at, left(coalesce(message,''),120), author from changes where project_id=$1
   union all select 'incident', id, occurred_at, title, severity||' / '||status from incidents where project_id=$1
   union all select 'update', u.id, u.created_at, u.kind||': '||left(u.body,100), usr.name
     from incident_updates u join incidents i on i.id=u.incident_id left join users usr on usr.id=u.user_id where i.project_id=$1
   order by ts desc limit 300`, [req.params.pid])).rows)));

// incidents
api.get('/projects/:pid/incidents', h(async (req, res) => {
  const { status, severity } = req.query;
  res.json((await q(`select * from incidents where project_id=$1 and ($2::text is null or status=$2)
    and ($3::text is null or severity=$3) order by occurred_at desc`, [req.params.pid, status || null, severity || null])).rows);
}));

api.post('/projects/:pid/incidents', WRITE, h(async (req, res) => {
  const b = req.body, pid = +req.params.pid;
  if (!b.title) return bad(res, 'title is required');
  const fp = crypto.createHash('sha1').update(`${pid}:${b.title.trim().toLowerCase().replace(/\s+/g, ' ')}`).digest('hex');
  // 1) same idempotency key -> return the existing incident
  if (b.external_id) {
    const { rows } = await q('select * from incidents where project_id=$1 and external_id=$2', [pid, b.external_id]);
    if (rows[0]) return res.json({ ...rows[0], duplicate: true });
  }
  // 2) same issue already open -> merge the report instead of creating a duplicate
  const open = (await q(`select * from incidents where project_id=$1 and fingerprint=$2 and status<>'resolved' order by id desc limit 1`, [pid, fp])).rows[0];
  if (open) {
    const { rows } = await q(`update incidents set report_count=report_count+1, occurred_at=least(occurred_at,coalesce($2::timestamptz,occurred_at))
      where id=$1 returning *`, [open.id, b.occurred_at || null]);
    await q(`insert into incident_updates(incident_id,user_id,kind,body) values($1,$2,'duplicate','Duplicate report merged into this incident')`, [open.id, req.user.id]);
    await correlate(rows[0]); push(pid, 'incident', open.id);
    return res.json({ ...rows[0], duplicate: true });
  }
  const { rows } = await q(
    `insert into incidents(project_id,external_id,fingerprint,title,description,severity,assignees,occurred_at,reported_by)
     values($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz,now()),$9) returning *`,
    [pid, b.external_id || null, fp, b.title, b.description || null, b.severity || 'medium', b.assignees || [], b.occurred_at || null, req.user.id]);
  await correlate(rows[0]);
  await audit(req.user, 'create', 'incident', rows[0].id, { title: b.title });
  push(pid, 'incident', rows[0].id);
  res.status(201).json(rows[0]);
}));

api.get('/incidents/:id', h(async (req, res) => {
  const inc = await getInc(req.params.id);
  if (!inc) return bad(res, 'not found', 404);
  const updates = (await q(`select u.*, usr.name user_name from incident_updates u left join users usr on usr.id=u.user_id
    where incident_id=$1 order by created_at`, [inc.id])).rows;
  const suspects = (await q(
    `select s.*, d.version, d.environment, d.deployed_at, d.status dep_status, c.message, c.author
     from incident_suspects s
     left join deployments d on s.kind='deployment' and d.id=s.ref_id
     left join changes c on s.kind='change' and c.id=s.ref_id
     where s.incident_id=$1 order by s.score desc`, [inc.id])).rows;
  res.json({ ...inc, updates, suspects });
}));

// Edit with optimistic locking: the client sends the version it last saw.
api.patch('/incidents/:id', WRITE, h(async (req, res) => {
  const b = req.body, id = +req.params.id;
  if (b.version == null) return bad(res, 'version is required (optimistic locking)');
  const cur = await getInc(id);
  if (!cur) return bad(res, 'not found', 404);
  const status = b.status ?? cur.status;
  if (status === 'resolved' && !(b.resolution || cur.resolution)) return bad(res, 'resolution details are required to resolve an incident');
  const { rows } = await q(
    `update incidents set title=$3, description=$4, severity=$5, status=$6, assignees=$7, resolution=$8,
       resolved_at = case when $6='resolved' then coalesce(resolved_at,$9::timestamptz,now()) else null end,
       version=version+1
     where id=$1 and version=$2 returning *`,
    [id, b.version, b.title ?? cur.title, b.description ?? cur.description, b.severity ?? cur.severity, status,
      b.assignees ?? cur.assignees, b.resolution ?? cur.resolution, b.resolved_at || null]);
  if (!rows[0]) return res.status(409).json({ error: 'stale version: someone else updated this incident, reload and retry', current: await getInc(id) });
  const diff = ['status', 'severity', 'title', 'assignees', 'resolution']
    .filter(k => JSON.stringify(cur[k]) !== JSON.stringify(rows[0][k]))
    .map(k => `${k}: ${cur[k] ?? '-'} -> ${rows[0][k] ?? '-'}`);
  if (diff.length) await q(`insert into incident_updates(incident_id,user_id,kind,body) values($1,$2,'change',$3)`, [id, req.user.id, diff.join('; ')]);
  await audit(req.user, 'update', 'incident', id, { diff });
  push(cur.project_id, 'incident', id);
  res.json(rows[0]);
}));

// Many users can append updates at the same time; appends never conflict. client_id makes retries idempotent.
api.post('/incidents/:id/updates', WRITE, h(async (req, res) => {
  const { body, kind = 'comment', client_id } = req.body;
  if (!body) return bad(res, 'body is required');
  const inc = await getInc(req.params.id);
  if (!inc) return bad(res, 'not found', 404);
  const { rows } = await q(`insert into incident_updates(incident_id,user_id,kind,body,client_id) values($1,$2,$3,$4,$5)
    on conflict (incident_id,client_id) do nothing returning *`, [inc.id, req.user.id, kind, body, client_id || null]);
  push(inc.project_id, 'incident', inc.id);
  res.status(rows[0] ? 201 : 200).json(rows[0] || { duplicate: true });
}));

api.post('/incidents/:id/correlate', WRITE, h(async (req, res) => {
  const inc = await getInc(req.params.id);
  if (!inc) return bad(res, 'not found', 404);
  await correlate(inc); push(inc.project_id, 'incident', inc.id);
  res.json({ ok: true });
}));
api.post('/incidents/:id/suspects', WRITE, h(async (req, res) => {
  const { kind, ref_id, reason } = req.body;
  if (!['deployment', 'change'].includes(kind) || !ref_id) return bad(res, 'kind (deployment|change) and ref_id are required');
  const inc = await getInc(req.params.id);
  if (!inc) return bad(res, 'not found', 404);
  const { rows } = await q(`insert into incident_suspects(incident_id,kind,ref_id,score,reason,source) values($1,$2,$3,100,$4,'manual')
    on conflict (incident_id,kind,ref_id) do update set source='manual', score=100, reason=excluded.reason returning *`,
  [inc.id, kind, ref_id, reason || `linked manually by ${req.user.name}`]);
  await audit(req.user, 'link', 'incident', inc.id, { kind, ref_id });
  push(inc.project_id, 'incident', inc.id);
  res.status(201).json(rows[0]);
}));
api.delete('/incidents/:id/suspects/:sid', WRITE, h(async (req, res) => {
  await q('delete from incident_suspects where id=$1 and incident_id=$2', [req.params.sid, req.params.id]);
  res.status(204).end();
}));

// dashboard
api.get('/projects/:pid/dashboard', h(async (req, res) => {
  const pid = req.params.pid;
  const [inc, dep, mttr, recurring, risky, recent] = await Promise.all([
    q(`select status, severity, count(*)::int n from incidents where project_id=$1 group by 1,2`, [pid]),
    q(`select status, count(*)::int n from deployments where project_id=$1 and deployed_at > now()-interval '7 days' group by 1`, [pid]),
    q(`select round(avg(extract(epoch from resolved_at-occurred_at)/60))::int m from incidents where project_id=$1 and resolved_at is not null`, [pid]),
    q(`select min(title) title, sum(report_count)::int occurrences, max(occurred_at) last_seen from incidents where project_id=$1
       group by fingerprint having sum(report_count)>1 order by 2 desc limit 5`, [pid]),
    q(`select d.id, d.version, d.environment, d.deployed_at, count(*)::int incidents, max(s.score) top_score
       from incident_suspects s join deployments d on s.kind='deployment' and d.id=s.ref_id
       where d.project_id=$1 group by d.id order by incidents desc, top_score desc limit 5`, [pid]),
    q(`select * from deployments where project_id=$1 order by deployed_at desc limit 5`, [pid]),
  ]);
  const sum = f => inc.rows.filter(f).reduce((a, r) => a + r.n, 0);
  res.json({
    open: sum(r => r.status !== 'resolved'),
    critical_open: sum(r => r.status !== 'resolved' && r.severity === 'critical'),
    total_incidents: sum(() => true),
    mttr_minutes: mttr.rows[0].m,
    deploys_7d: dep.rows.reduce((a, r) => a + r.n, 0),
    deploys_by_status: dep.rows,
    incidents_by_status: inc.rows,
    recurring: recurring.rows, risky: risky.rows, recent: recent.rows,
  });
}));

api.get('/audit-logs', allow('admin'), h(async (_req, res) =>
  res.json((await q(`select a.*, u.name user_name from audit_logs a left join users u on u.id=a.user_id order by a.id desc limit 200`)).rows)));

app.use('/api', api);

/* ---------- errors ---------- */
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return bad(res, 'invalid JSON body');
  const map = { '22P02': [400, 'invalid input'], '23505': [409, 'already exists'], '23503': [400, 'referenced record not found'],
    '23514': [400, 'invalid value'], '23502': [400, 'missing required field'] };
  const m = map[err.code];
  if (m) return res.status(m[0]).json({ error: `${m[1]}${err.detail ? ': ' + err.detail : ''}` });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const PORT = process.env.PORT || 3000;
db.init().then(() => app.listen(PORT, () => console.log(`Who Broke the Build? running on :${PORT}`)))
  .catch(e => { console.error('startup failed', e); process.exit(1); });
