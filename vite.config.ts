import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { parse as parseYaml } from 'yaml';

const cloudflaredConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cloudflared-config', 'config.yml');

const tunnelHosts: string[] = (parseYaml(fs.readFileSync(cloudflaredConfigPath, 'utf-8')) as { ingress: { hostname?: string }[] }).ingress.flatMap(
  ({ hostname }) => (hostname ? [hostname] : [])
);

export default defineConfig({
  plugins: [cloudflare({ inspectorPort: 9232 })],
  server: { allowedHosts: tunnelHosts },
});
