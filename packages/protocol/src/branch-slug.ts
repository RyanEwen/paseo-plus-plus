/**
 * Validate that a string is a valid git branch name slug.
 * Must be lowercase alphanumeric with hyphens and forward slashes only.
 */
export function validateBranchSlug(slug: string): {
  valid: boolean;
  error?: string;
} {
  if (!slug || slug.length === 0) {
    return { valid: false, error: "Branch name cannot be empty" };
  }

  if (slug.length > 100) {
    return { valid: false, error: "Branch name too long (max 100 characters)" };
  }

  const validPattern = /^[a-z0-9-/]+$/;
  if (!validPattern.test(slug)) {
    return {
      valid: false,
      error:
        "Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes",
    };
  }

  if (slug.startsWith("-") || slug.endsWith("-")) {
    return {
      valid: false,
      error: "Branch name cannot start or end with a hyphen",
    };
  }

  if (slug.includes("--")) {
    return { valid: false, error: "Branch name cannot have consecutive hyphens" };
  }

  return { valid: true };
}

export const MAX_SLUG_LENGTH = 50;

/**
 * Convert a string to kebab-case for branch names.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug;
  }

  const truncated = slug.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = truncated.lastIndexOf("-");
  if (lastHyphen > MAX_SLUG_LENGTH / 2) {
    return truncated.slice(0, lastHyphen);
  }
  return truncated.replace(/-+$/, "");
}

const WORKTREE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether an exactly chosen worktree folder name is kept as typed: lowercase letters and
 * digits in groups joined by single hyphens, at most MAX_SLUG_LENGTH characters. The daemon
 * and the app share this rule so the form rejects what the host would reject.
 */
export function isValidWorktreeName(value: string): boolean {
  return WORKTREE_NAME_PATTERN.test(value) && value.length <= MAX_SLUG_LENGTH;
}
