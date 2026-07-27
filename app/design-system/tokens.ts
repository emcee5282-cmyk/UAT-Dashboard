// Barrel — re-exports every design token so a consumer can do
// `import { X } from '@/app/design-system/tokens'` without needing to know
// which specific file X lives in. Each token's own file remains the
// authoritative source; this is purely a convenience re-export.
export * from './shadows';
export * from './table';
export * from './spacing';
export * from './transitions';
