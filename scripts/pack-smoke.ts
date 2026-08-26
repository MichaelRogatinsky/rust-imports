import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const expectedManifest = JSON.parse(
	await readFile(join(packageRoot, 'package.json'), 'utf8')
) as { name?: string; version?: string };
const temporaryRoot = await mkdtemp(join(tmpdir(), 'rust-imports-pack-'));

try {
	const packedDirectory = join(temporaryRoot, 'packed');
	const consumerDirectory = join(temporaryRoot, 'consumer');
	const extractedDirectory = join(temporaryRoot, 'extracted');
	await mkdir(packedDirectory, { recursive: true });
	await mkdir(consumerDirectory, { recursive: true });
	await mkdir(extractedDirectory, { recursive: true });

	await run(
		'npm',
		['pack', '--ignore-scripts', '--pack-destination', packedDirectory],
		packageRoot
	);
	const tarballs = (await readdir(packedDirectory)).filter((path) => path.endsWith('.tgz'));
	if (tarballs.length !== 1) {
		throw new Error(`npm pack produced ${tarballs.length} tarballs instead of one`);
	}
	const tarball = join(packedDirectory, tarballs[0]);
	await run('tar', ['-xzf', tarball, '-C', extractedDirectory], packageRoot);
	const packedPaths = await listFiles(join(extractedDirectory, 'package'));
	for (const required of [
		'package.json',
		'LICENSE',
		'README.md',
		'dist/index.js',
		'dist/index.d.ts',
		'dist/register.js',
		'dist/cli.js',
		'bin/rust-imports'
	]) {
		if (!packedPaths.includes(required)) throw new Error(`packed package is missing ${required}`);
	}
	const leakedSource = packedPaths.find(
		(path) =>
			path.endsWith('.test.ts') ||
			path.startsWith('scripts/') ||
			(path.endsWith('.ts') && !path.endsWith('.d.ts'))
	);
	if (leakedSource) throw new Error(`packed package contains source-only file ${leakedSource}`);

	await writeFile(
		join(consumerDirectory, 'package.json'),
		JSON.stringify({ name: 'rust-imports-pack-smoke', private: true, type: 'module' }, null, 2) +
			'\n'
	);
	await run('bun', ['add', '--ignore-scripts', tarball], consumerDirectory);

	await writeFile(
		join(consumerDirectory, 'bunfig.toml'),
		'preload = ["rust-imports/register"]\n'
	);
	await run(
		'bun',
		[
			'-e',
			`import { compileRustModule, prepareRustImports, rustImportsPlugin } from 'rust-imports';
			 import { prepareRustImports as buildExport } from 'rust-imports/build';
			 import { compileRustModule as compilerExport } from 'rust-imports/compiler';
			 import { rustImportsPlugin as runtimeExport } from 'rust-imports/runtime';
			 import 'rust-imports/register';
			 if (compileRustModule !== compilerExport || prepareRustImports !== buildExport || rustImportsPlugin !== runtimeExport) throw new Error('subpath exports do not share implementations');
			 console.log('imports-ok');`
		],
		consumerDirectory
	);
	await run('bun', ['run', 'rust-imports', '--help'], consumerDirectory);

	const installedManifest = JSON.parse(
		await readFile(
			join(consumerDirectory, 'node_modules', 'rust-imports', 'package.json'),
			'utf8'
		)
	) as { name?: string; version?: string };
	if (
		installedManifest.name !== expectedManifest.name ||
		installedManifest.version !== expectedManifest.version
	) {
		throw new Error('installed package identity does not match the packed package');
	}

	console.log('rust-imports: packed-package smoke test passed');
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
	const child = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: {
			...globalThis.process.env,
			BUN_INSTALL_CACHE_DIR: join(temporaryRoot, 'bun-cache'),
			npm_config_cache: join(temporaryRoot, 'npm-cache')
		}
	});
	if (child.error) throw child.error;
	const stdout = child.stdout ?? '';
	const stderr = child.stderr ?? '';
	if (child.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed with exit code ${child.status}` +
				(stderr.trim() ? `\n${stderr.trim()}` : '') +
				(stdout.trim() ? `\n${stdout.trim()}` : '')
		);
	}
	return stdout;
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = `${prefix}${entry.name}`;
		if (entry.isDirectory()) paths.push(...(await listFiles(join(directory, entry.name), `${path}/`)));
		else paths.push(path);
	}
	return paths;
}
