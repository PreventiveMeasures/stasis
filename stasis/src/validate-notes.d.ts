// Types of `@exodus/stasis/validate-notes` (validate-notes.js), whose comments tell what each does.

export const OWN_REASONS: Readonly<Record<string, string>>
export const PACKAGE_REASONS: Readonly<Record<string, string>>
export const PATCH_ERRORS: Readonly<Record<string, string>>
export const FILE_REASONS: Readonly<Record<string, string>>
export const LOCKFILE_ERRORS: Readonly<Record<string, string>>

// A package as a report tells it, as much as its note reads.
export interface NotedPackage {
  reason?: string
  at?: string
  directory?: string
  patch?: { path?: string; from?: string; error?: string; verified?: boolean; applied?: boolean }
}
export type NotePart = string | { path: string }
export function noteOf(pkg: NotedPackage): NotePart[]
export function noteText(pkg: NotedPackage): string
