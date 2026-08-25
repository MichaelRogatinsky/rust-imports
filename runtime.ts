import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { BunPlugin } from 'bun';
import { compileRustModule } from './compiler';
import type { CompileRustOptions, RustArtifact } from './types';

export type RustImportsRuntimeOptions = Omit<CompileRustOptions, 'allowedRoot'> & {
	/** The only directory from which Rust source imports may be loaded. */
	rootDir?: string;
};

export type RustImportsPluginOptions = RustImportsRuntimeOptions;

/** The caller's project root unless an explicit, narrower boundary is supplied. */
export const defaultRustRoot = resolve(process.cwd());

const nativeRequire = createRequire(import.meta.url);
const pendingCompilations = new Map<string, Promise<RustArtifact>>();
let pluginInstance = 0;

/**
 * Bun's runtime adapter for adjacent Rust modules.
 *
 * The plugin never mutates source imports. It resolves an imported `.rs` file,
 * asks the shared compiler for a content-addressed addon, and exposes that
 * addon's top-level properties through Bun's object loader.
 */
export function rustImportsPlugin(options: RustImportsRuntimeOptions = {}): BunPlugin {
	const { rootDir = defaultRustRoot, ...compilerOptions } = options;
	const allowedRoot = resolve(rootDir);
	const compileOptions: CompileRustOptions = { ...compilerOptions, allowedRoot };
	const namespace = `rust-imports-runtime-${pluginInstance++}`;

	return {
		name: 'rust-imports',
		setup(build) {
			build.onResolve({ filter: /\.rs$/ }, (args) => {
				// A bare package name ending in .rs belongs to the normal resolver. This
				// adapter deliberately owns only relative and absolute filesystem imports.
				if (!isRustFileSpecifier(args.path)) return;

				const importer = 'importer' in args ? String(args.importer) : '';
				const resolveDir = args.resolveDir || (importer ? dirname(importer) : '');
				try {
					// Bun's runtime plugin API requires synchronous resolution. The core
					// compiler performs the canonical-path, existence, file, and symlink
					// checks before Cargo is invoked from the async onLoad hook.
					const path = resolveRustImportPath(args.path, resolveDir, allowedRoot);
					return { path, namespace };
				} catch (error) {
					const importedFrom = importer ? ` imported from ${importer}` : '';
					throw withCause(
						`rust-imports: could not resolve ${JSON.stringify(args.path)}${importedFrom}: ${errorMessage(error)}`,
						error
					);
				}
			});

			build.onLoad({ filter: /\.rs$/, namespace }, async (args) => {
				let artifact: RustArtifact;
				try {
					// Resolve the real source before compiling so an in-root symlink is
					// accepted consistently while a symlink escape is still rejected.
					const sourcePath = await resolveRustSource(args.path, '', allowedRoot);
					artifact = await compileOnce(sourcePath, compileOptions);
					validateRustArtifact(artifact, sourcePath);
				} catch (error) {
					throw withCause(
						`rust-imports: failed to prepare ${args.path}: ${errorMessage(error)}. ` +
							'Ensure Cargo is available, or run the rust-imports build preparation step before starting Bun.',
						error
					);
				}

				let nativeExports: unknown;
				try {
					nativeExports = nativeRequire(artifact.nodePath);
					return {
						exports: shapeNativeExports(nativeExports),
						loader: 'object'
					};
				} catch (error) {
					throw withCause(
						`rust-imports: compiled ${args.path}, but could not load ${artifact.nodePath} ` +
							`for ${process.platform}-${process.arch}: ${errorMessage(error)}. ` +
							'Rebuild the native artifact for this runtime and architecture.',
						error
					);
				}
			});
		}
	};
}

/** True only for the relative or absolute filesystem imports owned by this plugin. */
export function isRustFileSpecifier(specifier: string): boolean {
	return (
		extname(specifier) === '.rs' &&
		(isAbsolute(specifier) ||
			specifier.startsWith('./') ||
			specifier.startsWith('../') ||
			specifier.startsWith('.\\') ||
			specifier.startsWith('..\\'))
	);
}

/** Resolve and lexically constrain a Rust import without touching the filesystem. */
export function resolveRustImportPath(
	specifier: string,
	resolveDir: string,
	rootDir: string = defaultRustRoot
): string {
	if (!specifier) throw new Error('the Rust import specifier is empty');
	if (specifier.includes('\0')) throw new Error('the Rust import specifier contains a NUL byte');
	if (extname(specifier) !== '.rs') {
		throw new Error(`expected a .rs source import, received ${JSON.stringify(specifier)}`);
	}
	if (!isRustFileSpecifier(specifier)) {
		throw new Error(
			`Rust imports must be relative (./ or ../) or absolute; received ${JSON.stringify(specifier)}`
		);
	}
	if (!isAbsolute(specifier) && !resolveDir) {
		throw new Error(`cannot resolve ${JSON.stringify(specifier)} without an importer directory`);
	}

	const sourcePath = resolve(isAbsolute(specifier) ? specifier : resolveDir, isAbsolute(specifier) ? '' : specifier);
	return assertPathInsideRoot(sourcePath, rootDir);
}

/** Return an absolute path or throw when it escapes the configured source root. */
export function assertPathInsideRoot(sourcePath: string, rootDir: string): string {
	const absoluteRoot = resolve(rootDir);
	const absoluteSource = resolve(sourcePath);
	const fromRoot = relative(absoluteRoot, absoluteSource);
	if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new Error(
			`Rust source ${absoluteSource} is outside the allowed root ${absoluteRoot}; ` +
				'choose a rootDir that explicitly contains the source'
		);
	}
	return absoluteSource;
}

/**
 * Resolve a source and verify its real path too, preventing symlink escapes from
 * the configured source root.
 */
export async function resolveRustSource(
	specifier: string,
	resolveDir: string,
	rootDir: string = defaultRustRoot
): Promise<string> {
	const sourcePath = resolveRustImportPath(specifier, resolveDir, rootDir);
	let canonicalRoot: string;
	let canonicalSource: string;

	try {
		canonicalRoot = await realpath(resolve(rootDir));
	} catch (error) {
		throw withCause(`configured rootDir does not exist or cannot be read: ${resolve(rootDir)}`, error);
	}
	try {
		canonicalSource = await realpath(sourcePath);
	} catch (error) {
		throw withCause(`Rust source does not exist or cannot be read: ${sourcePath}`, error);
	}

	assertPathInsideRoot(canonicalSource, canonicalRoot);
	const sourceStat = await stat(canonicalSource);
	if (!sourceStat.isFile()) throw new Error(`Rust source is not a file: ${canonicalSource}`);
	return canonicalSource;
}

/** Only expose names Bun can safely materialize as named ESM exports. */
export function isValidJavaScriptIdentifier(name: string): boolean {
	return /^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u.test(name);
}

/**
 * Shape CommonJS/N-API exports for Bun's object loader. The complete addon is
 * always available as the default export; safe enumerable string keys are also
 * exposed as named exports.
 */
export function shapeNativeExports(nativeExports: unknown): Record<string, unknown> {
	if (
		nativeExports === null ||
		(typeof nativeExports !== 'object' && typeof nativeExports !== 'function')
	) {
		throw new Error(
			`rust-imports: native addon returned ${nativeExports === null ? 'null' : typeof nativeExports}; ` +
				'expected an object or function export'
		);
	}

	const result: Record<string, unknown> = { default: nativeExports };
	for (const name of Object.keys(nativeExports)) {
		if (name === 'default' || !isValidJavaScriptIdentifier(name)) continue;
		// defineProperty avoids the special __proto__ setter on ordinary objects.
		Object.defineProperty(result, name, {
			configurable: true,
			enumerable: true,
			value: Reflect.get(nativeExports, name),
			writable: true
		});
	}
	return result;
}

/** Validate the compiler/runtime handoff before requiring native code. */
export function validateRustArtifact(
	artifact: RustArtifact,
	expectedSource: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch
): void {
	if (resolve(artifact.sourcePath) !== resolve(expectedSource)) {
		throw new Error(
			`compiler returned an artifact for ${artifact.sourcePath}, expected ${resolve(expectedSource)}`
		);
	}
	if (!isAbsolute(artifact.nodePath) || extname(artifact.nodePath) !== '.node') {
		throw new Error(`compiler returned an invalid native artifact path: ${artifact.nodePath}`);
	}
	if (artifact.platform !== platform || artifact.arch !== arch) {
		throw new Error(
			`native artifact targets ${artifact.platform}-${artifact.arch}, but the runtime is ${platform}-${arch}`
		);
	}
}

async function compileOnce(
	sourcePath: string,
	options: CompileRustOptions
): Promise<RustArtifact> {
	const key = compilationKey(sourcePath, options);
	const existing = pendingCompilations.get(key);
	if (existing) return existing;

	const pending = compileRustModule(sourcePath, options);
	pendingCompilations.set(key, pending);
	try {
		return await pending;
	} finally {
		if (pendingCompilations.get(key) === pending) pendingCompilations.delete(key);
	}
}

function compilationKey(sourcePath: string, options: CompileRustOptions): string {
	const env = Object.entries(options.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
	return JSON.stringify([
		resolve(sourcePath),
		resolve(options.allowedRoot),
		options.cacheDir ? resolve(options.cacheDir) : null,
		options.release ?? null,
		options.force ?? null,
		options.cargo ?? null,
		env
	]);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withCause(message: string, cause: unknown): Error {
	return new Error(message, { cause });
}
