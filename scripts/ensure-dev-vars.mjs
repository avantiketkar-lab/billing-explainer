/**
 * Creates .dev.vars with a random dev secret if it does not exist.
 *
 * Why a script rather than a committed .dev.vars: SESSION_SECRET signs the
 * session tokens that carry account scope, so a value checked into the repo is
 * a shared signing key for everyone who clones it. And why not just let it be
 * empty: an unset secret fails deep inside WebCrypto with "Imported HMAC key
 * length (0)", which tells a first-time reader nothing about what is wrong.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (existsSync('.dev.vars')) process.exit(0);
writeFileSync('.dev.vars', `SESSION_SECRET=${randomBytes(32).toString('hex')}\n`);
console.log('Created .dev.vars with a random SESSION_SECRET (git-ignored).');
