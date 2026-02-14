/**
 * Custom Config UI server for IEC Electricity plugin.
 * Handles OTP request and verify so users can log in from the Config UI (like homebridge-tami4).
 * Must call ready() synchronously so the UI does not stick on "loading".
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Plugin root: directory containing dist/ and homebridge-ui/ */
function getPluginRoot() {
  const fromScript = join(__dirname, '..');
  if (existsSync(join(fromScript, 'dist', 'iec-client.js'))) return fromScript;
  const fromCwd = join(process.cwd(), 'node_modules', 'homebridge-iec-electricity');
  if (existsSync(join(fromCwd, 'dist', 'iec-client.js'))) return fromCwd;
  return fromScript;
}

function loadIecClient() {
  const path = pathToFileURL(join(getPluginRoot(), 'dist', 'iec-client.js')).href;
  return import(path);
}

function loadTokenStorage() {
  const path = pathToFileURL(join(getPluginRoot(), 'dist', 'token-storage.js')).href;
  return import(path);
}

class IecUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/status', this.status.bind(this));
    this.onRequest('/request-otp', this.requestOtp.bind(this));
    this.onRequest('/verify-otp', this.verifyOtp.bind(this));
    this.onRequest('/reset-login', this.resetLogin.bind(this));

    this.ready();
  }

  async resetLogin(body) {
    const userId = (body && body.userId && String(body.userId).trim()) || '';
    if (!userId || userId.length !== 9) {
      throw new RequestError('Invalid Israeli ID.');
    }
    const { deleteToken, deleteLoginState, deleteCurrentUserId } = await loadTokenStorage();
    deleteToken(userId);
    deleteLoginState(userId);
    deleteCurrentUserId();
    return { success: true };
  }

  async status() {
    try {
      const { hasToken, readCurrentUserId } = await loadTokenStorage();
      const userId = readCurrentUserId();
      return {
        hasToken: userId ? hasToken(userId) : false,
        userId: userId || null,
      };
    } catch (err) {
      console.error('[IEC Config UI] /status error:', err);
      return { hasToken: false, userId: null, error: String(err && err.message) };
    }
  }

  async requestOtp(body) {
    const userId = (body && body.userId && String(body.userId).trim()) || '';
    if (!userId || userId.length !== 9) {
      throw new RequestError('Please enter a valid 9-digit Israeli ID (Teudat Zehut).');
    }

    const { IecClient } = await loadIecClient();
    const { saveLoginState } = await loadTokenStorage();

    const client = new IecClient(userId);
    const otpType = await client.loginWithId();
    const state = client.getLoginState();
    if (!state.stateToken || !state.factorId) {
      throw new RequestError('Failed to get login state from IEC.');
    }
    saveLoginState({
      userId,
      stateToken: state.stateToken,
      factorId: state.factorId,
      otpFactorType: state.otpFactorType,
      timestamp: Date.now(),
    });

    return {
      success: true,
      otpType: otpType || 'phone/email',
    };
  }

  async verifyOtp(body) {
    const userId = (body && body.userId && String(body.userId).trim()) || '';
    const otpCode = (body && body.otpCode && String(body.otpCode).trim()) || '';
    if (!userId || userId.length !== 9) {
      throw new RequestError('Invalid Israeli ID.');
    }
    if (!otpCode) {
      throw new RequestError('Please enter the OTP code you received.');
    }

    const { IecClient } = await loadIecClient();
    const { loadLoginState, deleteLoginState, getDefaultTokenPath } = await loadTokenStorage();

    const loginState = loadLoginState(userId);
    if (!loginState) {
      throw new RequestError('No active login session. Please click "Send OTP" first (the code expires in 10 minutes).');
    }

    const client = new IecClient(userId);
    client.setLoginState(loginState.stateToken, loginState.factorId);
    await client.verifyOtp(otpCode);

    const tokenPath = getDefaultTokenPath(userId);
    await client.saveTokenToFile(tokenPath);
    deleteLoginState(userId);
    const { saveCurrentUserId } = await loadTokenStorage();
    saveCurrentUserId(userId);

    return { success: true };
  }
}

try {
  new IecUiServer();
} catch (err) {
  console.error('[IEC Config UI] Server failed to start:', err);
  console.error('[IEC Config UI] If you deployed by copying files, run "npm install" in the plugin directory so @homebridge/plugin-ui-utils is installed.');
  process.exitCode = 1;
}
