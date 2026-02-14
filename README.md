# Homebridge IEC Electricity

A Homebridge plugin that displays **Israel Electric Company (IEC)** electricity usage in HomeKit as a Light Sensor. The sensor value represents your total meter reading in kWh (the Home app shows "lux" as the unit, but the number is your electricity usage).

## Features

- Exposes IEC meter reading as a HomeKit Light Sensor
- Data appears in the Home app and supports automations
- Polls IEC API at configurable intervals (default: hourly)
- Written in TypeScript

## Prerequisites

1. **Node.js** 20+ and **Homebridge**

## Setup

### 1. Install the plugin

```bash
npm install -g homebridge-iec-electricity
```

**From Homebridge Config UI:** If the plugin doesn’t appear in search, use **“Install a plugin by name”** (or the + / search field) and type the exact name: **`homebridge-iec-electricity`**. Then install and add the platform from the plugin’s settings.

### 2. Configure Homebridge

Add the platform to your `config.json` or use the Config UI:

Add the platform in Config UI (or add to `config.json`). You only need to set the **name**. Log in via the plugin settings screen (Israeli ID and OTP are not stored in config).

| Option        | Description                                                       | Default  |
| ------------- | ----------------------------------------------------------------- | -------- |
| `logApiData`  | Log full JSON from each IEC API call (for adding new sensors)    | `false`  |
| `pollInterval`| How often to fetch data (minutes)                                 | `60`     |

### 3. Complete first-time authentication

Open the plugin settings in Homebridge Config UI (Plugins → IEC Electricity → the settings/gear icon). A custom setup screen will guide you:

1. Enter your **Israeli ID** (9 digits) → **Send OTP**
2. Enter the code you receive (SMS or email) → **Verify & save**
3. Save the configuration

The token is saved to `~/.homebridge/iec-tokens/<user-id>.json` and used for all future requests.

### 4. Replacing the token (re-authenticate)

Open the plugin settings in Config UI and click **Log in with a different account**. Enter your Israeli ID (or a new one), then Send OTP → enter code → Verify & save.

### 5. Verify setup

After completing the login, restart Homebridge. The "IEC Usage (kWh)" sensor should appear in the Home app.

## Note on units

HomeKit does not have a native electricity sensor. This plugin uses a **Light Sensor** to display the value. The number you see is your **total meter reading in kWh**, but the Home app may label it as "lux"—the value itself is correct.

## Discovering API data (for new sensors)

To see all fields returned by the IEC API and design new sensors:

1. Enable **"Log API data (development)"** in the plugin config.
2. Save and wait for the next poll (or restart Homebridge).
3. In the Homebridge log you’ll see full JSON for: **customer**, **contracts**, **LastMeterReading**, **devices**, and **RemoteReadingRange (monthly consumption)**.
4. Turn **"Log API data"** off again when done (to avoid large logs).

## Data updates

- IEC typically updates meter data every 1–2 days
- The plugin polls at the configured interval (default: every 60 minutes)
- More frequent polling does not produce newer data from IEC

## Troubleshooting

**"No active login session"**  
Open the plugin settings in Config UI and click **Send OTP**, then enter the code. The OTP expires after 10 minutes.

**"Failed to load token"**  
Open the plugin settings in Config UI and log in again (or use "Log in with a different account").

**Sensor shows 0**  
Check the Homebridge logs. If the token expired, open the plugin settings in Config UI to log in again.

## License

Apache-2.0
