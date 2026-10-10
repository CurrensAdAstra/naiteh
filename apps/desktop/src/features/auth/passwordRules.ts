/**
 * Client-side mirrors of the backend's account rules, so forms can say
 * what's wrong before a round trip. The backend stays authoritative and
 * its error message is shown when it disagrees.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const USERNAME_MAX_LENGTH = 32;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, and not the same as the username.`;

function checkPassword(username: string, password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (username !== "" && password === username) {
    return "Password can't be the same as the username.";
  }
  return null;
}

export interface PasswordChangeInput {
  username: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export function validatePasswordChange(input: PasswordChangeInput): string | null {
  if (input.currentPassword === "") return "Enter your current password.";
  const problem = checkPassword(input.username, input.newPassword);
  if (problem !== null) return problem;
  if (input.newPassword === input.currentPassword) {
    return "New password must be different from the current one.";
  }
  if (input.newPassword !== input.confirmPassword) {
    return "The new passwords don't match.";
  }
  return null;
}

export interface NewUserInput {
  username: string;
  password: string;
  confirmPassword: string;
}

export function validateUsername(username: string): string | null {
  if (username === "") return "Enter a username.";
  if (username.length > USERNAME_MAX_LENGTH) {
    return `Username must be at most ${USERNAME_MAX_LENGTH} characters.`;
  }
  if (!USERNAME_PATTERN.test(username)) {
    return "Username may only contain letters, digits, '.', '_' and '-'.";
  }
  return null;
}

export function validateNewUser(input: NewUserInput): string | null {
  const usernameProblem = validateUsername(input.username);
  if (usernameProblem !== null) return usernameProblem;
  const passwordProblem = checkPassword(input.username, input.password);
  if (passwordProblem !== null) return passwordProblem;
  if (input.password !== input.confirmPassword) {
    return "The passwords don't match.";
  }
  return null;
}
