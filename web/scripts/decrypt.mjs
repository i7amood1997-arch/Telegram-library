// Used by tests/test_crypto_node.py: node scripts/decrypt.mjs <file> <password>
import { readFileSync } from 'node:fs';
import { decryptWithKey, deriveKey, parseEnvelope } from '../src/crypto.js';

const [file, password] = process.argv.slice(2);
const env = parseEnvelope(readFileSync(file, 'utf8'));
const key = await deriveKey(password, env.salt, env.iter);
process.stdout.write(JSON.stringify(await decryptWithKey(env, key)));
