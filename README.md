# Wi-Fi Drop

Send photos, videos and files between the phones, tablets and computers in your home, over your own Wi-Fi. Files go straight from one device to the other: nothing is uploaded, and nothing is kept.

## How it works

- One computer runs Wi-Fi Drop. Everyone else on the same Wi-Fi opens the address it shows (or scans its QR code) in any browser. No app to install.
- Every device on the network is welcome, and nothing outside the network can reach it.
- Files travel directly between devices over an encrypted connection (WebRTC). The computer running Wi-Fi Drop only introduces the devices to each other; files never pass through it.
- Share with everyone, or only with the devices you pick. They can pass access on if you allow it.
- Shared files stay available while the browser tab is open, on any page of Wi-Fi Drop. Close the tab and they disappear from every device.
- Running Wi-Fi Drop on several computers at home? They find each other and join up automatically.

## Start it

You need [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install
npm start
```

On Windows you can double-click **Start Wi-Fi Drop.bat** instead. The page opens in your browser and shows the address for the other devices.

When Windows asks about the firewall, allow Node.js on **Private networks**, and make sure your Wi-Fi is set to *Private* in Windows network settings.

### Options

| Setting | What it does |
|---|---|
| `PORT=4041` | Use another port (default 4040) |
| `NO_OPEN=1` | Don't open the browser on start |
| `DISCOVERY=off` | Don't look for or join Wi-Fi Drop on other computers |

## Ads

The pages have four ad spaces, set up in `ads.json` (Google AdSense publisher id and ad slot ids). They stay empty while `client` is blank. Note that AdSense only serves ads on a public website it has approved, which a home-network page is not.

## Project layout

- `server.mjs`: the small server. It serves the pages, lists the devices, and passes connection set-up messages between them.
- `public/layout.html` and `public/pages/`: the pages (Share, Devices, How it works, Privacy, Help).
- `public/app.js`: everything in the browser: sharing, access, transfers, keeping files across pages.
- `public/mascot.js`: Drip, the pixel mascot.
- `public/style.css`, `public/fonts/`: the look. Fonts are IBM Plex (SIL Open Font License, see `public/fonts/`).
