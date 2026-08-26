import { rustImportsPlugin } from './runtime';
const registrationKey = Symbol.for('rust-imports/register');
const registrations = globalThis;
if (registrations[registrationKey] !== true) {
    Bun.plugin(rustImportsPlugin());
    registrations[registrationKey] = true;
}
export {};
