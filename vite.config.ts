import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { unstable_readConfig } from 'wrangler';

const wranglerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'wrangler.jsonc');

const allowedHosts = String(unstable_readConfig({ config: wranglerPath, env: 'local' }).vars.ALLOWED_HOSTS)
  .split(',')
  .filter((host) => host.length > 0);

export default defineConfig({
  plugins: [cloudflare({ inspectorPort: 9232 })],
  server: { allowedHosts, cors: false },
});
