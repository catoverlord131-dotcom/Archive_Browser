# ARCHIVE_OS // BROWSER

A retro, yellow-on-black web browser that runs in your browser window or as its own desktop app. It has tabs, bookmarks, history, downloads, a wallpaper system, and a built-in search engine (ARCHIVE_SEARCH) with ALL / AI_OVERVIEW / IMAGES / VIDEOS / NEWS tabs.

It loads real websites through a small local server (`server.js`). A plain HTML file cannot do this on its own, because websites block being shown inside other pages. The server removes those blocks and rewrites links so sites work inside your tabs.

---

## 1. What is in the folder

| File | What it is | Needed? |
|---|---|---|
| `archive_os_browser.html` | The browser interface | Yes |
| `server.js` | The proxy and search server | Yes (for real websites) |
| `start.bat` | Double-click launcher (Windows) | Optional |
| `main.js` | Desktop app wrapper (Electron) | Only for the desktop app |
| `package.json` | Desktop app settings | Only for the desktop app |
| `README.md` | This guide | No |

Keep `archive_os_browser.html` and `server.js` in the **same folder**, with those exact names. If your browser renamed a download to something like `server (1).js`, rename it back.

---

## 2. Requirements

- **Windows 10/11** (macOS and Linux also work, see section 8).
- **Node.js 18 or newer**. Get the LTS version from https://nodejs.org. On Windows choose the **.msi installer**.
- **Chrome, Edge or Firefox.** Safari is not supported (see Limitations).
- Internet access.

### Install Node.js (Windows)

1. Download the `.msi` (Windows Installer) from nodejs.org and run it.
2. Click Next through the steps and keep the default options.
3. **Close and reopen any Command Prompt windows.** The installer only affects new ones.
4. Open Command Prompt and type:
   ```
   node --version
   ```
   A version number such as `v22.x.x` means it worked. If you see "not recognized", restart your PC and try again.

> Most PCs use the x64 installer. If you have an ARM laptop (some Surface / Copilot+ PCs), download the ARM64 version instead.

---

## 3. Quick start (3 minutes)

1. Create a folder, for example `archive-os` on your Desktop.
2. Put `archive_os_browser.html` and `server.js` in it.
3. Open Command Prompt **inside that folder**: open the folder in File Explorer, click the address bar, type `cmd`, press Enter.
4. Start the server:
   ```
   node server.js
   ```
   You should see:
   ```
   ARCHIVE_OS // PROXY SERVER ONLINE
   Open  ->  http://localhost:3000
   ```
5. In Chrome, Edge or Firefox go to **http://localhost:3000**.
6. Click **CONTINUE AS GUEST** (or log in with `admin` / `1234`; the login is local-only and just for show).
7. Type a site (for example `en.wikipedia.org`) or a search into the address bar and press GO.

To confirm the proxy is connected: press **CFG**, open the **SYSTEM** tab, and check that **PROXY_STATUS** says **ONLINE** in green.

Keep the black window open while you use it. Closing it stops the server. Start it again with `node server.js` whenever you want to use the browser.

---

## 4. Using the browser

### Toolbar and tabs
- **+** opens a new tab. Click the **x** on a tab to close it.
- Back / Forward / Reload / Home buttons work as expected.
- The star bookmarks the page. **BM** = bookmarks, **HX** = history, **DL** = downloads, **CFG** = settings.
- The address bar accepts a URL (`github.com`), a full address, or search words. Search words go to your selected search engine (ARCHIVE_SEARCH by default).

### Keyboard shortcuts
| Shortcut | Action |
|---|---|
| Ctrl + T | New tab |
| Ctrl + W | Close tab |
| Ctrl + Tab | Next tab |
| Ctrl + L | Focus address bar |
| Ctrl + D | Bookmark page |
| Ctrl + , | Settings |
| Ctrl + H / B / J | History / Bookmarks / Downloads |
| Ctrl + R | Reload |
| Alt + Left / Right | Back / Forward |
| Esc | Close panels, settings and the video player |

Some shortcuts (like Ctrl + W and Ctrl + T) are also used by Chrome/Edge themselves. They work best in the app window (Option A or B in section 4).

### ARCHIVE_SEARCH
Type anything into the address bar or the new-tab search box. The results page has tabs along the top:

- **ALL**: web results, an AI overview card, an encyclopedia panel, and instant answers (try `2+2*8`, `time`, or `date`).
- **AI_OVERVIEW**: a summary stitched together from the top sources, with numbered links. It is an automatic summary, **not** a language model.
- **IMAGES**: image grid. Click an image to open it, or the caption to open its source page.
- **VIDEOS**: video results. Click a thumbnail to play it in the in-app player.
- **NEWS**: recent headlines with source and time.

Type `archive://search` in the address bar to open the search home page. The **I'M_FEELING_LUCKY** button opens the first result.

### Settings (CFG)
- **PROFILE**: name, status, avatar, wallpaper image upload, wallpaper URL.
- **APPEARANCE**: accent color, font, scanlines, **WALLPAPER on/off**, and **BACKGROUND_DIM** (lower = brighter wallpaper).
- **BROWSER**: home page, **PROXY_SERVER**, search engine, new-tab behavior, clock format, history size.
- **HOTKEYS**: shortcut list.
- **SYSTEM**: storage usage, **PROXY_STATUS**, export/import config, wipe data.

Press **COMMIT_TO_DISK** to save. Changes apply immediately without a reload.

### Wallpaper
1. CFG > PROFILE > choose a file under **WALLPAPER_IMAGE** (or paste a link under **WALLPAPER_URL**, which takes priority).
2. CFG > APPEARANCE > set **WALLPAPER** to ENABLED and adjust **BACKGROUND_DIM**.
3. Press **COMMIT_TO_DISK**.

The wallpaper shows on the login screen, the new-tab page and the search pages. Real websites keep their own backgrounds.

---

## 5. Configuration (optional)

Settings go in environment variables before `node server.js`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `PROXY_DOMAIN` | `px.localhost` | Domain used for proxied sites |
| `PUBLIC_SCHEME` | `http` | `http` or `https` |

Windows (Command Prompt) example:
```
set PORT=8080 && node server.js
```
Then open `http://localhost:8080`.

If you change the port, open CFG > BROWSER and set **PROXY_SERVER** to match (for example `http://localhost:8080`) when you run the HTML file from somewhere other than the server. Opening the page through the server (`http://localhost:PORT`) detects it automatically.

> Your settings, bookmarks and history are stored by the browser **per address**. `http://localhost:3000` and `http://localhost:8080` keep separate data. Use CFG > SYSTEM > EXPORT_CONFIG to back them up.

---

## 6. How it works (short version)

- `server.js` serves the interface and acts as the proxy.
- Each website gets its own address of the form `https://example.com` -> `http://example.com.s.px.localhost:3000`. Browsers resolve `*.localhost` to your own computer automatically, so each site is isolated from the interface and from other sites.
- The server removes frame-blocking headers, rewrites links, forms and stylesheets, keeps a cookie jar so logins persist, streams video and downloads, and injects a small script that keeps navigation, popups, and the address bar working.
- Search results (web, images, videos, news) are fetched by the server from public search pages.
- Everything runs on your own computer. Nothing is sent to any ARCHIVE_OS server.

---

## 7. macOS and Linux

1. Install Node.js 18+ from nodejs.org (or your package manager).
2. In a terminal in the project folder:
   ```
   node server.js
   ```
3. Open `http://localhost:3000` in Chrome, Edge or Firefox.

`start.bat` is Windows-only. The Electron build works on macOS/Linux with `npm run build -- --mac` or `--linux`, but you may need to adjust `package.json`.

---

## 8. Troubleshooting

**`'node' is not recognized`**
Node is not installed or the terminal was open during install. Close all Command Prompt windows and open a new one. If it still fails, restart your PC or reinstall with the .msi.

**`Error: listen EADDRINUSE` (address already in use)**
Something else is using port 3000, often an old copy of the server. Close the other window, or use another port: `set PORT=3001 && node server.js`.

**PROXY_STATUS says OFFLINE**
The server is not running or the address is wrong. Start `node server.js`, then in CFG > BROWSER set **PROXY_SERVER** to `http://localhost:3000` and press COMMIT_TO_DISK. Without the server, the browser falls back to a slow legacy mode that works on very few sites.

**A page shows `UPSTREAM_UNREACHABLE`**
The server could not reach that website (site down, no internet, or the site blocks your network). Check your connection and try again.

**Sites load but look wrong or are blank**
Some sites are very heavy web apps or use anti-bot protection. Try reloading. See Limitations below.

**Nothing loads and the address looks like `...px.localhost`**
Your browser or network may not resolve `*.localhost`. Use Chrome, Edge or Firefox (not Safari), and make sure no VPN, proxy or security tool is intercepting localhost.

**Windows Firewall prompt**
Choose **Allow** for private networks. The server only needs to talk to your own computer.

**Search results are empty**
The server scrapes public search pages, which can fail or change. Try again in a moment, or try a different query or tab. IMAGES and NEWS have limited fallbacks without the server running.

**Videos in the player show an error**
The player uses the YouTube embed. It works best when you open the app through `http://localhost:3000` or the Electron app, not by double-clicking the HTML file.

**`npm install` is very slow or fails**
Check your internet connection and try again. If it keeps failing, use Option A (`start.bat`) instead, which needs no extra downloads.

**Settings or bookmarks disappeared**
Data is stored per address. If you changed the port or opened the HTML file directly instead of through `http://localhost:3000`, you are looking at a different data store. Use EXPORT_CONFIG and IMPORT_CONFIG to move settings.

---

## 9. Limitations

- **Heavy or protected sites** (for example YouTube, Google, Instagram, banking sites, sites with strong bot checks or required real-time connections) may only partly load or not load at all.
- **WebSockets** are not supported, so chat-style or live features on some sites will not work.
- **Safari** does not resolve `*.localhost` subdomains, so real-site loading will not work there.
- **Other devices**: the proxy addresses use `*.localhost`, so it is designed to be used on the same computer that runs the server, not from a phone or another PC.
- **AI_OVERVIEW** is an extractive summary of top sources, not an AI model.
- **Search scraping** depends on third-party pages and may break if those pages change.
- **Not a privacy tool.** The server sees the pages you visit, and sites see the server's connection. Use it for convenience, not anonymity.

---

## 10. Using it at school or work

Managed computers and networks can block installing Node.js, running local servers, or visiting some sites. This project does not try to get around those rules. Use it on a personal computer where you are allowed to install software, and follow your school or workplace policies. Some online coding sites (such as CodeHS) block code that contains links to non-educational sites, and it will not save or run there.

---

## 11. Updating and uninstalling

- **Update**: replace `archive_os_browser.html` and `server.js` with the newer versions and restart the server. Your settings stay (they are stored by the browser).
- **Uninstall**: delete the folder. To remove saved settings, use CFG > SYSTEM > WIPE_ALL_DATA first, or clear site data for `localhost`.
