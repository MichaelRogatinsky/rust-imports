import { rustImportsPlugin } from './runtime';

const registrationKey = Symbol.for('@drillbooks/rust-imports/register');
const registrations = globalThis as typeof globalThis & { [key: symbol]: unknown };

if (registrations[registrationKey] !== true) {
	Bun.plugin(rustImportsPlugin());
	registrations[registrationKey] = true;
}

export {};
