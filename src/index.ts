import type { API } from 'homebridge';

import { IecElectricityPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * Registers the IEC Electricity platform with Homebridge
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, IecElectricityPlatform);
};
