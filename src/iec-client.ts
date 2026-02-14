/**
 * IEC API Client for TypeScript
 * Ported from py-iec-api Python library
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

// Constants from py-iec-api
const APP_CLIENT_ID = process.env.IEC_CLIENT_ID || '0oaqf6zr7yEcQZqqt2p7';
const CODE_CHALLENGE_METHOD = 'S256';
const APP_REDIRECT_URI = process.env.IEC_REDIRECT_URI || 'com.iecrn:/';
const IEC_OKTA_BASE_URL = process.env.IEC_OKTA_BASE_URL || 'https://iec-ext.okta.com';
const JWKS_URL = `${IEC_OKTA_BASE_URL}/oauth2/default/v1/keys`;

// IEC API base URL (must match py-iec-api: https://iecapi.iec.co.il/api/)
const IEC_API_BASE_URL = 'https://iecapi.iec.co.il/api/';

// IEC API endpoints (from py-iec-api const.py)
const GET_CONSUMER_URL = `${IEC_API_BASE_URL}customer`;
const GET_CONTRACTS_URL = `${IEC_API_BASE_URL}customer/contract/{bp_number}`;
const GET_LAST_METER_READING_URL = `${IEC_API_BASE_URL}Device/LastMeterReading/{contract_id}/{bp_number}`;
const GET_REMOTE_READING_URL = `${IEC_API_BASE_URL}Consumption/RemoteReadingRange/{contract_id}`;

// Headers required by IEC API (from py-iec-api const.py HEADERS_WITH_AUTH)
function getIecApiHeaders(idToken: string): Record<string, string> {
  return {
    'authority': 'iecapi.iec.co.il',
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en,he;q=0.9',
    'authorization': `Bearer ${idToken}`,
    'origin': 'https://www.iec.co.il',
    'referer': 'https://www.iec.co.il/',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'x-iec-idt': '1',
    'x-iec-webview': '1',
  };
}

export interface JWT {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  id_token: string;
}

/** API returns camelCase; we accept both for compatibility */
export interface Customer {
  bp_number?: string;
  bpNumber?: string;
  first_name?: string;
  firstName?: string;
  last_name?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  mobilePhone?: string;
}

/** API may return camelCase */
export interface Contract {
  contract_id?: string;
  contractId?: string;
  contract_number?: string;
  contractNumber?: string;
  address?: string;
}

export interface MeterReading {
  reading?: number;
  reading_date?: string;
  readingDate?: string;
}

export interface MeterReadings {
  data?: {
    lastMeters?: Array<{ meterReadings?: MeterReading[] }>;
  };
  last_meters?: Array<{ meter_readings?: MeterReading[] }>;
  lastMeters?: Array<{ meterReadings?: MeterReading[] }>;
}

export interface IecReading {
  lastMeterReading: number;
  currentMonthUsage?: number;
  readingDate?: string;
  contractId?: string;
  bpNumber?: string;
  error?: string;
}

export class IECError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'IECError';
  }
}

export class IECLoginError extends IECError {
  constructor(code: number, message: string) {
    super(code, message);
    this.name = 'IECLoginError';
  }
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge: hash };
}

/**
 * Generate random state string
 */
function generateState(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * Validate Israeli ID (Teudat Zehut)
 */
function isValidIsraeliId(id: string | number): boolean {
  const idStr = String(id);
  if (!/^\d{9}$/.test(idStr)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = Number.parseInt(idStr[i], 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }

  return sum % 10 === 0;
}

/**
 * IEC API Client
 */
export interface IecClientOptions {
  /** When true, log full JSON from each API call (for discovering fields for new sensors) */
  logApiData?: boolean;
}

export class IecClient {
  private stateToken?: string;
  private factorId?: string;
  private sessionToken?: string;
  private otpFactorType?: string;
  private token?: JWT;
  public loggedIn = false;
  private bpNumber?: string;
  private contractId?: string;
  private logApiData: boolean;

  constructor(private userId: string, options?: IecClientOptions) {
    if (!isValidIsraeliId(userId)) {
      throw new Error('User ID must be a valid Israeli ID');
    }
    this.logApiData = options?.logApiData ?? false;
  }

  /** Log full API response when logApiData is enabled (for development / new sensors) */
  private logApiResponse(apiName: string, data: unknown): void {
    if (!this.logApiData) return;
    const json = JSON.stringify(data, null, 2);
    console.log(`\n[IEC API] ---------- ${apiName} (full response) ----------\n${json}\n[IEC API] ---------- end ${apiName} ----------\n`);
  }

  /**
   * Get login state for OTP verification
   */
  getLoginState(): { stateToken?: string; factorId?: string; otpFactorType?: string } {
    return {
      stateToken: this.stateToken,
      factorId: this.factorId,
      otpFactorType: this.otpFactorType,
    };
  }

  /**
   * Set login state (for restoring from saved state)
   */
  setLoginState(stateToken: string, factorId: string): void {
    this.stateToken = stateToken;
    this.factorId = factorId;
  }

  /**
   * First login step - send OTP
   */
  async loginWithId(): Promise<string> {
    try {
      console.log(`[IEC Client] Starting login for user: ${this.userId}`);
      console.log(`[IEC Client] Step 1: Requesting authentication from ${IEC_OKTA_BASE_URL}/api/v1/authn`);
      
      // Get first factor ID
      const authnUrl = `${IEC_OKTA_BASE_URL}/api/v1/authn`;
      const authnBody = JSON.stringify({
        username: `${this.userId}@iec.co.il`,
      });
      console.log(`[IEC Client] Request body: ${authnBody}`);

      const response = await fetch(authnUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: authnBody,
      });

      console.log(`[IEC Client] Authn response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[IEC Client] Authn failed. Response: ${errorText.substring(0, 500)}`);
        throw new IECLoginError(response.status, `Failed to initiate login: ${response.statusText}. Response: ${errorText.substring(0, 200)}`);
      }

      const responseText = await response.text();
      console.log(`[IEC Client] Authn response body: ${responseText.substring(0, 500)}`);
      
      const data = JSON.parse(responseText) as {
        stateToken?: string;
        _embedded?: { factors?: Array<{ id?: string; factorType?: string }> };
        status?: string;
      };
      
      console.log(`[IEC Client] Parsed authn data - status: ${data.status}, has stateToken: ${!!data.stateToken}`);
      console.log(`[IEC Client] Factors count: ${data._embedded?.factors?.length || 0}`);
      
      this.stateToken = data.stateToken;
      const factors = data._embedded?.factors;
      if (!factors || factors.length === 0) {
        console.error(`[IEC Client] No factors found in response`);
        throw new IECLoginError(-1, 'No authentication factors found');
      }
      
      this.factorId = factors[0].id;
      const factorType = factors[0].factorType;
      console.log(`[IEC Client] Selected factor ID: ${this.factorId}, type: ${factorType}`);

      // Send OTP code (without passCode to trigger OTP sending)
      const verifyUrl = `${IEC_OKTA_BASE_URL}/api/v1/authn/factors/${this.factorId}/verify`;
      const verifyBody = JSON.stringify({
        stateToken: this.stateToken,
      });
      console.log(`[IEC Client] Step 2: Sending OTP request to ${verifyUrl}`);
      console.log(`[IEC Client] Verify request body: ${verifyBody}`);
      console.log(`[IEC Client] This should trigger OTP to be sent to user's registered device`);

      const otpResponse = await fetch(verifyUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: verifyBody,
      });

      console.log(`[IEC Client] OTP response status: ${otpResponse.status} ${otpResponse.statusText}`);
      console.log(`[IEC Client] OTP response headers:`, JSON.stringify(Object.fromEntries(otpResponse.headers.entries())));

      const otpResponseText = await otpResponse.text();
      console.log(`[IEC Client] OTP response body (full): ${otpResponseText}`);

      if (!otpResponse.ok) {
        console.error(`[IEC Client] OTP send failed. Status: ${otpResponse.status}, Response: ${otpResponseText.substring(0, 1000)}`);
        throw new IECLoginError(otpResponse.status, `Failed to send OTP: ${otpResponse.statusText}. Response: ${otpResponseText.substring(0, 500)}`);
      }

      let otpData: {
        sessionToken?: string;
        status?: string;
        _embedded?: { factor?: { factorType?: string; profile?: { phoneNumber?: string; email?: string } } };
        stateToken?: string;
      };
      
      try {
        otpData = JSON.parse(otpResponseText);
      } catch (parseError) {
        console.error(`[IEC Client] Failed to parse OTP response as JSON: ${parseError}`);
        throw new IECLoginError(-1, `Invalid response from OTP endpoint: ${otpResponseText.substring(0, 200)}`);
      }
      
      console.log(`[IEC Client] Parsed OTP data:`, JSON.stringify(otpData, null, 2));
      console.log(`[IEC Client] OTP response status: ${otpData.status}`);
      console.log(`[IEC Client] Has sessionToken: ${!!otpData.sessionToken}`);
      console.log(`[IEC Client] Factor type: ${otpData._embedded?.factor?.factorType}`);
      console.log(`[IEC Client] Factor profile:`, JSON.stringify(otpData._embedded?.factor?.profile));
      
      // Check if status indicates OTP was sent
      if (otpData.status === 'MFA_CHALLENGE' || otpData.status === 'SUCCESS') {
        console.log(`[IEC Client] ✅ OTP request successful! Status: ${otpData.status}`);
        this.sessionToken = otpData.sessionToken;
        this.otpFactorType = otpData._embedded?.factor?.factorType || factorType;
        
        const contactInfo = otpData._embedded?.factor?.profile?.phoneNumber || 
                           otpData._embedded?.factor?.profile?.email || 
                           'your registered device';
        
        console.log(`[IEC Client] OTP should be sent to: ${contactInfo} (type: ${this.otpFactorType})`);
      } else {
        console.warn(`[IEC Client] ⚠️ Unexpected status: ${otpData.status}. OTP may not have been sent.`);
        // Still try to proceed if we have a sessionToken
        this.sessionToken = otpData.sessionToken;
        this.otpFactorType = otpData._embedded?.factor?.factorType || factorType || 'unknown';
      }

      if (!this.otpFactorType || this.otpFactorType === 'unknown') {
        console.warn(`[IEC Client] Warning: Could not determine OTP delivery method`);
      }

      console.log(`[IEC Client] Login initiation completed. OTP factor type: ${this.otpFactorType}`);
      return this.otpFactorType || 'unknown';
    } catch (error) {
      if (error instanceof IECLoginError) {
        throw error;
      }
      throw new IECLoginError(-1, `Failed at first login: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Verify OTP code and get JWT token
   */
  async verifyOtp(otpCode: string): Promise<void> {
    console.log(`[IEC Client] Starting OTP verification...`);
    console.log(`[IEC Client] Factor ID: ${this.factorId}, State Token: ${this.stateToken ? 'present' : 'missing'}`);
    console.log(`[IEC Client] OTP code length: ${otpCode.length}, value: ${otpCode.replace(/./g, '*')}`);
    
    if (!this.factorId || !this.stateToken) {
      console.error(`[IEC Client] ERROR: Missing factorId or stateToken!`);
      throw new IECLoginError(-1, "OTP wasn't sent during login");
    }

    try {
      // Verify OTP
      const verifyUrl = `${IEC_OKTA_BASE_URL}/api/v1/authn/factors/${this.factorId}/verify`;
      const verifyBody = JSON.stringify({
        stateToken: this.stateToken,
        passCode: String(otpCode),
      });
      
      console.log(`[IEC Client] Verifying OTP at: ${verifyUrl}`);
      console.log(`[IEC Client] Verify request body: ${verifyBody.replace(/passCode":"[^"]+/, 'passCode":"***')}`);
      
      const verifyResponse = await fetch(verifyUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: verifyBody,
      });
      
      console.log(`[IEC Client] Verify response status: ${verifyResponse.status} ${verifyResponse.statusText}`);

      if (!verifyResponse.ok) {
        const errorText = await verifyResponse.text().catch(() => '');
        throw new IECLoginError(
          verifyResponse.status,
          `OTP verification HTTP error: ${verifyResponse.statusText}. Response: ${errorText.substring(0, 300)}`,
        );
      }

      let verifyData: {
        sessionToken?: string;
        status?: string;
        _embedded?: { factor?: { factorType?: string } };
        errorSummary?: string;
        errorCauses?: Array<{ errorSummary?: string }>;
      };

      try {
        verifyData = (await verifyResponse.json()) as typeof verifyData;
      } catch (parseError) {
        const responseText = await verifyResponse.text();
        throw new IECLoginError(
          -1,
          `Failed to parse OTP verification response: ${parseError instanceof Error ? parseError.message : String(parseError)}. Response: ${responseText.substring(0, 300)}`,
        );
      }

      // Check response status
      if (verifyData.status && verifyData.status !== 'SUCCESS' && verifyData.status !== 'MFA_CHALLENGE') {
        const errorSummary = verifyData.errorSummary || '';
        const errorCauses = verifyData.errorCauses?.map((c) => c.errorSummary).join(', ') || '';
        throw new IECLoginError(
          -1,
          `OTP verification failed: status ${verifyData.status}. ${errorSummary} ${errorCauses}`.trim(),
        );
      }

      const otpSessionToken = verifyData.sessionToken;

      if (!otpSessionToken) {
        const errorDetail = verifyData.status ? ` (status: ${verifyData.status})` : '';
        throw new IECLoginError(-1, `OTP verification failed: no session token${errorDetail}`);
      }

      // Authorize session
      const { codeVerifier, codeChallenge } = generatePKCEPair();
      const state = generateState();

      const authorizeUrl = `${IEC_OKTA_BASE_URL}/oauth2/default/v1/authorize?` +
        `client_id=${APP_CLIENT_ID}&` +
        `response_type=id_token+code&` +
        `response_mode=form_post&` +
        `scope=openid%20email%20profile%20offline_access&` +
        `redirect_uri=${encodeURIComponent(APP_REDIRECT_URI)}&` +
        `state=${state}&` +
        `nonce=abc123&` +
        `code_challenge_method=${CODE_CHALLENGE_METHOD}&` +
        `sessionToken=${otpSessionToken}&` +
        `code_challenge=${codeChallenge}`;

      const authorizeResponse = await fetch(authorizeUrl, {
        method: 'GET',
        redirect: 'manual',
      });

      // Check response status
      if (authorizeResponse.status !== 200 && authorizeResponse.status !== 302) {
        const errorText = await authorizeResponse.text().catch(() => '');
        throw new IECLoginError(
          authorizeResponse.status,
          `Authorization failed: ${authorizeResponse.statusText}. Response: ${errorText.substring(0, 200)}`,
        );
      }

      // Extract code from response body
      // The response is form_post, so we need to parse the HTML form
      const responseText = await authorizeResponse.text();
      
      // Try multiple patterns to extract the code
      let codeMatch = responseText.match(/name="code"\s+value="([^"]+)"/);
      if (!codeMatch) {
        codeMatch = responseText.match(/name=['"]code['"]\s+value=['"]([^'"]+)['"]/);
      }
      if (!codeMatch) {
        codeMatch = responseText.match(/<input[^>]*name=['"]code['"][^>]*value=['"]([^'"]+)['"]/i);
      }
      
      if (!codeMatch) {
        // Log first 500 chars of response for debugging
        const debugText = responseText.substring(0, 500);
        throw new IECLoginError(
          -1,
          `Failed to extract authorization code from response. Response preview: ${debugText}`,
        );
      }
      const code = codeMatch[1];

      // Get access token
      const tokenResponse = await fetch(`${IEC_OKTA_BASE_URL}/oauth2/default/v1/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: APP_CLIENT_ID,
          code_verifier: codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: APP_REDIRECT_URI,
          code: code,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text().catch(() => '');
        throw new IECLoginError(
          tokenResponse.status,
          `Failed to get access token: ${tokenResponse.statusText}. Response: ${errorText.substring(0, 200)}`,
        );
      }

      const tokenData = (await tokenResponse.json()) as JWT;
      if (!tokenData.access_token || !tokenData.id_token) {
        throw new IECLoginError(-1, 'Invalid token response: missing access_token or id_token');
      }
      this.token = tokenData;
      this.loggedIn = true;
    } catch (error) {
      if (error instanceof IECLoginError) {
        throw error;
      }
      throw new IECLoginError(-1, `Failed at OTP verification: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check token validity and refresh if needed
   */
  async checkToken(): Promise<boolean> {
    if (!this.token) {
      throw new IECLoginError(-1, 'No token available');
    }

    try {
      // Decode JWT to check expiration (without verification for now)
      const parts = this.token.id_token.split('.');
      if (parts.length !== 3) {
        console.error(`[IEC Client] Invalid token format: expected 3 parts, got ${parts.length}`);
        throw new IECLoginError(-1, 'Invalid token format');
      }

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      const exp = payload.exp;
      const now = Math.floor(Date.now() / 1000);
      
      console.log(`[IEC Client] Token expiration check: exp=${exp}, now=${now}, expires_in=${exp ? exp - now : 'unknown'} seconds`);

      if (exp && exp < now) {
        // Token expired, refresh it
        console.log(`[IEC Client] Token expired, refreshing...`);
        await this.refreshToken();
        console.log(`[IEC Client] Token refreshed successfully`);
      } else if (exp && exp - now < 300) {
        // Token expires in less than 5 minutes, refresh proactively
        console.log(`[IEC Client] Token expires soon (${exp - now}s), refreshing proactively...`);
        await this.refreshToken();
        console.log(`[IEC Client] Token refreshed proactively`);
      }

      return true;
    } catch (error) {
      if (error instanceof IECLoginError) {
        throw error;
      }
      console.error(`[IEC Client] Token check failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new IECLoginError(-1, `Token check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Refresh JWT token
   */
  async refreshToken(): Promise<void> {
    if (!this.token?.refresh_token) {
      throw new IECLoginError(-1, 'No refresh token available');
    }

    try {
      const response = await fetch(`${IEC_OKTA_BASE_URL}/oauth2/default/v1/token`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: APP_CLIENT_ID,
          redirect_uri: APP_REDIRECT_URI,
          refresh_token: this.token.refresh_token,
          grant_type: 'refresh_token',
          scope: 'openid email profile offline_access',
        }),
      });

      if (!response.ok) {
        throw new IECLoginError(response.status, `Token refresh failed: ${response.statusText}`);
      }

      const tokenData = await response.json();
      this.token = tokenData as JWT;
      this.loggedIn = true;
    } catch (error) {
      if (error instanceof IECLoginError) {
        throw error;
      }
      throw new IECLoginError(-1, `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load token from file
   */
  async loadTokenFromFile(filePath: string): Promise<void> {
    try {
      const expandedPath = filePath.replace(/^~/, process.env.HOME || '');
      const contents = await readFile(expandedPath, 'utf-8');
      this.token = JSON.parse(contents) as JWT;
      await this.checkToken();
      this.loggedIn = true;
    } catch (error) {
      throw new IECLoginError(-1, `Failed to load token: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save token to file
   */
  async saveTokenToFile(filePath: string): Promise<void> {
    if (!this.token) {
      throw new IECLoginError(-1, 'No token to save');
    }

    try {
      const expandedPath = filePath.replace(/^~/, process.env.HOME || '');
      const dir = dirname(expandedPath);
      if (dir !== '.') {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(expandedPath, JSON.stringify(this.token, null, 2), 'utf-8');
    } catch (error) {
      throw new IECLoginError(-1, `Failed to save token: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get customer data
   */
  async getCustomer(): Promise<Customer | null> {
    await this.checkToken();

    if (!this.token) {
      throw new IECLoginError(-1, 'No token available');
    }

    try {
      console.log(`[IEC Client] Fetching customer data from: ${GET_CONSUMER_URL}`);
      console.log(`[IEC Client] Using token (first 20 chars): ${this.token.id_token.substring(0, 20)}...`);
      console.log(`[IEC Client] Token full length: ${this.token.id_token.length} chars`);
      
      const requestHeaders = getIecApiHeaders(this.token.id_token);
      console.log(`[IEC Client] Request headers:`, JSON.stringify({ ...requestHeaders, authorization: 'Bearer ***' }, null, 2));
      
      const response = await fetch(GET_CONSUMER_URL, {
        method: 'GET',
        headers: requestHeaders,
      });

      console.log(`[IEC Client] Customer API response status: ${response.status} ${response.statusText}`);
      console.log(`[IEC Client] Response headers:`, JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

      const responseText = await response.text();
      console.log(`[IEC Client] Customer API response body (full): ${responseText}`);
      
      if (!response.ok) {
        console.error(`[IEC Client] Customer API error - Status: ${response.status}, Response: ${responseText}`);
        
        // If token is invalid (401/403), try refreshing it
        if (response.status === 401 || response.status === 403) {
          console.log(`[IEC Client] Token appears invalid (${response.status}), attempting refresh...`);
          try {
            await this.refreshToken();
            console.log(`[IEC Client] Token refreshed, retrying customer request...`);
            // Retry once after refresh
            const retryResponse = await fetch(GET_CONSUMER_URL, {
              method: 'GET',
              headers: getIecApiHeaders(this.token!.id_token),
            });
            
            if (!retryResponse.ok) {
              const retryErrorText = await retryResponse.text().catch(() => '');
              const retryErrorText2 = await retryResponse.text().catch(() => '');
            console.error(`[IEC Client] Retry after refresh failed - Status: ${retryResponse.status}, Response: ${retryErrorText2}`);
            throw new IECError(
                retryResponse.status,
                `Failed to get customer after token refresh: ${retryResponse.statusText}. ${retryErrorText2.substring(0, 200)}`,
              );
            }
            
            const retryResponseText = await retryResponse.text();
            console.log(`[IEC Client] Retry response body: ${retryResponseText}`);
            const retryData = JSON.parse(retryResponseText) as Customer;
            this.bpNumber = retryData.bpNumber ?? retryData.bp_number;
            console.log(`[IEC Client] Customer data retrieved successfully after token refresh`);
            return retryData;
          } catch (refreshError) {
            console.error(`[IEC Client] Token refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
            throw new IECLoginError(-1, `Token expired and refresh failed. Please re-authenticate.`);
          }
        }
        
        // For 404, check if it's actually an authentication issue or wrong endpoint
        if (response.status === 404) {
          console.error(`[IEC Client] 404 Not Found - This could mean:`);
          console.error(`[IEC Client] 1. The API endpoint is incorrect`);
          console.error(`[IEC Client] 2. The user account doesn't exist`);
          console.error(`[IEC Client] 3. The token doesn't have access to this resource`);
          console.error(`[IEC Client] Response body: ${responseText}`);
        }
        
        throw new IECError(response.status, `Failed to get customer: ${response.statusText}. Response: ${responseText.substring(0, 500)}`);
      }
      
      console.log(`[IEC Client] Customer API response body: ${responseText}`);
      
      let customer: Customer;
      try {
        customer = JSON.parse(responseText) as Customer;
      } catch (parseError) {
        console.error(`[IEC Client] Failed to parse customer response as JSON: ${parseError}`);
        console.error(`[IEC Client] Response was: ${responseText}`);
        throw new IECError(-1, `Invalid JSON response from customer API: ${responseText.substring(0, 200)}`);
      }
      this.logApiResponse('customer', customer);
      this.bpNumber = customer.bpNumber ?? customer.bp_number;
      if (!this.bpNumber) {
        console.error(`[IEC Client] Customer response missing BP number. Keys:`, Object.keys(customer));
        throw new IECError(-1, 'Customer response missing bpNumber');
      }
      console.log(`[IEC Client] Customer data parsed successfully. BP Number: ${this.bpNumber}`);
      return customer;
    } catch (error) {
      if (error instanceof IECError || error instanceof IECLoginError) {
        throw error;
      }
      throw new IECError(-1, `Failed to get customer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get contracts
   */
  async getContracts(bpNumber?: string): Promise<Contract[]> {
    await this.checkToken();

    if (!this.token) {
      throw new IECLoginError(-1, 'No token available');
    }

    const bp = bpNumber || this.bpNumber;
    if (!bp) {
      throw new Error('BP number must be provided');
    }

    try {
      const url = GET_CONTRACTS_URL.replace('{bp_number}', bp);
      const response = await fetch(url, {
        method: 'GET',
        headers: getIecApiHeaders(this.token.id_token),
      });

      if (!response.ok) {
        throw new IECError(response.status, `Failed to get contracts: ${response.statusText}`);
      }

      const raw = await response.json();
      this.logApiResponse('contracts', raw);
      const data = raw as { contracts?: Contract[]; data?: { contracts?: Contract[] } };
      const contracts = data.contracts ?? data.data?.contracts ?? [];
      if (contracts.length > 0) {
        this.contractId = contracts[0].contractId ?? contracts[0].contract_id;
      }
      return contracts;
    } catch (error) {
      if (error instanceof IECError || error instanceof IECLoginError) {
        throw error;
      }
      throw new IECError(-1, `Failed to get contracts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get last meter reading
   */
  async getLastMeterReading(bpNumber?: string, contractId?: string): Promise<IecReading> {
    await this.checkToken();

    if (!this.token) {
      throw new IECLoginError(-1, 'No token available');
    }

    const bp = bpNumber || this.bpNumber;
    const contract = contractId || this.contractId;

    if (!bp) {
      return {
        lastMeterReading: 0,
        error: 'BP number must be provided',
      };
    }

    if (!contract) {
      return {
        lastMeterReading: 0,
        error: 'Contract ID must be provided',
      };
    }

    try {
      const url = GET_LAST_METER_READING_URL
        .replace('{contract_id}', contract)
        .replace('{bp_number}', bp);

      const response = await fetch(url, {
        method: 'GET',
        headers: getIecApiHeaders(this.token.id_token),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new IECError(response.status, `Failed to get meter reading: ${response.statusText}. ${errText.substring(0, 200)}`);
      }

      const raw = (await response.json()) as MeterReadings;
      this.logApiResponse('LastMeterReading', raw);
      const reading = raw.data ?? (raw as Record<string, unknown>);
      const lastMeters = (reading as MeterReadings).lastMeters ?? (reading as MeterReadings).last_meters ?? [];
      if (lastMeters.length === 0) {
        return { lastMeterReading: 0, error: 'No meter readings available' };
      }

      const meter = lastMeters[0] as { meterReadings?: MeterReading[]; meter_readings?: MeterReading[] };
      const meterReadings = meter.meterReadings ?? meter.meter_readings ?? [];
      if (meterReadings.length === 0) {
        return { lastMeterReading: 0, error: 'No meter readings in response' };
      }

      const lastReading = meterReadings[0];
      const value = lastReading.reading ?? 0;
      const readingDate = lastReading.readingDate ?? lastReading.reading_date;

      return {
        lastMeterReading: value,
        readingDate: typeof readingDate === 'string' ? readingDate : undefined,
        contractId: contract,
        bpNumber: bp,
      };
    } catch (error) {
      if (error instanceof IECError || error instanceof IECLoginError) {
        return {
          lastMeterReading: 0,
          error: error.message,
        };
      }
      return {
        lastMeterReading: 0,
        error: `Failed to get meter reading: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Get devices for a contract (needed for consumption data).
   * API returns array of { deviceNumber, deviceCode } (no serialNumber).
   */
  async getDevices(contractId?: string): Promise<Array<{ deviceNumber?: string; deviceCode?: string; serialNumber?: string }>> {
    await this.checkToken();

    if (!this.token) {
      throw new IECLoginError(-1, 'No token available');
    }

    const contract = contractId || this.contractId;
    if (!contract) {
      throw new Error('Contract ID must be provided');
    }

    try {
      const url = `${IEC_API_BASE_URL}Device/${contract}`;
      console.log(`[IEC Client] Fetching devices from: ${url}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: getIecApiHeaders(this.token.id_token),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new IECError(response.status, `Failed to get devices: ${response.statusText}. ${errText.substring(0, 200)}`);
      }

      const raw = await response.json();
      this.logApiResponse('devices', raw);
      // API returns array directly
      const devices = Array.isArray(raw) ? raw : (raw as { data?: unknown[] }).data ?? [];
      
      console.log(`[IEC Client] Found ${devices.length} devices, raw keys: ${devices.length ? Object.keys(devices[0] as object).join(',') : 'n/a'}`);
      
      return devices.map((d: Record<string, unknown>) => ({
        deviceNumber: (d.deviceNumber ?? d.device_number) as string | undefined,
        deviceCode: (d.deviceCode ?? d.device_code) as string | undefined,
        // API returns deviceNumber (meter id), use as meterSerial for Remote Reading
        serialNumber: (d.serialNumber ?? d.serial_number ?? d.deviceNumber ?? d.device_number) as string | undefined,
      }));
    } catch (error) {
      if (error instanceof IECError || error instanceof IECLoginError) {
        throw error;
      }
      throw new IECError(-1, `Failed to get devices: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get current month usage from remote reading API
   */
  async getCurrentMonthUsage(bpNumber?: string, contractId?: string): Promise<number | null> {
    await this.checkToken();

    if (!this.token) {
      throw new IECLoginError(-1, 'No token available');
    }

    const bp = bpNumber || this.bpNumber;
    const contract = contractId || this.contractId;

    if (!bp || !contract) {
      console.log(`[IEC Client] Cannot get monthly usage: bp=${!!bp}, contract=${!!contract}`);
      return null;
    }

    try {
      // Get devices to find meter serial and code (API returns deviceNumber, deviceCode)
      const devices = await this.getDevices(contract);
      const first = devices[0];
      const meterSerial = first?.serialNumber ?? first?.deviceNumber;
      const meterCode = first?.deviceCode;
      
      if (devices.length === 0 || !meterSerial || !meterCode) {
        console.log(`[IEC Client] No device info for monthly usage: devices=${devices.length}, serial=${!!meterSerial}, code=${!!meterCode}`);
        return null;
      }
      
      console.log(`[IEC Client] Using meter serial=${meterSerial}, code=${meterCode} for monthly usage`);

      // Calculate first day of current month
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const fromDate = firstDayOfMonth.toISOString().split('T')[0]; // YYYY-MM-DD

      const url = GET_REMOTE_READING_URL.replace('{contract_id}', contract);
      console.log(`[IEC Client] Fetching monthly usage from: ${url}, fromDate: ${fromDate}`);

      const requestBody = {
        contractNumber: contract,
        fromDate: fromDate,
        resolution: 3, // MONTHLY
        smartMetersList: [{
          meterKind: 'Consumption',
          meterCode: meterCode,
          meterSerial: meterSerial,
        }],
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...getIecApiHeaders(this.token.id_token),
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.error(`[IEC Client] Failed to get monthly usage: ${response.status} ${errText.substring(0, 300)}`);
        return null;
      }

      const raw = (await response.json()) as Record<string, unknown>;
      this.logApiResponse('RemoteReadingRange (monthly consumption)', raw);
      const data = (raw.data ?? raw) as Record<string, unknown>;
      const meterList = (data.meterList ?? data.meter_list ?? []) as Array<Record<string, unknown>>;
      
      if (meterList.length === 0) {
        console.log(`[IEC Client] Monthly usage response has no meterList. Top-level keys: ${Object.keys(raw).join(',')}`);
        return null;
      }

      const meter = meterList[0];
      const futureInfo = (meter.futureConsumptionInfo ?? meter.future_consumption_info) as { futureConsumption?: number; future_consumption?: number } | undefined;
      const usage =
        (futureInfo?.futureConsumption ?? futureInfo?.future_consumption) as number | undefined ??
        (meter.totalConsumptionForPeriod as number | undefined) ??
        (meter.total_consumption_for_period as number | undefined) ??
        null;
      
      if (usage !== null && typeof usage === 'number') {
        console.log(`[IEC Client] Current month usage: ${usage} kWh`);
      } else {
        console.log(`[IEC Client] Monthly usage not in response. Meter keys: ${Object.keys(meter).join(',')}`);
      }
      
      return typeof usage === 'number' ? usage : null;
    } catch (error) {
      console.error(`[IEC Client] Error getting monthly usage: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Fetch meter reading (convenience method that handles the full flow)
   */
  async fetchMeterReading(): Promise<IecReading> {
    try {
      const customer = await this.getCustomer();
      if (!customer) {
        return { lastMeterReading: 0, error: 'Failed to get customer data' };
      }

      const contracts = await this.getContracts();
      if (!contracts || contracts.length === 0) {
        return { lastMeterReading: 0, error: 'No contracts found' };
      }

      const bp = customer.bpNumber ?? customer.bp_number ?? this.bpNumber;
      const contractId = contracts[0].contractId ?? contracts[0].contract_id;
      
      const reading = await this.getLastMeterReading(bp, contractId);
      
      // Also fetch current month usage
      const currentMonthUsage = await this.getCurrentMonthUsage(bp, contractId).catch(() => null);
      if (currentMonthUsage !== null) {
        reading.currentMonthUsage = currentMonthUsage;
      }
      
      return reading;
    } catch (error) {
      return {
        lastMeterReading: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Helper function to read user input
 */
export async function readUserInput(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
