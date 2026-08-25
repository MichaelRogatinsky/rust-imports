#!/usr/bin/env bun

import { resolve } from 'node:path';
import { prepareRustImports, type RustImportRewriteMode } from './build';

type CliOptions = {
	entrypoints: string[];
	rootDir: string;
	cacheDir?: string;
	release?: boolean;
	force: boolean;
	rewrite: RustImportRewriteMode;
	allowSourceMutation: boolean;
};

const options = parseArguments(process.argv.slice(2));
if (options.rewrite === 'in-place' && process.env.VERCEL !== '1' && !options.allowSourceMutation) {
	throw new Error(
		'rust-imports: in-place rewriting is intended for a disposable build checkout. ' +
			'Run on Vercel or pass --allow-source-mutation explicitly.'
	);
}

const result = await prepareRustImports({
	cacheDir: options.cacheDir,
	entrypoints: options.entrypoints,
	force: options.force,
	release: options.release,
	rewrite: options.rewrite,
	rootDir: options.rootDir
});

for (const artifact of result.artifacts) {
	console.log(
		`rust-imports: ${artifact.sourcePath} -> ${artifact.nodePath} (${artifact.platform}-${artifact.arch})`
	);
}
console.log(
	`rust-imports: prepared ${result.artifacts.length} native module(s) across ` +
		`${result.files.length} source file(s); rewrote ${result.rewrittenFiles.length}`
);

function parseArguments(args: string[]): CliOptions {
	const apiRoot = resolve(process.cwd());
	const parsed: CliOptions = {
		allowSourceMutation: false,
		entrypoints: [],
		force: false,
		rewrite: 'none',
		rootDir: apiRoot
	};

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--help' || argument === '-h') {
			printHelp();
			process.exit(0);
		}
		if (argument === '--release') {
			parsed.release = true;
			continue;
		}
		if (argument === '--debug') {
			parsed.release = false;
			continue;
		}
		if (argument === '--force') {
			parsed.force = true;
			continue;
		}
		if (argument === '--allow-source-mutation') {
			parsed.allowSourceMutation = true;
			continue;
		}

		const [flag, inlineValue] = splitArgument(argument);
		if (flag === '--entrypoint') {
			parsed.entrypoints.push(requiredValue(flag, inlineValue, args, () => args[++index]));
			continue;
		}
		if (flag === '--root') {
			parsed.rootDir = resolve(requiredValue(flag, inlineValue, args, () => args[++index]));
			continue;
		}
		if (flag === '--cache-dir') {
			parsed.cacheDir = requiredValue(flag, inlineValue, args, () => args[++index]);
			continue;
		}
		if (flag === '--rewrite') {
			const value = requiredValue(flag, inlineValue, args, () => args[++index]);
			if (value !== 'none' && value !== 'in-place') {
				throw new Error(`rust-imports: --rewrite must be none or in-place, received ${value}`);
			}
			parsed.rewrite = value;
			continue;
		}
		throw new Error(`rust-imports: unknown argument ${argument}. Run with --help for usage.`);
	}

	if (parsed.entrypoints.length === 0) {
		throw new Error('rust-imports: at least one --entrypoint is required');
	}
	return parsed;
}

function splitArgument(argument: string): [string, string | undefined] {
	const equals = argument.indexOf('=');
	return equals === -1
		? [argument, undefined]
		: [argument.slice(0, equals), argument.slice(equals + 1)];
}

function requiredValue(
	flag: string,
	inlineValue: string | undefined,
	_args: string[],
	next: () => string | undefined
): string {
	const value = inlineValue ?? next();
	if (!value || value.startsWith('--')) throw new Error(`rust-imports: ${flag} requires a value`);
	return value;
}

function printHelp(): void {
	console.log(`Usage: rust-imports --entrypoint <file> [options]

Options:
  --entrypoint <file>       Repeatable entrypoint relative to --root
  --root <directory>        Source boundary (defaults to the current directory)
  --cache-dir <directory>   Artifact cache (defaults to <root>/.rust-imports)
  --release | --debug       Select the Cargo profile
  --force                   Ignore a valid cached artifact
  --rewrite none|in-place   Rewrite imports for a plugin-unaware bundler
  --allow-source-mutation   Permit in-place rewriting outside Vercel
`);
}
