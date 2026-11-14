/* Prepare the build, configuration, and database for migration generation. */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
process.chdir(root);

function step(msg) { console.log(`\n==> ${msg}`); }
function run(cmd) { console.log(`$ ${cmd}`); execSync(cmd, { stdio: 'inherit' }); }
function fail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

step('1/4 設定ファイルの確認');
if (!existsSync('.config/default.yml')) {
	fail([
		'.config/default.yml が存在しません。',
		'  .config/example.yml を .config/default.yml にコピーしてから再実行してください:',
		'    Unix系:     cp .config/example.yml .config/default.yml',
		'    PowerShell: Copy-Item .config/example.yml .config/default.yml',
		'  コピー後、db.user / pass / db を .config/docker.env と一致させてください',
		'  (example.yml の既定値は docker.env の例と一致するので、独自 DB を使わなければそのままで可)。',
	].join('\n'));
}
if (!existsSync('.config/docker.env')) {
	fail([
		'.config/docker.env が存在しません (compose.local-db.yml の db が要求)。',
		'  例 (.config/default.yml の db.user / db.pass / db.db と一致させる):',
		'  POSTGRES_USER=example-misskey-user',
		'  POSTGRES_PASSWORD=example-misskey-pass',
		'  POSTGRES_DB=misskey',
	].join('\n'));
}
console.log('OK: .config/default.yml と .config/docker.env あり');

step('2/4 built/meta.json の生成 (build-pre)');
run('pnpm build-pre');

step('3/4 backend のビルド (エンティティを built/ へ反映)');
run('pnpm --filter backend build');

step('4/4 ローカル DB の起動 (postgres のみ・healthcheck 完了まで待機)');
run('docker compose -f compose.local-db.yml up -d --wait db');

console.log('\n準備完了。次を実行できます:');
console.log('  pnpm --filter backend exec typeorm migration:generate -d ormconfig.js -o --esm migration/<PascalName>');
