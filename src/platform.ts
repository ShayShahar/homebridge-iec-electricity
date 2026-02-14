import { existsSync } from 'node:fs';
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { IecElectricityAccessory } from './accessory.js';
import { IecClient, type IecReading } from './iec-client.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { getDefaultTokenPath, readCurrentUserId } from './token-storage.js';

export type { IecReading };

export interface IecPlatformConfig extends PlatformConfig {
  name: string;
  logApiData?: boolean;
  pollInterval?: number;
}

/**
 * IEC Electricity Platform
 * Fetches electricity usage from Israel Electric Company and exposes it as HomeKit Light Sensors
 */
export class IecElectricityPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories = new Map<string, PlatformAccessory>();
  private readonly discoveredCacheUUIDs: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private iecClient?: IecClient;
  private currentUserId?: string;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('IEC Electricity platform initialized');

    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching - discovering IEC accessories');
      this.handleSetup();
      this.discoverDevices();
      this.startPolling();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices(): void {
    // Main meter reading accessory
    const mainUuid = this.api.hap.uuid.generate('iec-electricity-main');
    const mainAccessory = this.accessories.get(mainUuid);

    const mainDevice = {
      uniqueId: 'iec-electricity-main',
      displayName: 'IEC Total Reading (kWh)',
    };

    if (mainAccessory) {
      this.log.info('Restoring existing accessory:', mainAccessory.displayName);
      new IecElectricityAccessory(this, mainAccessory, 'total');
    } else {
      this.log.info('Adding new accessory:', mainDevice.displayName);
      const accessory = new this.api.platformAccessory(mainDevice.displayName, mainUuid);
      accessory.context.device = mainDevice;
      new IecElectricityAccessory(this, accessory, 'total');
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.discoveredCacheUUIDs.push(mainUuid);

    // Monthly usage accessory
    const monthlyUuid = this.api.hap.uuid.generate('iec-electricity-monthly');
    const monthlyAccessory = this.accessories.get(monthlyUuid);

    const monthlyDevice = {
      uniqueId: 'iec-electricity-monthly',
      displayName: 'IEC Monthly Usage (kWh)',
    };

    if (monthlyAccessory) {
      this.log.info('Restoring existing accessory:', monthlyAccessory.displayName);
      new IecElectricityAccessory(this, monthlyAccessory, 'monthly');
    } else {
      this.log.info('Adding new accessory:', monthlyDevice.displayName);
      const accessory = new this.api.platformAccessory(monthlyDevice.displayName, monthlyUuid);
      accessory.context.device = monthlyDevice;
      new IecElectricityAccessory(this, accessory, 'monthly');
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.discoveredCacheUUIDs.push(monthlyUuid);
  }

  private startPolling(): void {
    const cfg = this.config as IecPlatformConfig;
    const intervalMs = (cfg.pollInterval ?? 60) * 60 * 1000;

    const poll = async () => {
      try {
        const reading = await this.fetchIecData();
        if (reading) {
          const monthly = reading.currentMonthUsage;
          this.log.info(
            `IEC data: total=${reading.lastMeterReading ?? 0} kWh` +
            (monthly !== undefined && monthly !== null ? `, monthly=${monthly} kWh` : ', monthly=unavailable'),
          );
          this.accessories.forEach((accessory) => {
            const handler = (accessory as PlatformAccessory & { handler?: IecElectricityAccessory }).handler;
            if (handler) {
              handler.updateReading(reading);
            }
          });
        }
      } catch (err) {
        this.log.error('Poll failed:', String(err));
      }
    };

    void poll();
    this.pollTimer = setInterval(poll, intervalMs);
  }

  /**
   * Handle setup flow - login is done via Config UI; we only check for existing token here.
   */
  private async handleSetup(): Promise<void> {
    const userId = readCurrentUserId();
    if (!userId) {
      this.log.info('[IEC Platform] Not logged in. Open the plugin settings in Config UI to log in.');
      return;
    }
    const tokenPath = getDefaultTokenPath(userId);
    if (existsSync(tokenPath)) {
      return; // Already authenticated
    }
    this.log.info('[IEC Platform] No token found. Open the plugin settings in Config UI to log in.');
  }

  /**
   * Initiate login and send OTP
   */
  async fetchIecData(): Promise<IecReading | null> {
    const cfg = this.config as IecPlatformConfig;
    const userId = readCurrentUserId();
    if (!userId) {
      return null;
    }
    if (this.currentUserId !== userId) {
      this.iecClient = undefined;
      this.currentUserId = userId;
    }
    const tokenPath = getDefaultTokenPath(userId);

    try {
      // Initialize client if not already done
      if (!this.iecClient) {
        this.iecClient = new IecClient(userId, { logApiData: !!cfg.logApiData });
        try {
          await this.iecClient.loadTokenFromFile(tokenPath);
          this.log.debug(`Loaded token from ${tokenPath}`);
        } catch (error) {
          // Token file doesn't exist - setup will be handled by handleSetup()
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
            // Don't log error here - handleSetup() will handle it
            return {
              lastMeterReading: 0,
              error: 'Authentication required. Check logs for setup instructions.',
            };
          } else {
            this.log.error(`Failed to load token from ${tokenPath}: ${errorMsg}`);
            return {
              lastMeterReading: 0,
              error: `Token load failed: ${errorMsg}`,
            };
          }
        }
      }

      // Fetch meter reading
      const reading = await this.iecClient.fetchMeterReading();
      
      if (reading.error) {
        this.log.error('Failed to fetch IEC data:', reading.error);
        
        // If token expired, clear it and prompt for re-authentication
        if (reading.error.includes('Token expired') || reading.error.includes('re-authenticate')) {
          this.log.warn(
            '\n' +
            '  IEC Electricity - Re-authentication required. Open the plugin settings in Config UI to log in again.\n',
          );
          
          // Clear the client to force re-initialization
          this.iecClient = undefined;
        }
      }

      return reading;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error('Error fetching IEC data:', errorMsg);
      
      // Check if it's a token/auth error
      if (errorMsg.includes('Token expired') || errorMsg.includes('re-authenticate') || 
          errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('Not Found')) {
        this.log.warn(
          `IEC Electricity - Authentication issue: ${errorMsg}. Open the plugin settings in Config UI to log in again.`,
        );
        
        // Clear the client
        this.iecClient = undefined;
      }
      
      return {
        lastMeterReading: 0,
        error: errorMsg,
      };
    }
  }

  get configForAccessory(): IecPlatformConfig {
    return this.config as IecPlatformConfig;
  }
}
