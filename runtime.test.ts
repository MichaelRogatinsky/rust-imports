import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RustArtifact } from './types';
import {
	assertPathInsideRoot,
	isRustFileSpecifier,
	isValidJavaScriptIdentifier,
	resolveRustImportPath,
	resolveRustSource,
	shapeNativeExports,
	validateRustArtifact
} from './runtime';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
	);
});

describe('Rust import resolution', () => {
	test('recognizes only relative and absolute .rs filesystem specifiers', () => {
		expect(isRustFileSpecifier('./math.rs')).toBe(true);
		expect(isRustFileSpecifier('../shared/math.rs')).toBe(true);
		expect(isRustFileSpecifier('.\\math.rs')).toBe(true);
		expect(isRustFileSpecifier(resolve('/workspace/api/math.rs'))).toBe(true);
		expect(isRustFileSpecifier('some-package.rs')).toBe(false);
		expect(isRustFileSpecifier('./math.ts')).toBe(false);
	});

	test('resolves relative sources against the importer and confines them to rootDir', () => {
		const root = resolve('/workspace/api');
		const source = resolveRustImportPath('./native/math.rs', join(root, 'src'), root);
		expect(source).toBe(join(root, 'src', 'native', 'math.rs'));
	});

	test('accepts an absolute source under rootDir', () => {
		const root = resolve('/workspace/api');
		const source = join(root, 'native', 'math.rs');
		expect(resolveRustImportPath(source, '', root)).toBe(source);
	});

	test('rejects bare, non-Rust, and root-escaping imports with actionable messages', () => {
		const root = resolve('/workspace/api');
		expect(() => resolveRustImportPath('math.rs', root, root)).toThrow('relative (./ or ../) or absolute');
		expect(() => resolveRustImportPath('./math.ts', root, root)).toThrow('expected a .rs source');
		expect(() => resolveRustImportPath('../outside.rs', root, root)).toThrow('outside the allowed root');
	});

	test('requires an importer directory for a relative source', () => {
		expect(() => resolveRustImportPath('./math.rs', '', resolve('/workspace/api'))).toThrow(
			'without an importer directory'
		);
	});

	test('rejects a symlink that escapes rootDir', async () => {
		const temporary = await mkdtemp(join(tmpdir(), 'rust-imports-runtime-'));
		temporaryDirectories.push(temporary);
		const root = join(temporary, 'root');
		const outside = join(temporary, 'outside');
		await mkdir(root);
		await mkdir(outside);
		await writeFile(join(outside, 'math.rs'), 'pub fn add() {}');
		await symlink(join(outside, 'math.rs'), join(root, 'math.rs'));

		await expect(resolveRustSource('./math.rs', root, root)).rejects.toThrow('outside the allowed root');
	});

	test('canonicalizes a symlink that remains inside rootDir', async () => {
		const root = await mkdtemp(join(tmpdir(), 'rust-imports-runtime-'));
		temporaryDirectories.push(root);
		const source = join(root, 'native', 'math.rs');
		await mkdir(join(root, 'native'));
		await writeFile(source, 'pub fn add() {}');
		await symlink(source, join(root, 'math.rs'));

		expect(await resolveRustSource('./math.rs', root, root)).toBe(source);
	});

	test('normalizes paths before checking containment', () => {
		const root = resolve('/workspace/api');
		expect(assertPathInsideRoot(join(root, 'src', '..', 'math.rs'), root)).toBe(
			join(root, 'math.rs')
		);
	});
});

describe('native export shaping', () => {
	test('keeps the complete addon as default and exposes only valid named exports', () => {
		const addon = Object.create(null) as Record<string, unknown>;
		addon.add = (left: number, right: number) => left + right;
		addon.Widget = class Widget {};
		addon['not-valid'] = 1;
		addon['1st'] = 2;
		addon.default = 'native default must not replace the addon object';
		addon.__proto__ = 'safe own export';

		const shaped = shapeNativeExports(addon);
		expect(shaped.default).toBe(addon);
		expect(shaped.add).toBe(addon.add);
		expect(shaped.Widget).toBe(addon.Widget);
		expect(shaped['not-valid']).toBeUndefined();
		expect(shaped['1st']).toBeUndefined();
		expect(Object.prototype.hasOwnProperty.call(shaped, '__proto__')).toBe(true);
		expect(shaped.__proto__).toBe('safe own export');
	});

	test('accepts function addons and rejects primitive addon exports', () => {
		const addon = Object.assign(() => 'ok', { version: 1 });
		expect(shapeNativeExports(addon)).toMatchObject({ default: addon, version: 1 });
		expect(() => shapeNativeExports(null)).toThrow('expected an object or function');
		expect(() => shapeNativeExports(42)).toThrow('expected an object or function');
	});

	test('uses a conservative named-export identifier set', () => {
		expect(isValidJavaScriptIdentifier('snake_case')).toBe(true);
		expect(isValidJavaScriptIdentifier('$value')).toBe(true);
		expect(isValidJavaScriptIdentifier('π')).toBe(true);
		expect(isValidJavaScriptIdentifier('dash-name')).toBe(false);
		expect(isValidJavaScriptIdentifier('1value')).toBe(false);
		expect(isValidJavaScriptIdentifier('')).toBe(false);
	});
});

describe('artifact validation', () => {
	const sourcePath = resolve('/workspace/api/native/math.rs');
	const artifact: RustArtifact = {
		arch: 'x64',
		declarationPath: resolve('/workspace/cache/math.d.rs.ts'),
		exports: ['add'],
		fingerprint: 'abc123',
		nodePath: resolve('/workspace/cache/math-abc123.node'),
		platform: 'linux',
		proxyPath: resolve('/workspace/cache/math-abc123.mjs'),
		sourcePath
	};

	test('accepts an absolute .node artifact for the current requested target', () => {
		expect(() => validateRustArtifact(artifact, sourcePath, 'linux', 'x64')).not.toThrow();
	});

	test('rejects mismatched sources, targets, and artifact extensions', () => {
		expect(() =>
			validateRustArtifact(artifact, resolve('/workspace/api/native/other.rs'), 'linux', 'x64')
		).toThrow('artifact for');
		expect(() => validateRustArtifact(artifact, sourcePath, 'darwin', 'arm64')).toThrow(
			'artifact targets linux-x64'
		);
		expect(() =>
			validateRustArtifact({ ...artifact, nodePath: resolve('/workspace/cache/math.so') }, sourcePath, 'linux', 'x64')
		).toThrow('invalid native artifact path');
	});
});
