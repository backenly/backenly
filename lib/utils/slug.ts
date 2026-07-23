/**
 * Slug generation utilities
 */

/**
 * Generate a URL-safe slug from a project name
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Generate a unique slug by appending a number if needed
 */
export async function generateUniqueSlug(
  name: string,
  checkExists: (slug: string) => Promise<boolean>
): Promise<string> {
  let slug = generateSlug(name);
  let counter = 1;

  while (await checkExists(slug)) {
    slug = `${generateSlug(name)}-${counter}`;
    counter++;
  }

  return slug;
}
