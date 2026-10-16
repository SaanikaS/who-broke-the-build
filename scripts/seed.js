// Demo: out-of-order events, duplicate report, late-arriving deployment.  Run: npm run seed
const B = process.env.API || 'http://localhost:3000/api';
const call = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', 'x-user-id': '1' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  console.log(m, p, r.status);
  return j;
};
const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
(async () => {
  const p = await call('POST', '/projects', { name: 'Demo Shop ' + (Date.now() % 10000), repo_url: 'https://github.com/example/shop', description: 'Demo project' });
  const P = `/projects/${p.id}`;
  await call('POST', P + '/deployments', { external_id: 'd1', version: 'v1.4.0', commit_sha: 'aaa111', deployed_by: 'asha', deployed_at: ago(30) });
  await call('POST', P + '/deployments', { external_id: 'd2', version: 'v1.5.0', commit_sha: 'bbb222', deployed_by: 'ravi', deployed_at: ago(3), notes: 'payment gateway refactor' });
  await call('POST', P + '/changes', { external_id: 'c1', commit_sha: 'bbb222', message: 'Refactor payment gateway timeout handling', author: 'ravi', committed_at: ago(4) });
  const i = await call('POST', P + '/incidents', { title: 'Payment API returning 500', severity: 'critical', occurred_at: ago(2.5), external_id: 'inc-1' });
  await call('POST', P + '/incidents', { title: 'payment api returning 500', severity: 'critical' });                  // duplicate -> merged
  await call('POST', P + '/deployments', { external_id: 'd3', version: 'v1.5.1-hotfix', deployed_at: ago(2.8), deployed_by: 'meena' }); // arrives late
  const d = await call('GET', '/incidents/' + i.id);
  console.log('\nSuspects (ranked):'); d.suspects.forEach(s => console.log(` ${s.score}  ${s.version}  ${s.reason}`));
  console.log(`\nOpen http://localhost:3000 and pick "${p.name}"`);
})();
