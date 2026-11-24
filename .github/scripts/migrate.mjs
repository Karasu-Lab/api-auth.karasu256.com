import { signRequest } from '@karasu-lab/utils/server/request-signature';

const url = `${process.env.API_AUTH_URL}/api/internal/migrate`;
const response = await fetch(url, { method: 'POST', headers: signRequest({ secret: process.env.INTERNAL_API_SECRET, method: 'POST', url }) });

console.log(response.status, await response.text());
if (!response.ok) process.exit(1);
