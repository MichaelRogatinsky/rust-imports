import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	cargoDynamicLibraryName,
	compileRustModule,
	fingerprintRustInputs,
	generateCargoToml,
	generateDeclarationModule,
	generateProxyModule,
	generateRustLib,
	resolveRustSourcePath
} from './compiler';

const temporaryDirectories: string[] = [];
const nativeRequire = createRequire(import.meta.url);

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'rust-imports-test-'));
	temporaryDirectories.push(path);
	return path;
}

async function buildNativeFixture(root: string): Promise<string> {
	const sourcePath = join(root, 'native-fixture.rs');
	const fixturePath = join(root, 'native-fixture.node');
	await writeFile(
		sourcePath,
		`#![allow(non_camel_case_types)]
use std::ffi::{c_char, c_void};

type napi_env = *mut c_void;
type napi_value = *mut c_void;
type napi_status = i32;

extern "C" {
    fn napi_create_int32(env: napi_env, value: i32, result: *mut napi_value) -> napi_status;
    fn napi_set_named_property(
        env: napi_env,
        object: napi_value,
        utf8_name: *const c_char,
        value: napi_value,
    ) -> napi_status;
}

#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(
    env: napi_env,
    exports: napi_value,
) -> napi_value {
    let mut answer = std::ptr::null_mut();
    assert_eq!(napi_create_int32(env, 12, &mut answer), 0);
    assert_eq!(
        napi_set_named_property(env, exports, b"answer\\0".as_ptr().cast(), answer),
        0,
    );
    exports
}
`
	);

	const args = [
		'--crate-name',
		'rust_imports_test_fixture',
		'--crate-type',
		'cdylib',
		'--edition',
		'2021',
		sourcePath,
		'-o',
		fixturePath
	];
	if (process.platform === 'darwin') {
		args.push('-C', 'link-arg=-undefined', '-C', 'link-arg=dynamic_lookup');
	}
	const child = Bun.spawn(['rustc', ...args], {
		cwd: root,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text()
	]);
	if (exitCode !== 0) {
		throw new Error(`rustc failed to build the native test fixture (${exitCode})\n${stdout}\n${stderr}`);
	}

	const loaded = nativeRequire(fixturePath) as { answer?: unknown };
	if (loaded.answer !== 12) {
		throw new Error('the native test fixture did not expose its expected Node-API export');
	}
	return fixturePath;
}

async function installFakeToolchain(root: string): Promise<string> {
	const tool = join(root, 'fake-toolchain.ts');
	await writeFile(
		tool,
		`#!/usr/bin/env bun
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const versionFile = process.env.FAKE_VERSION_FILE;
const version = versionFile ? (await readFile(versionFile, 'utf8')).trim() : 'v1';
if (args[0] === '--version') {
	console.log('cargo 1.0.0 (' + version + ')');
	process.exit(0);
}
if (args[0] === '-vV') {
	console.log('rustc 1.83.0\\ncommit-hash: ' + version + '\\nhost: ' + process.platform + '-' + process.arch);
	process.exit(0);
}
if (args[0] !== 'build') process.exit(42);

const counterPath = process.env.FAKE_COUNTER_PATH;
const sourcePath = process.env.FAKE_SOURCE_PATH;
const fixturePath = process.env.FAKE_NATIVE_PATH;
const targetDir = process.env.CARGO_TARGET_DIR;
const activeDir = process.env.FAKE_ACTIVE_DIR;
if (!counterPath || !sourcePath || !fixturePath || !targetDir || !activeDir) process.exit(43);

let overlap = false;
try {
	await mkdir(activeDir);
} catch (error) {
	if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') overlap = true;
	else throw error;
}
if (overlap) await writeFile(activeDir + '.overlap', 'overlap\\n');
try {
	let prior = '';
	try { prior = await readFile(counterPath, 'utf8'); } catch {}
	const buildNumber = prior.split('\\n').filter(Boolean).length + 1;
	await appendFile(counterPath, JSON.stringify({ pid: process.pid, args }) + '\\n');
	await Bun.sleep(Number(process.env.FAKE_BUILD_DELAY_MS || '25'));
	if (Number(process.env.FAKE_MUTATE_ON_BUILD || '0') === buildNumber) {
		await writeFile(sourcePath, process.env.FAKE_MUTATED_SOURCE || '// mutated\\n');
	}

	const manifestIndex = args.indexOf('--manifest-path');
	const manifestPath = args[manifestIndex + 1];
	const manifest = await readFile(manifestPath, 'utf8');
	const packageName = manifest.match(/^name = "([^"]+)"/m)?.[1];
	if (!packageName) process.exit(44);
	const lockPath = join(dirname(manifestPath), 'Cargo.lock');
	if (args.includes('--locked')) {
		const lock = await readFile(lockPath, 'utf8');
		if (lock.includes('stale-lock')) process.exit(45);
	}
	let lockExists = true;
	try { await readFile(lockPath); } catch { lockExists = false; }
	if (!lockExists || process.env.FAKE_PRESERVE_LOCK !== '1') {
		await writeFile(lockPath, '# fake lock\\n');
	}

	const profile = args.includes('--release') ? 'release' : 'debug';
	const libraryName = process.platform === 'win32'
		? packageName + '.dll'
		: 'lib' + packageName + (process.platform === 'darwin' ? '.dylib' : '.so');
	const output = join(targetDir, profile, libraryName);
	await mkdir(dirname(output), { recursive: true });
	await copyFile(fixturePath, output);
	const depfile = output.replace(/\\.[^.]+$/, '.d');
	const generatedLib = join(dirname(manifestPath), 'src', 'lib.rs');
	await writeFile(depfile, output + ': ' + generatedLib + ' ' + sourcePath + '\\n');
} finally {
	if (!overlap) await rm(activeDir, { recursive: true, force: true });
}
`
	);
	await chmod(tool, 0o755);
	return tool;
}

type FakeCompileSetup = {
	root: string;
	sourcePath: string;
	cacheDir: string;
	toolPath: string;
	counterPath: string;
	activeDir: string;
	versionFile: string;
	options: Parameters<typeof compileRustModule>[1];
};

async function fakeCompileSetup(): Promise<FakeCompileSetup> {
	const root = await temporaryDirectory();
	const fixture = await buildNativeFixture(root);
	const sourcePath = join(root, 'math.rs');
	const cacheDir = join(root, 'cache');
	const counterPath = join(root, 'builds.jsonl');
	const activeDir = join(root, 'active-build');
	const versionFile = join(root, 'toolchain-version');
	const cargoHome = join(root, 'cargo-home');
	const toolPath = await installFakeToolchain(root);
	await writeFile(sourcePath, '// fake Rust source v1\n');
	await writeFile(versionFile, 'toolchain-v1\n');
	await mkdir(join(root, '.cargo'), { recursive: true });
	await writeFile(join(root, '.cargo', 'config.toml'), '[build]\nincremental = true\n');
	await mkdir(cargoHome, { recursive: true });
	await writeFile(join(cargoHome, 'config.toml'), '[net]\nretry = 2\n');
	return {
		root,
		sourcePath,
		cacheDir,
		toolPath,
		counterPath,
		activeDir,
		versionFile,
		options: {
			allowedRoot: root,
			cacheDir,
			cargo: toolPath,
			env: {
				CARGO_HOME: cargoHome,
				RUSTC: toolPath,
				FAKE_ACTIVE_DIR: activeDir,
				FAKE_BUILD_DELAY_MS: '75',
				FAKE_COUNTER_PATH: counterPath,
				FAKE_NATIVE_PATH: fixture,
				FAKE_PRESERVE_LOCK: '1',
				FAKE_SOURCE_PATH: sourcePath,
				FAKE_VERSION_FILE: versionFile,
				SECRET_BUILD_TOKEN: 'do-not-persist-this-value'
			}
		}
	};
}

async function readBuildInvocations(counterPath: string): Promise<Array<{ args: string[] }>> {
	const contents = await readFile(counterPath, 'utf8');
	return contents
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { args: string[] });
}

async function readOnlyState(cacheDir: string): Promise<{ path: string; text: string; data: Record<string, unknown> }> {
	const stateDir = join(cacheDir, 'state');
	const files = (await readdir(stateDir)).filter((file) => file.endsWith('.json'));
	expect(files).toHaveLength(1);
	const path = join(stateDir, files[0]);
	const text = await readFile(path, 'utf8');
	return { path, text, data: JSON.parse(text) as Record<string, unknown> };
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

async function writeCompilerRunner(setup: FakeCompileSetup): Promise<string> {
	const runner = join(setup.root, 'compile-runner.ts');
	const compilerUrl = pathToFileURL(join(import.meta.dir, 'compiler.ts')).href;
	await writeFile(
		runner,
		`const { compileRustModule } = await import(${JSON.stringify(compilerUrl)});
await compileRustModule(${JSON.stringify(setup.sourcePath)}, ${JSON.stringify(setup.options)});
`
	);
	return runner;
}

async function runCompilerChild(
	runner: string,
	environment: Readonly<Record<string, string | undefined>> = {}
): Promise<void> {
	const child = Bun.spawn([process.execPath, runner], {
		cwd: dirname(runner),
		env: { ...process.env, ...environment },
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text()
	]);
	if (exitCode !== 0) {
		throw new Error(`compiler child exited ${exitCode}\n${stdout}\n${stderr}`);
	}
}

describe('resolveRustSourcePath', () => {
	test('accepts an existing Rust source under the allowed root', async () => {
		const root = await temporaryDirectory();
		const source = join(root, 'nested', 'math.rs');
		await mkdir(join(root, 'nested'));
		await writeFile(source, '#[napi]\npub fn add() {}\n');

		expect(await resolveRustSourcePath(source, root)).toBe(source);
	});

	test('rejects traversal outside the allowed root', async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, 'root');
		const source = join(parent, 'outside.rs');
		await mkdir(root);
		await writeFile(source, 'pub fn outside() {}\n');

		await expect(resolveRustSourcePath(source, root)).rejects.toThrow('must be inside allowedRoot');
	});

	test('rejects a symlink that escapes the allowed root', async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, 'root');
		const outside = join(parent, 'outside.rs');
		const linked = join(root, 'linked.rs');
		await mkdir(root);
		await writeFile(outside, 'pub fn outside() {}\n');
		await symlink(outside, linked);

		await expect(resolveRustSourcePath(linked, root)).rejects.toThrow('resolves outside allowedRoot');
	});

	test('rejects non-Rust inputs before invoking any toolchain', async () => {
		const root = await temporaryDirectory();
		const source = join(root, 'math.ts');
		await writeFile(source, 'export const add = () => 1;\n');

		await expect(resolveRustSourcePath(source, root)).rejects.toThrow('expected a .rs source file');
	});
});

describe('crate generation', () => {
	test('pins the Rust-1.83-compatible napi-rs dependency set', () => {
		const manifest = generateCargoToml('rust_import_abc123');

		expect(manifest).toStartWith('# @generated by rust-imports. Do not edit.');
		expect(manifest).toContain('rust-version = "1.83"');
		expect(manifest).toContain('napi = { version = "=2.16.17"');
		expect(manifest).toContain('napi-derive = { version = "=2.16.13"');
		expect(manifest).toContain('napi-build = "=2.2.3"');
		expect(manifest).toContain('unicode-segmentation = "=1.12.0"');
		expect(manifest).toContain('\n[workspace]\n');
	});

	test('path-includes one source as an isolated module', () => {
		const source = '/project/routes/math.rs';
		const lib = generateRustLib(source);

		expect(lib).toContain(`#[path = r#"${source}"#]`);
		expect(lib).toContain('mod rust_import_source;');
		expect(lib).toContain('pub use rust_import_source::*;');
	});

	test('uses the host dynamic-library convention', () => {
		expect(cargoDynamicLibraryName('rust_import_abc', 'linux')).toBe('librust_import_abc.so');
		expect(cargoDynamicLibraryName('rust_import_abc', 'darwin')).toBe(
			'librust_import_abc.dylib'
		);
		expect(cargoDynamicLibraryName('rust_import_abc', 'win32')).toBe('rust_import_abc.dll');
	});
});

describe('generated module surfaces', () => {
	test('proxy loads an adjacent native file and exposes inspected names', () => {
		const proxy = generateProxyModule('math.abc.linux-x64.node', [
			'add',
			'answer',
			'default',
			'not-valid'
		]);

		expect(proxy).toContain("import { createRequire } from 'node:module'");
		expect(proxy).toContain('require("./math.abc.linux-x64.node")');
		expect(proxy).toContain('export const add = native["add"]');
		expect(proxy).toContain('export const answer = native["answer"]');
		expect(proxy).not.toContain('export const default');
		expect(proxy).not.toContain('export const not-valid');
	});

	test('declaration mirrors the valid inspected names', () => {
		const invalidStrictBindings = [
			'arguments',
			'eval',
			'implements',
			'interface',
			'package',
			'private',
			'protected',
			'public'
		];
		const declaration = generateDeclarationModule([
			'add',
			'Widget',
			'Δ',
			'class',
			...invalidStrictBindings
		]);

		expect(declaration).toContain('export const add: any;');
		expect(declaration).toContain('export const Widget: any;');
		expect(declaration).toContain('export const Δ: any;');
		expect(declaration).not.toContain('export const class');
		for (const name of invalidStrictBindings) {
			expect(declaration).not.toContain(`export const ${name}:`);
		}
	});
});

describe('content fingerprints', () => {
	test('are stable regardless of input order', () => {
		const first = fingerprintRustInputs(
			[
				{ path: 'math.rs', contents: 'pub fn add() {}' },
				{ path: 'helper.rs', contents: 'pub fn helper() {}' }
			],
			'profile=debug'
		);
		const second = fingerprintRustInputs(
			[
				{ path: 'helper.rs', contents: 'pub fn helper() {}' },
				{ path: 'math.rs', contents: 'pub fn add() {}' }
			],
			'profile=debug'
		);

		expect(second).toBe(first);
	});

	test('change for dependency content and build configuration', () => {
		const original = fingerprintRustInputs(
			[{ path: 'math.rs', contents: 'pub fn add() -> i32 { 1 }' }],
			'profile=debug'
		);
		const sourceChanged = fingerprintRustInputs(
			[{ path: 'math.rs', contents: 'pub fn add() -> i32 { 2 }' }],
			'profile=debug'
		);
		const configChanged = fingerprintRustInputs(
			[{ path: 'math.rs', contents: 'pub fn add() -> i32 { 1 }' }],
			'profile=release'
		);

		expect(sourceChanged).not.toBe(original);
		expect(configChanged).not.toBe(original);
		expect(original).toHaveLength(64);
	});
});

describe('compiler cache safety', () => {
	test('serializes separate processes, replaces stale locks, and persists only hashed config identity', async () => {
		const setup = await fakeCompileSetup();

		const sourceKey = createHash('sha256').update(resolve(setup.sourcePath)).digest('hex').slice(0, 16);
		const crateDir = join(setup.cacheDir, 'crates', sourceKey);
		await mkdir(crateDir, { recursive: true });
		// Simulate a crash after the new manifest was committed but before its
		// stale lockfile was removed/fingerprinted.
		await writeFile(
			join(crateDir, 'Cargo.toml'),
			generateCargoToml(`rust_import_${sourceKey}`)
		);
		await writeFile(join(crateDir, 'Cargo.lock'), 'stale-lock\n');

		const runner = await writeCompilerRunner(setup);
		await Promise.all([runCompilerChild(runner), runCompilerChild(runner)]);

		const builds = await readBuildInvocations(setup.counterPath);
		expect(builds).toHaveLength(2);
		expect(builds[0].args).not.toContain('--locked');
		expect(builds[1].args).toContain('--locked');
		expect(await fileExists(`${setup.activeDir}.overlap`)).toBe(false);
		expect(await readdir(join(setup.cacheDir, 'locks'))).toEqual([]);

		const state = await readOnlyState(setup.cacheDir);
		expect(state.text).not.toContain('do-not-persist-this-value');
		expect(state.text).not.toContain(setup.toolPath);
		expect(state.text).not.toContain(setup.counterPath);
		expect(state.text).not.toContain(join(setup.root, 'cargo-home'));
		expect(state.data).not.toHaveProperty('configKey');
		expect(state.data).not.toHaveProperty('env');
		expect(state.data.baseConfigHash).toMatch(/^[a-f0-9]{64}$/);
		expect(state.data.toolchainHash).toMatch(/^[a-f0-9]{64}$/);

		const manifest = await readFile(join(crateDir, 'Cargo.toml'), 'utf8');
		expect(manifest).toContain('\n[workspace]\n');
		expect(await readFile(join(crateDir, 'Cargo.lock'), 'utf8')).toBe('# fake lock\n');
	});

	test('rebuilds until source inputs stabilize and invalidates on toolchain identity changes', async () => {
		const setup = await fakeCompileSetup();
		setup.options = {
			...setup.options,
			env: {
				...setup.options.env,
				FAKE_MUTATE_ON_BUILD: '2',
				FAKE_MUTATED_SOURCE: '// fake Rust source v2\n'
			}
		};

		const first = await compileRustModule(setup.sourcePath, setup.options);
		expect(await readFile(setup.sourcePath, 'utf8')).toBe('// fake Rust source v2\n');
		expect(await readBuildInvocations(setup.counterPath)).toHaveLength(3);

		const cached = await compileRustModule(setup.sourcePath, setup.options);
		expect(cached.fingerprint).toBe(first.fingerprint);
		expect(await readBuildInvocations(setup.counterPath)).toHaveLength(3);

		// npm and other launchers commonly prepend their own bin directory. The
		// selected absolute tools and their versions are unchanged, so ambient
		// PATH noise must not invalidate the native cache.
		const runner = await writeCompilerRunner(setup);
		await runCompilerChild(runner, {
			PATH: `${join(setup.root, 'unused-bin')}${delimiter}${process.env.PATH ?? ''}`
		});
		expect(await readBuildInvocations(setup.counterPath)).toHaveLength(3);

		const sourceKey = createHash('sha256').update(resolve(setup.sourcePath)).digest('hex').slice(0, 16);
		const lockPath = join(setup.cacheDir, 'crates', sourceKey, 'Cargo.lock');
		const originalState = await readOnlyState(setup.cacheDir);
		await writeFile(lockPath, '# fake lock\n# alternate transitive resolution\n');
		const lockRebuilt = await compileRustModule(setup.sourcePath, setup.options);
		const lockState = await readOnlyState(setup.cacheDir);
		expect(await readBuildInvocations(setup.counterPath)).toHaveLength(5);
		expect(lockRebuilt.fingerprint).not.toBe(first.fingerprint);
		expect(lockState.data.baseConfigHash).toBe(originalState.data.baseConfigHash);
		expect(lockState.data.toolchainHash).toBe(originalState.data.toolchainHash);

		await writeFile(join(setup.root, '.cargo', 'config.toml'), '[build]\nincremental = false\n');
		const projectConfigRebuilt = await compileRustModule(setup.sourcePath, setup.options);
		const projectConfigState = await readOnlyState(setup.cacheDir);
		expect(await readBuildInvocations(setup.counterPath)).toHaveLength(7);
		expect(projectConfigRebuilt.fingerprint).not.toBe(lockRebuilt.fingerprint);
		expect(projectConfigState.data.baseConfigHash).not.toBe(lockState.data.baseConfigHash);

		await writeFile(join(setup.root, 'cargo-home', 'config.toml'), '[net]\nretry = 4\n');
		const homeConfigRebuilt = await compileRustModule(setup.sourcePath, setup.options);
		expect(await readBuildInvocations(setup.counterPath)).toHaveLength(9);
		expect(homeConfigRebuilt.fingerprint).not.toBe(projectConfigRebuilt.fingerprint);

		const previousBuildTarget = process.env.CARGO_BUILD_TARGET;
		try {
			process.env.CARGO_BUILD_TARGET = 'fake-host-target';
			const targetEnvRebuilt = await compileRustModule(setup.sourcePath, setup.options);
			expect(await readBuildInvocations(setup.counterPath)).toHaveLength(11);
			expect(targetEnvRebuilt.fingerprint).not.toBe(homeConfigRebuilt.fingerprint);

			await writeFile(setup.versionFile, 'toolchain-v2\n');
			const rebuilt = await compileRustModule(setup.sourcePath, setup.options);
			const updatedState = await readOnlyState(setup.cacheDir);

			expect(await readBuildInvocations(setup.counterPath)).toHaveLength(13);
			expect(rebuilt.fingerprint).not.toBe(targetEnvRebuilt.fingerprint);
			expect(updatedState.data.toolchainHash).not.toBe(originalState.data.toolchainHash);
		} finally {
			if (previousBuildTarget === undefined) delete process.env.CARGO_BUILD_TARGET;
			else process.env.CARGO_BUILD_TARGET = previousBuildTarget;
		}
	});
});
