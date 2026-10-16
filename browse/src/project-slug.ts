/**
 * Project slug resolution for the browse daemon.
 *
 * Used by domain-skills (per-project storage) and sidebar prompt-context
 * injection. Cached after first call — slug is derived from the daemon's
 * git remote (or env override) and doesn't change between commands.
 */

import { resolveSlug, artifactHelperPath } from '../../lib/bin-context';
import { claimAdmittedArtifactProject } from "../../lib/artifact-window";
import { resolveStateRoot } from '../../lib/state-root';
let cachedSlug: string | null = null;
export function getCurrentProjectSlug(): string {
  // Cache is identity data, never permission to skip a fresh mutation guard.
  const slug = cachedSlug ?? resolveSlug(artifactHelperPath('gstack-slug'));
  claimAdmittedArtifactProject(resolveStateRoot(), slug);
  cachedSlug = slug;
  return slug;
}

/** Reset cache; for tests only. */
export function _resetProjectSlugCache(): void {
  cachedSlug = null;
}
