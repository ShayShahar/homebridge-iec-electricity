#!/usr/bin/env node
/**
 * IEC Login CLI Script
 * Replaces the Python iec_login.py script
 * 
 * Usage:
 *   node dist/cli/login.js --token ~/.homebridge/iec-token.json --user-id 123456789
 * 
 * Or after building:
 *   npm run login -- --token ~/.homebridge/iec-token.json --user-id 123456789
 */

import { join } from 'node:path';
import { IecClient, IECLoginError, readUserInput } from '../iec-client.js';

/**
 * Get the default token path for a user ID
 */
function getDefaultTokenPath(userId: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
  return join(homeDir, '.homebridge', 'iec-tokens', `${userId}.json`);
}

async function login(userId: string, tokenPath?: string): Promise<boolean> {
  const finalTokenPath = tokenPath || getDefaultTokenPath(userId);
  try {
    const client = new IecClient(userId);

    console.log('Sending OTP to your registered phone/email...');
    const otpType = await client.loginWithId();
    const otp = await readUserInput(`Enter the OTP code sent to ${otpType}: `);
    
    await client.verifyOtp(otp);
    await client.saveTokenToFile(finalTokenPath);

    console.log(`\n✅ Login successful! Token saved to ${finalTokenPath}`);
    console.log('You can now restart Homebridge to start using the plugin.\n');
    return true;
  } catch (error) {
    if (error instanceof IECLoginError) {
      console.error(`Login failed: ${error.message}`);
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  let tokenPath: string | undefined;
  let userId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && i + 1 < args.length) {
      tokenPath = args[i + 1];
      i++;
    } else if (args[i] === '--user-id' && i + 1 < args.length) {
      userId = args[i + 1];
      i++;
    }
  }

  if (!userId) {
    console.error('Usage: node login.js --user-id <id> [--token <path>]');
    console.error('Example: node login.js --user-id 123456789');
    console.error('        node login.js --user-id 123456789 --token ~/.custom/path.json');
    console.error('\nIf --token is not provided, token will be saved to:');
    console.error('  ~/.homebridge/iec-tokens/<user-id>.json');
    process.exit(1);
  }

  login(userId, tokenPath)
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unexpected error:', error);
      process.exit(1);
    });
}

// Run if this file is executed directly
// Check if this module is being run directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.includes('login.js') ||
  process.argv[1]?.includes('login.ts');

if (isMainModule) {
  main();
}
