# Wi-Fi Drop

A website where everyone on the same Wi-Fi can send photos, videos and files to each other. Open it on any phone, tablet or computer: the other devices on your network show up, and files go **straight from one device to the other**. Nothing is uploaded, and files never pass through any server.

## How it works

- **Rooms by network.** Everyone who opens the site from the same home internet connection lands in the same room and sees each other. People on other networks open the same site but never see you.
- **Files go device to device.** When someone downloads a file, the two browsers open a direct, encrypted connection (WebRTC) and the file travels over it. The website and Ably only carry small messages: who is here, the names and sizes of shared files, and the messages that set up the direct connection. **File contents never touch a server.**
- **You choose who gets it.** Share with everyone in the room, or only with chosen devices: the others don't even see the file. Recipients can pass access on if you allow it.
- **Nothing is kept.** Shared files stay in the browser tab while Wi-Fi Drop is open in it (on any of its pages). Close the tab and they disappear from every device.
- Every tab of one browser counts as one device. A private/incognito window counts as a separate device.

### What runs where

| Part | Where | What it does |
|---|---|---|
| Pages, styles, scripts | Vercel (static) | The site itself |
| `api/token.js` | Vercel function | Gives each visitor a pass (an Ably token) to their own network's room only |
| `api/qr.js` | Vercel function | The QR code for the site's address |
| Live room | [Ably](https://ably.com) | Who's here, file names/sizes, connection set-up messages |
| Files | Directly between browsers | Never on a server |

## Set up

### 1. Ably (free)

1. Create an account at [ably.com](https://ably.com) (the free plan allows 6 million messages a month and 200 devices online at once).
2. Create an app, open **API Keys**, and copy the key with all capabilities (it looks like `xVLyHw.abc123:secretpart…`). Keep it secret: never put it in the code or in GitHub.

### 2. Vercel

1. In Vercel, **Add New → Project**, and import this GitHub repository.
2. Under **Environment Variables**, add `ABLY_API_KEY` with the key from step 1.
3. **Deploy.** Vercel runs `npm run build` and publishes `dist/` and the `api/` functions (all set in `vercel.json`).

Optional environment variables:

| Variable | What it does |
|---|---|
| `ROOM_SECRET` | Your own secret for making room codes (otherwise derived from the Ably key) |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | A relay for networks that block direct connections |

### 3. Try it on your computer first (optional)

You need [Node.js](https://nodejs.org) 20 or newer. Create a file named `.env` next to `server.mjs`:

```
ABLY_API_KEY=your-key-here
```

Then:

```sh
npm install
npm start
```

It opens `http://localhost:4040`. Phones on the same Wi-Fi can open the address it prints. When testing like this, every device on your home network counts as one network.

## Ads

There are four ad spaces, set up in `ads.json`: your Google AdSense publisher id (`ca-pub-…`) and four ad slot ids. They stay empty while `client` is blank; `"preview": true` shows placeholders. Once a publisher id is set, the build also publishes the `ads.txt` file AdSense asks for. AdSense only serves ads on a site it has approved, so use your own domain on Vercel and apply with it.

## Project layout

- `public/layout.html`, `public/pages/`: the pages (Share, Devices, How it works, Privacy, Help)
- `public/app.js`: everything in the browser: sharing, access, transfers, keeping files across pages
- `public/net.js`: joining the network's room (Ably)
- `public/mascot.js`: Drip, the pixel mascot
- `public/style.css`, `public/fonts/`: the look (IBM Plex fonts, SIL Open Font License, see `public/fonts/`)
- `lib/room.mjs`: rooms and passes; `lib/pages.mjs`: building the pages
- `api/`: the Vercel functions; `build.mjs`: the Vercel build; `server.mjs`: the local test server
