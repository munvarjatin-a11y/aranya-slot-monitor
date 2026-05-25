# Aranya Vihaara Slot Monitor

This monitor checks the public Aranya Vihaara booking form for Nethravathi and Kudremukha weekend slots. It alerts when a sold-out `300` capacity slot such as `0/300` becomes any positive number like `1/300`.

The site currently accepts bookings only from 1 to 15 days ahead, so target dates must be inside that window.

## Setup

The `.env` file is already configured for:

- Kudremukha Trek: district `17`, trek `112`
- Nethravathi Trek: district `24`, trek `113`
- Saturdays and Sundays only
- `300` capacity slots only
- strict zero-to-positive alerts only

Add your Twilio values to `.env`:

```text
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
WHATSAPP_TO=whatsapp:+91XXXXXXXXXX
```

For the Twilio Sandbox, send your sandbox join code from your WhatsApp number to `+14155238886` first.

Test WhatsApp:

```powershell
node .\aranya-monitor.mjs --test-whatsapp
```

Run one check:

```powershell
node .\aranya-monitor.mjs
```

Run continuously every 5 minutes:

```powershell
$env:LOOP="true"; node .\aranya-monitor.mjs
```

## Free Cloud Option

GitHub Actions can run this monitor in the cloud every 5 minutes. GitHub's official docs say scheduled workflows can run as often as once every 5 minutes, and standard GitHub-hosted runners are free for public repositories. Private repositories get a free minutes quota.

The workflow is already included at `.github/workflows/aranya-monitor.yml`.

1. Create a GitHub repository.
2. Upload these files, but do not upload `.env`.
3. In the repository, go to **Settings > Secrets and variables > Actions > New repository secret**.
4. Add these secrets:

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM
WHATSAPP_TO
```

Use these values:

```text
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
WHATSAPP_TO=whatsapp:+91YOURNUMBER
```

5. Go to the **Actions** tab and enable workflows if GitHub asks.
6. Open **Aranya slot monitor** and click **Run workflow** once to test.

The workflow commits `state.json` after every run so it remembers which slots were previously `0/300`.

Change the interval:

```powershell
$env:CHECK_INTERVAL_SECONDS="180"; $env:LOOP="true"; node .\aranya-monitor.mjs
```

## Notes

- If no WhatsApp credentials are configured, the monitor prints the message it would send.
- `state.json` is created automatically. The first run records the baseline quietly because `ALERT_ON_FIRST_POSITIVE=false`.
- Keep the interval gentle. A 3 to 5 minute check interval is a reasonable starting point.
- Twilio Sandbox messages may require you to rejoin the sandbox later. For reliable alerts outside WhatsApp's 24-hour customer service window, use an approved Twilio WhatsApp Content Template and set `TWILIO_CONTENT_SID`.
- This only monitors and notifies. It does not auto-book or bypass any site controls.
