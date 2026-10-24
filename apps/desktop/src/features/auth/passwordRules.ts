export const PASSWORD_HINT = "Use 8 to 1024 Unicode characters. Choose a new, non-default password different from the old one.";

/** Match Rust's character count, not JavaScript's UTF-16 code unit count. */
export function validateLockPassword(
  password: string,
  confirmation: string,
  currentPassword: string | null = null,
): string | null {
  const length = Array.from(password).length;
  if (length < 8 || length > 1024) return "Password must be 8 to 1024 Unicode characters.";
  if (password === currentPassword) return "New password must be different from the current one.";
  if (password !== confirmation) return "The new passwords don't match.";
  return null;
}
