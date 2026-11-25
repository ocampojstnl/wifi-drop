# Wi-Fi Drop

A website where everyone on the same Wi-Fi can send photos, videos and files to each other. Open it on any phone, tablet or computer: the other devices on your network show up, and files go **straight from one device to the other**. Nothing is uploaded, files never pass through any server, and there are no accounts or API keys.

## How it works

1. **A room per network.** The site's `/api/room` function gives each visitor a secret room name and password made from their home internet connection's address (and `ROOM_SECRET`). Everyone on the same Wi-Fi gets the same room; nobody else can work it out. Phones often reach the site over IPv6 and computers over IPv4, so each device also tells the site its network's IPv4 address (learned from a STUN helper); that keeps a whole home in one room.
2. **Finding each other.** Devices meet through free public [Nostr](https://nostr.com) relays, using the open-source [Trystero](https://github.com/dmotz/trystero) library. Only a short "here's how to reach me" note goes through the relays, **encrypted with the room password**, so the relays can't read it.
3. **Direct from then on.** Every device connects directly to the others (WebRTC, encrypted). Who's here, names, the files on offer, private file lists, access requests and transfer set-up all go device to device, and so do the files themselves. **Files and their names never touch a server.**
4. **Same-network check.** A shared public address doesn't prove two devices are in the same home (mobile data, offices and some providers put many homes behind one address). So each device checks how every connection actually runs (`public/lan.js`): a device is turned away only on clear signs it is somewhere else (a relay, a carrier-shared address, another home's address, or replies far slower than any Wi-Fi). A device that fails is ignored: it isn't listed and gets nothing, not even this device's name.

More:
- Share with everyone in the room, or only with chosen devices: the others don't even see the file. Recipients can pass access on if you allow it.
- Shared files stay in the browser tab while Wi-Fi Drop is open in it (on any of its pages, and through reloads) until you stop sharing them. Close the tab and they disappear from every device; the browser's copy is cleared on the next visit.
- Every tab of one browser counts as one device (Trystero gives each browser a signed identity nobody else can use). A private/incognito window is a separate device: it starts with no stored identity on purpose, and nothing a website can do will link it to the normal window.
- Phones keep a received file in memory until you tap Save (they have no way to write straight to disk), so very large files (above about 1–2 GB) may not fit there. Computers with Chrome or Edge save straight to disk, with no limit.

What can see what: the relays (like any website) see the internet address a device connects from, but nothing it says. Google's and Cloudflare's free STUN helpers tell each device how it looks from outside, so two devices can find a direct path.

## Deploy on Vercel

1. In Vercel, **Add New → Project**, and import this GitHub repository.
2. Recommended: under **Environment Variables**, add `ROOM_SECRET` with any long random text you make up (it keeps room names impossible to work out, even for someone who reads this code). No sign-up needed.
3. **Deploy.** Vercel runs `npm run build` and publishes `dist/` and the `api/` functions (all set in `vercel.json`).

Some networks (guest Wi-Fi, some offices) keep devices apart on purpose. Wi-Fi Drop can't work there, and won't fall back to a relay: files only ever go device to device.

## Try it on your computer

You need [Node.js](https://nodejs.org) 20 or newer:

```sh
npm install
npm start
```

It opens `http://localhost:4040` on this PC. **Other devices** (phones, other computers) open the **https** address it prints, like `https://192.168.1.20:4443`, or scan the QR code on the page:

- Browsers only allow the encryption Wi-Fi Drop needs on secure pages, so the other devices need the `https://` address. A plain `http://192.168…` address shows "Needs https".
- The certificate is made on your PC, so each device warns once that the connection isn't private: tap **Advanced → Proceed**.
- When testing like this, every device on your home network counts as one network.

## Tests

- `npm test`: quick checks of the same-network check and the rooms (no browser needed).
- `npm run test:e2e`: two separate Chrome (or Edge) browsers on this computer find each other through the real public relays, and one downloads a 3 MB file from the other, which must arrive intact. Needs internet.

## Ads

There are four ad spaces, set up in `ads.json`: your Google AdSense publisher id (`ca-pub-…`) and four ad slot ids. They stay empty while `client` is blank (the local test server shows placeholders). Once a publisher id is set, the build also publishes the `ads.txt` file AdSense asks for. AdSense only serves ads on a site it has approved, so use your own domain on Vercel and apply with it.

## Project layout

- `public/layout.html`, `public/pages/`: the pages (Share, Devices, How it works, Privacy, Help)
- `public/app.js`: everything in the browser: sharing, access, transfers, keeping files across pages
- `public/net.js`: finding the other devices and talking to them directly (Trystero)
- `public/lan.js`: the same-network check
- `public/mascot.js`: Drip, the pixel mascot
- `public/style.css`, `public/fonts/`: the look (IBM Plex fonts, SIL Open Font License, see `public/fonts/`)
- `lib/room.mjs`: rooms; `lib/pages.mjs`: building the pages and bundling Trystero
- `tests/`: the tests
- `api/`: the Vercel functions; `build.mjs`: the Vercel build; `server.mjs`: the local test server
