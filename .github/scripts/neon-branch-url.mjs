import { appendFileSync } from 'node:fs';

const { NEON_API_KEY, NEON_PROJECT_ID, GITHUB_OUTPUT } = process.env;
const [branchName, databaseName = 'neondb', roleName = 'neondb_owner'] = process.argv.slice(2);

if (!branchName || !NEON_API_KEY || !NEON_PROJECT_ID) {
  console.error('Usage: NEON_API_KEY=… NEON_PROJECT_ID=… node neon-branch-url.mjs <branch> [database] [role]');
  process.exit(1);
}

const API = `https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}`;

async function neon(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${NEON_API_KEY}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Neon API GET ${path} responded ${res.status}: ${await res.text()}`);
  return res.json();
}

const { branches } = await neon(`/branches?search=${encodeURIComponent(branchName)}`);
const branch = branches.find((candidate) => candidate.name === branchName);
if (!branch) throw new Error(`Neon branch ${branchName} not found`);

async function connectionUri(pooled) {
  const query = new URLSearchParams({ branch_id: branch.id, database_name: databaseName, role_name: roleName, pooled: String(pooled) });
  const { uri } = await neon(`/connection_uri?${query}`);
  console.log(`::add-mask::${uri}`);
  return uri;
}

const [dbUrl, dbUrlPooled] = [await connectionUri(false), await connectionUri(true)];

console.log(`Using Neon branch ${branch.name} (${branch.id})`);
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `db_url=${dbUrl}\ndb_url_pooled=${dbUrlPooled}\n`);
