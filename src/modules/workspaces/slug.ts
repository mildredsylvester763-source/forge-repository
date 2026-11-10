/**
 * Slug generation utilities for workspaces (CO-015)
 * Fixes: slug generation for non-ASCII names (strip accents first)
 */

import { RESERVED_SLUGS } from './types.ts';

/**
 * Remove accents/diacritics from a string
 */
function stripAccents(str: string): string {
  return str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * Generate a slug from a name
 * - Strips accents first (fix for Nigerian names like "Ọlá")
 * - Converts to lowercase
 * - Replaces spaces and special characters with hyphens
 * - Removes leading/trailing hyphens
 */
export function generateSlug(name: string): string {
  // Strip accents first
  let slug = stripAccents(name);
  
  // Convert to lowercase and replace non-alphanumeric characters with hyphens
  slug = slug
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // If slug is empty after processing, generate a random one
  if (!slug || slug.length === 0) {
    slug = 'workspace';
  }

  return slug;
}

/**
 * Validate a slug
 * - Must be lowercase
 * - Must contain only alphanumeric characters and hyphens
 * - Must not be a reserved slug
 * - Must be between 1 and 64 characters
 */
export function validateSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || slug.length < 1 || slug.length > 64) {
    return { valid: false, error: 'Slug must be between 1 and 64 characters.' };
  }

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return { valid: false, error: 'Slug must contain only lowercase letters, numbers, and hyphens.' };
  }

  if (RESERVED_SLUGS.has(slug)) {
    return { valid: false, error: 'Slug is reserved and cannot be used.' };
  }

  return { valid: true };
}

/**
 * Generate a unique slug by appending a number if the slug is taken
 */
export function generateUniqueSlug(name: string, existingSlugs: Set<string>): string {
  let slug = generateSlug(name);
  let counter = 1;

  while (existingSlugs.has(slug)) {
    slug = `${generateSlug(name)}-${counter}`;
    counter++;
  }

  return slug;
}
