import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LoginState {
  userId: string;
  stateToken: string;
  factorId: string;
  otpFactorType?: string;
  timestamp: number;
}

const IEC_TOKENS_DIR = (() => {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
  return join(homeDir, '.homebridge', 'iec-tokens');
})();

/**
 * Path to the file that stores the currently logged-in user (no config needed).
 */
export function getCurrentUserIdPath(): string {
  return join(IEC_TOKENS_DIR, 'current-user.json');
}

/**
 * Read the currently logged-in user ID, or null if none.
 */
export function readCurrentUserId(): string | null {
  try {
    const path = getCurrentUserIdPath();
    if (!existsSync(path)) {
      return null;
    }
    const data = readFileSync(path, 'utf-8');
    const obj = JSON.parse(data) as { userId?: string };
    const id = obj.userId && String(obj.userId).trim();
    return id && id.length === 9 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Save the currently logged-in user (called from Config UI after login).
 */
export function saveCurrentUserId(userId: string): void {
  try {
    if (!existsSync(IEC_TOKENS_DIR)) {
      mkdirSync(IEC_TOKENS_DIR, { recursive: true });
    }
    writeFileSync(getCurrentUserIdPath(), JSON.stringify({ userId }, null, 2), 'utf-8');
  } catch {
    // Ignore
  }
}

/**
 * Clear the current user file (e.g. when resetting login from Config UI).
 */
export function deleteCurrentUserId(): void {
  try {
    const path = getCurrentUserIdPath();
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Ignore
  }
}

/**
 * Get the default token path for a user ID
 */
export function getDefaultTokenPath(userId: string): string {
  return join(IEC_TOKENS_DIR, `${userId}.json`);
}

/**
 * Get the login state file path for a user ID
 */
export function getLoginStatePath(userId: string): string {
  return join(IEC_TOKENS_DIR, `${userId}.login-state.json`);
}

/**
 * Load login state from file
 */
export function loadLoginState(userId: string): LoginState | null {
  try {
    const statePath = getLoginStatePath(userId);
    if (!existsSync(statePath)) {
      return null;
    }
    const data = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(data) as LoginState;
    if (Date.now() - state.timestamp > 10 * 60 * 1000) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * Save login state to file
 */
export function saveLoginState(state: LoginState): void {
  try {
    const statePath = getLoginStatePath(state.userId);
    const dir = join(statePath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Ignore
  }
}

/**
 * Delete login state file
 */
export function deleteLoginState(userId: string): void {
  try {
    const statePath = getLoginStatePath(userId);
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }
  } catch {
    // Ignore
  }
}

/**
 * Delete token file for a user (e.g. when resetting login from Config UI)
 */
export function deleteToken(userId: string): void {
  try {
    const tokenPath = getDefaultTokenPath(userId);
    if (existsSync(tokenPath)) {
      unlinkSync(tokenPath);
    }
  } catch {
    // Ignore
  }
}

/**
 * Check if a token file exists for the user
 */
export function hasToken(userId: string): boolean {
  return existsSync(getDefaultTokenPath(userId));
}
