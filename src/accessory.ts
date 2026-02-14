import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { IecElectricityPlatform, IecReading } from './platform.js';

/**
 * IEC Electricity Accessory
 * Exposes electricity usage (kWh) as a Light Sensor so it appears in the Home app
 * Note: Home app shows "lux" but the value represents kWh
 */
export class IecElectricityAccessory {
  private lightSensorService: Service;
  private currentValue = 0;
  private readonly readingType: 'total' | 'monthly';

  constructor(
    private readonly platform: IecElectricityPlatform,
    private readonly accessory: PlatformAccessory,
    readingType: 'total' | 'monthly' = 'total',
  ) {
    this.readingType = readingType;
    
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Israel Electric Company')
      .setCharacteristic(this.platform.Characteristic.Model, readingType === 'monthly' ? 'IEC Monthly Usage' : 'IEC Meter')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, readingType === 'monthly' ? 'IEC-MONTHLY' : 'IEC-001');

    this.lightSensorService =
      this.accessory.getService(this.platform.Service.LightSensor) ??
      this.accessory.addService(this.platform.Service.LightSensor);

    const displayName = readingType === 'monthly' 
      ? 'IEC Monthly Usage (kWh)' 
      : 'IEC Total Reading (kWh)';
    this.lightSensorService
      .setCharacteristic(this.platform.Characteristic.Name, displayName);

    this.lightSensorService
      .getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
      .onGet(this.handleLightLevelGet.bind(this));

    (this.accessory as PlatformAccessory & { handler?: IecElectricityAccessory }).handler = this;
  }

  handleLightLevelGet(): CharacteristicValue {
    return Math.max(0.0001, this.currentValue);
  }

  updateReading(reading: IecReading): void {
    if (reading.error) {
      this.platform.log.warn('IEC reading error:', reading.error);
      return;
    }
    
    const value = this.readingType === 'monthly' 
      ? (reading.currentMonthUsage ?? 0)
      : (reading.lastMeterReading ?? 0);
    
    if (value !== this.currentValue) {
      this.currentValue = value;
      this.lightSensorService
        .updateCharacteristic(
          this.platform.Characteristic.CurrentAmbientLightLevel,
          Math.max(0.0001, value),
        );
      const typeLabel = this.readingType === 'monthly' ? 'monthly usage' : 'total reading';
      this.platform.log.info(`Updated IEC ${typeLabel}: ${value} kWh`);
    }
  }
}
