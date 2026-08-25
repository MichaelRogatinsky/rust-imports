export type CompileRustOptions = {
	/** The directory Rust imports are allowed to resolve from. */
	allowedRoot: string;
	/**
	 * Artifact and Cargo cache directory. Relative paths are resolved from
	 * `allowedRoot`. Defaults to `<allowedRoot>/.rust-imports`.
	 */
	cacheDir?: string;
	/** Build Cargo's release profile instead of its debug profile. */
	release?: boolean;
	/** Re-run Cargo even when a verified, content-addressed artifact exists. */
	force?: boolean;
	/** Cargo executable to invoke. Defaults to `cargo`. */
	cargo?: string;
	/** Extra environment variables for Cargo. */
	env?: Readonly<Record<string, string | undefined>>;
};

export type RustArtifact = {
	/** Absolute path to the imported Rust source file. */
	sourcePath: string;
	/** SHA-256 of the source inputs and native build configuration. */
	fingerprint: string;
	/** Host platform the addon was compiled for. */
	platform: NodeJS.Platform;
	/** Host architecture the addon was compiled for. */
	arch: NodeJS.Architecture;
	/** Absolute path to the content-addressed native addon. */
	nodePath: string;
	/** Absolute path to the generated ESM proxy. */
	proxyPath: string;
	/** Absolute path to the source-adjacent `*.d.rs.ts` declaration. */
	declarationPath: string;
	/** Actual enumerable top-level names reported by the loaded addon. */
	exports: string[];
};
