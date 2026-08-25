import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fileSystemPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CompileRustOptions, RustArtifact } from './types';
import { prepareRustImports, type RustModuleCompiler } from './build';

const temporaryDirectories: string[] = [];
const actualFileSystemPromises = { ...fileSystemPromises };
const actualRename = fileSystemPromises.rename;
const actualWriteFile = fileSystemPromises.writeFile;

afterEach(async () => {
	mock.restore();
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
	);
});

describe('prepareRustImports graph discovery', () => {
	test('walks reachable local modules and compiles each reached Rust source once', async () => {
		const root = await temporaryRoot();
		await writeFixture(root, {
			'entry.ts': `
				import './feature.js';
				export * from './reexport';
				void import('./lazy.mjs');
				const required = require('./required.cjs');
				void required;
			`,
			'feature.ts': `import { add } from './native/math.rs'; void add;`,
			'reexport/index.ts': `export { add } from '../native/math.rs';`,
			'lazy.mts': `import math from './native/math.rs'; void math;`,
			'required.cts': `const other = require('./native/other.rs'); void other;`,
			'native/math.rs': '#[napi] pub fn add() {}',
			'native/other.rs': '#[napi] pub fn other() {}',
			'unreachable.ts': `import './native/unreachable.rs';`,
			'native/unreachable.rs': '#[napi] pub fn unreachable() {}'
		});
		const calls: string[] = [];
		const compileOptions: CompileRustOptions[] = [];
		const compile = fakeCompiler(calls, compileOptions);

		const result = await prepareRustImports({
			cargo: '/toolchains/cargo',
			compile,
			entrypoints: ['entry.ts'],
			env: { CARGO_TERM_COLOR: 'never' },
			rootDir: root
		});

		expect(result.entrypoints).toEqual([join(root, 'entry.ts')]);
		expect(new Set(result.files)).toEqual(
			new Set([
				join(root, 'entry.ts'),
				join(root, 'feature.ts'),
				join(root, 'reexport', 'index.ts'),
				join(root, 'lazy.mts'),
				join(root, 'required.cts')
			])
		);
		expect(calls.map((path) => basename(path)).sort()).toEqual(['math.rs', 'other.rs']);
		expect(compileOptions[0]).toMatchObject({
			cargo: '/toolchains/cargo',
			env: { CARGO_TERM_COLOR: 'never' }
		});
		expect(result.artifacts).toHaveLength(2);
		expect(result.rewrittenFiles).toEqual([]);
		expect(await readFile(join(root, 'feature.ts'), 'utf8')).toContain("'./native/math.rs'");
	});

	test('rejects a local dependency that escapes rootDir', async () => {
		const temporary = await mkdtemp(join(tmpdir(), 'rust-imports-build-'));
		temporaryDirectories.push(temporary);
		const root = join(temporary, 'root');
		await mkdir(root);
		await writeFile(join(root, 'entry.ts'), `import '../outside.ts';`);
		await writeFile(join(temporary, 'outside.ts'), 'export {};');

		await expect(
			prepareRustImports({
				compile: fakeCompiler([]),
				entrypoints: ['entry.ts'],
				rootDir: root
			})
		).rejects.toThrow('escapes rootDir');
	});

	test('rejects a source dependency symlink that escapes rootDir', async () => {
		const temporary = await mkdtemp(join(tmpdir(), 'rust-imports-build-'));
		temporaryDirectories.push(temporary);
		const root = join(temporary, 'root');
		await mkdir(root);
		await writeFile(join(root, 'entry.ts'), `import './linked.ts';`);
		await writeFile(join(temporary, 'outside.ts'), 'export {};');
		await symlink(join(temporary, 'outside.ts'), join(root, 'linked.ts'));

		await expect(
			prepareRustImports({
				compile: fakeCompiler([]),
				entrypoints: ['entry.ts'],
				rootDir: root
			})
		).rejects.toThrow('escapes rootDir');
	});
});

describe('prepareRustImports in-place rewriting', () => {
	test('rewrites only real import specifier tokens and leaves Rust sources in place', async () => {
		const root = await temporaryRoot();
		const original = `
			const ordinary = './math.rs';
			const prose = 'import("./math.rs")';
			const template = \`export * from "./sub.rs"\`;
			const pattern = /import\\(["']\\.\\/math\\.rs/;
			// import './math.rs';
			/* export * from './sub.rs'; */
			import { add } from './math.rs';
			export { sub } from "./sub.rs";
			const late = import(\`./math.rs\`);
			const required = require("./sub.rs");
			void ordinary; void prose; void template; void pattern; void add; void sub; void late; void required;
		`;
		await writeFixture(root, {
			'entry.ts': original,
			'math.rs': '#[napi] pub fn add() {}',
			'sub.rs': '#[napi] pub fn sub() {}'
		});
		const calls: string[] = [];

		const result = await prepareRustImports({
			compile: fakeCompiler(calls),
			entrypoints: ['entry.ts'],
			rewrite: 'in-place',
			rootDir: root
		});
		const rewritten = await readFile(join(root, 'entry.ts'), 'utf8');

		expect(calls.map((path) => basename(path)).sort()).toEqual(['math.rs', 'sub.rs']);
		expect(result.rewrittenFiles).toEqual([join(root, 'entry.ts')]);
		expect(rewritten).toContain(`const ordinary = './math.rs'`);
		expect(rewritten).toContain(`const prose = 'import("./math.rs")'`);
		expect(rewritten).toContain('const template = `export * from "./sub.rs"`');
		expect(rewritten).toContain(String.raw`const pattern = /import\(["']\.\/math\.rs/;`);
		expect(rewritten).toContain(`// import './math.rs'`);
		expect(rewritten).toContain(`/* export * from './sub.rs'; */`);
		expect(rewritten).toContain(`import { add } from './.rust-imports/math.proxy.mjs'`);
		expect(rewritten).toContain(`export { sub } from "./.rust-imports/sub.proxy.mjs"`);
		expect(rewritten).toContain('import(`./.rust-imports/math.proxy.mjs`)');
		expect(rewritten).toContain(`require("./.rust-imports/sub.proxy.mjs")`);
		expect(await readFile(join(root, 'math.rs'), 'utf8')).toContain('pub fn add');
		expect(await readFile(join(root, 'sub.rs'), 'utf8')).toContain('pub fn sub');
	});

	test('does not mutate any source when compilation fails', async () => {
		const root = await temporaryRoot();
		const original = `import './first.rs'; import './second.rs';`;
		await writeFixture(root, {
			'entry.ts': original,
			'first.rs': '#[napi] pub fn first() {}',
			'second.rs': '#[napi] pub fn second() {}'
		});
		let calls = 0;
		const compile: RustModuleCompiler = async (sourcePath, options) => {
			calls += 1;
			if (calls === 2) throw new Error('synthetic compiler failure');
			return fakeArtifact(sourcePath, options);
		};

		await expect(
			prepareRustImports({
				compile,
				entrypoints: ['entry.ts'],
				rewrite: 'in-place',
				rootDir: root
			})
		).rejects.toThrow('synthetic compiler failure');
		expect(await readFile(join(root, 'entry.ts'), 'utf8')).toBe(original);
	});

	test('revalidates every target after staging and before committing', async () => {
		const root = await temporaryRoot();
		const entryOriginal = `import './entry.rs'; import './child.ts';`;
		const childOriginal = `import './child.rs';`;
		const externallyChanged = `${entryOriginal}\n// changed while replacements were staged`;
		await writeFixture(root, {
			'entry.ts': entryOriginal,
			'child.ts': childOriginal,
			'entry.rs': '#[napi] pub fn entry() {}',
			'child.rs': '#[napi] pub fn child() {}'
		});
		let stagedWrites = 0;
		mock.module('node:fs/promises', () => ({
			...actualFileSystemPromises,
			writeFile: async (...args: Parameters<typeof actualWriteFile>) => {
				await actualWriteFile(...args);
				if (String(args[0]).includes('.rust-imports-stage')) stagedWrites += 1;
				if (stagedWrites === 2 && String(args[0]).includes('.rust-imports-stage')) {
					await actualWriteFile(join(root, 'entry.ts'), externallyChanged);
				}
			}
		}));

		try {
			await expect(
				prepareRustImports({
					compile: fakeCompiler([]),
					entrypoints: ['entry.ts'],
					rewrite: 'in-place',
					rootDir: root
				})
			).rejects.toThrow('changed before Rust imports were committed');
		} finally {
			mock.restore();
		}

		expect(stagedWrites).toBe(2);
		expect(await readFile(join(root, 'entry.ts'), 'utf8')).toBe(externallyChanged);
		expect(await readFile(join(root, 'child.ts'), 'utf8')).toBe(childOriginal);
		expect((await readdir(root)).some((name) => name.includes('.rust-imports-stage'))).toBe(false);
	});

	test('rolls back earlier atomic commits when a later commit fails', async () => {
		const root = await temporaryRoot();
		const entryOriginal = `import './entry.rs'; import './child.ts';`;
		const childOriginal = `import './child.rs';`;
		await writeFixture(root, {
			'entry.ts': entryOriginal,
			'child.ts': childOriginal,
			'entry.rs': '#[napi] pub fn entry() {}',
			'child.rs': '#[napi] pub fn child() {}'
		});

		let renameCalls = 0;
		mock.module('node:fs/promises', () => ({
			...actualFileSystemPromises,
			rename: async (from: string, to: string) => {
				renameCalls += 1;
				if (renameCalls === 2) throw new Error('synthetic later commit failure');
				return actualRename(from, to);
			}
		}));

		try {
			await expect(
				prepareRustImports({
					compile: fakeCompiler([]),
					entrypoints: ['entry.ts'],
					rewrite: 'in-place',
					rootDir: root
				})
			).rejects.toThrow('synthetic later commit failure');
		} finally {
			mock.restore();
		}

		expect(renameCalls).toBe(3);
		expect(await readFile(join(root, 'entry.ts'), 'utf8')).toBe(entryOriginal);
		expect(await readFile(join(root, 'child.ts'), 'utf8')).toBe(childOriginal);
		expect(
			(await readdir(root)).some(
				(name) => name.includes('.rust-imports-stage') || name.includes('.rust-imports-rollback')
			)
		).toBe(false);
	});

	test('does not clobber an external edit while rolling back a committed target', async () => {
		const root = await temporaryRoot();
		const entryOriginal = `import './entry.rs'; import './child.ts';`;
		const childOriginal = `import './child.rs';`;
		const externalEdit = '// external edit after the transaction commit\nexport const preserved = true;';
		const entryPath = join(root, 'entry.ts');
		await writeFixture(root, {
			'entry.ts': entryOriginal,
			'child.ts': childOriginal,
			'entry.rs': '#[napi] pub fn entry() {}',
			'child.rs': '#[napi] pub fn child() {}'
		});

		let renameCalls = 0;
		mock.module('node:fs/promises', () => ({
			...actualFileSystemPromises,
			rename: async (from: string, to: string) => {
				renameCalls += 1;
				if (renameCalls === 1) {
					await actualRename(from, to);
					if (to === entryPath) await actualWriteFile(entryPath, externalEdit);
					return;
				}
				if (renameCalls === 2) throw new Error('synthetic later commit failure');
				return actualRename(from, to);
			}
		}));

		let failure: unknown;
		try {
			await prepareRustImports({
				compile: fakeCompiler([]),
				entrypoints: ['entry.ts'],
				rewrite: 'in-place',
				rootDir: root
			});
		} catch (error) {
			failure = error;
		} finally {
			mock.restore();
		}

		expect(failure).toBeInstanceOf(AggregateError);
		if (!(failure instanceof AggregateError)) throw failure;
		expect(failure.message).toContain('1 rollback operation(s) also failed');
		expect(failure.errors.map(String).join('\n')).toContain('changed after this transaction committed it');
		expect(renameCalls).toBe(2);
		expect(await readFile(entryPath, 'utf8')).toBe(externalEdit);
		expect(await readFile(join(root, 'child.ts'), 'utf8')).toBe(childOriginal);
	});
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'rust-imports-build-'));
	temporaryDirectories.push(root);
	return resolve(root);
}

async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, contents] of Object.entries(files)) {
		const path = join(root, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, contents);
	}
}

function fakeCompiler(calls: string[], seenOptions?: CompileRustOptions[]): RustModuleCompiler {
	return async (sourcePath, options) => {
		calls.push(sourcePath);
		seenOptions?.push(options);
		const artifact = fakeArtifact(sourcePath, options);
		await mkdir(dirname(artifact.proxyPath), { recursive: true });
		await writeFile(artifact.proxyPath, 'export default {};');
		return artifact;
	};
}

function fakeArtifact(sourcePath: string, options: CompileRustOptions): RustArtifact {
	const stem = basename(sourcePath, '.rs');
	const cacheDir = options.cacheDir
		? resolve(options.allowedRoot, options.cacheDir)
		: join(options.allowedRoot, '.rust-imports');
	return {
		arch: process.arch,
		declarationPath: `${sourcePath.slice(0, -3)}.d.rs.ts`,
		exports: [],
		fingerprint: `fake-${stem}`,
		nodePath: join(cacheDir, `${stem}.node`),
		platform: process.platform,
		proxyPath: join(cacheDir, `${stem}.proxy.mjs`),
		sourcePath
	};
}
