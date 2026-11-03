// `npm run issue-key -- <app>`: issues an API key for a registered app straight from the registry
// file (no running token-service, no admin secret) and prints only the key on stdout. start-all.sh
// uses it to give a local demo its spaces-web key; on the droplet, issue keys in /admin → Apps.
import 'dotenv/config';
import { getRegistry, RegistryError } from './apps';

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: npm run issue-key -- <app slug>   (e.g. spaces-web)');
  process.exit(2);
}
try {
  process.stdout.write(`${getRegistry().issueKey(slug).key}\n`);
} catch (err) {
  console.error(err instanceof RegistryError ? err.message : err);
  process.exit(1);
}
