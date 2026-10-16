/**
 * Project slug resolution for the browse daemon.
 *
 * Used by domain-skills (per-project storage) and sidebar prompt-context
 * injection. Cached after first call — slug is derived from the daemon's
 * git remote (or env override) and doesn't change between commands.
 */

import * as path from 'path';
import { resolveSlug, claimArtifactProject } from '../../lib/bin-context';
import { resolveStateRoot } from '../../lib/state-root';
let cachedSlug: string | null = null;
export function getCurrentProjectSlug(): string {
  // Cache is identity data, never permission to skip a fresh mutation guard.
  const slug = cachedSlug ?? resolveSlug(path.join(import.meta.dir, '../../bin/gstack-slug'));
  claimArtifactProject(resolveStateRoot(), slug);
  cachedSlug = slug;
  return slug;
}

/** Reset cache; for tests only. */
export function _resetProjectSlugCache(): void {
  cachedSlug = null;
}
