/** Internal fixture child. Importing this module is inert; no CLI/DSN interface. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const anchor = '/Users/masonjames/Projects/dokploy/apps/dokploy/package.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file);
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };

/** Inert fixture-only check; no ambient defaults or database imports. */
export function checkFixtureChildEnvironment(env, platform, home) {
  // Darwin CoreFoundation may insert this during startup. Never read its value.
  if (platform === 'darwin') delete env.__CF_USER_TEXT_ENCODING;
  if (!Object.keys(env).every(key => key === 'HOME' || key === 'LC_ALL')) {
    throw new Error('ambient child environment');
  }
  if (typeof home !== 'string' || env.HOME !== home || env.LC_ALL !== 'C') {
    throw new Error('fixture child environment inputs');
  }
}

export async function runFixtureChild(controlFd) {
  assert(Number.isInteger(controlFd) && controlFd > 2, 'inherited control fd');
  const control = new net.Socket({ fd: controlFd, readable: true, writable: true });
  control.on('end', () => process.exit(73)); // Cooperative only; not a server fence.
  let text = '';
  const packet = await new Promise((resolve, reject) => {
    control.on('error', reject);
    control.on('data', chunk => {
      text += chunk.toString('utf8');
      if (text.length > 65536) reject(new Error('control size'));
      if (text.endsWith('\n')) resolve(JSON.parse(text));
    });
  });
  const root = packet.root;
  assert(typeof root === 'string' && /^\/private\/tmp\/hw-[a-z0-9_]+$/.test(root), 'root');
  checkFixtureChildEnvironment(process.env, process.platform, root);
  const stat = fs.lstatSync(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o700, 'private root');
  const recordBytes = read(path.join(root, 'provision.json'));
  assert(sha(recordBytes) === packet.provisionHash, 'provision bytes');
  const record = JSON.parse(recordBytes);
  assert(record.parent === process.ppid && record.root === root && record.dev === stat.dev
    && record.ino === stat.ino && record.initdb === 'completed'
    && record.socket === root + '/s' && record.database === 'hostler_fixture', 'provenance');
  assert(read(root + '/data/PG_VERSION').toString().trim() === '18', 'PG18');
  const source = path.resolve(import.meta.dirname, '..');
  for (const relative of ['apps/dokploy/package.json', 'pnpm-lock.yaml']) {
    assert(read(path.join(source, relative)).equals(read(path.join('/Users/masonjames/Projects/dokploy', relative))), 'dependency source mismatch');
  }
  const require = createRequire(anchor);
  const roots = Object.fromEntries(['drizzle-orm', 'postgres'].map(name => {
    let dir = path.dirname(fs.realpathSync(require.resolve(name)));
    while (!fs.existsSync(path.join(dir, 'package.json'))
      || JSON.parse(read(path.join(dir, 'package.json'))).name !== name) {
      assert(path.dirname(dir) !== dir, 'package root missing');
      dir = path.dirname(dir);
    }
    const pkg = JSON.parse(read(path.join(dir, 'package.json')));
    assert(pkg.name === name && pkg.version === (name === 'postgres' ? '3.4.4' : '0.45.2'), 'dependency version');
    return [name, { dir, version: pkg.version }];
  }));
  const inventory = {};
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'package symlink');
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) inventory[file] = sha(read(file));
      else throw new Error('package special file');
    }
  }
  for (const value of Object.values(roots)) visit(value.dir);
  const postgres = require('postgres');
  const { drizzle } = require('drizzle-orm/postgres-js');
  const { migrate } = require('drizzle-orm/postgres-js/migrator');
  const journal = JSON.parse(read(root + '/migrations/meta/_journal.json'));
  assert(sha(read(root + '/migrations/meta/_journal.json')) === packet.journalHash, 'journal snapshot');
  for (const entry of journal.entries) {
    assert(/^\d{4}_[a-z0-9_-]+$/.test(entry.tag), 'tag');
    assert(sha(read(root + '/migrations/' + entry.tag + '.sql')) === packet.hashes[entry.tag + '.sql'], 'SQL snapshot');
  }
  const expectedQueries = new Map();
  for (const entry of journal.entries) {
    const statements = read(root + '/migrations/' + entry.tag + '.sql').toString().split('--> statement-breakpoint');
    statements.forEach((sql, index) => expectedQueries.set(sha(sql), { tag: entry.tag, statement: index }));
  }
  let boundary = { phase: 'bootstrap' };
  let lastMigration = null;
  const sql = postgres({ host: record.socket, port: 5432, database: 'hostler_fixture',
    username: 'hostler_migrator', max: 1, connect_timeout: 3, onnotice: () => {} });
  let outcome;
  try {
    const db = drizzle(sql, { logger: { logQuery(query) {
      const migration = expectedQueries.get(sha(query));
      if (migration) lastMigration = migration.tag;
      boundary = migration ? { phase: 'migration', ...migration }
        : { phase: 'ledger-or-bootstrap', lastMigration, queryHash: sha(query) };
    } } });
    await migrate(db, { migrationsFolder: root + '/migrations',
      migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations' });
    outcome = { status: 'applied' };
  } catch (error) {
    let cause = error;
    while (cause.cause) cause = cause.cause;
    outcome = { status: 'failed', sqlstate: /^[0-9A-Z]{5}$/.test(cause.code) ? cause.code : null,
      errorClass: cause.constructor.name, boundary };
  } finally {
    await sql.end({ timeout: 5 });
  }
  const executed = {};
  for (const file of Object.keys(require.cache)) {
    const real = fs.realpathSync(file);
    assert(inventory[real] && inventory[real] === sha(read(real)), 'executed bytes changed/uninventoried');
    executed[real] = inventory[real];
  }
  process.stdout.write(JSON.stringify({ ...outcome, node: { version: process.version,
    realpath: fs.realpathSync(process.execPath) }, anchor, roots, inventory, executed }) + '\n');
  control.destroy();
}
