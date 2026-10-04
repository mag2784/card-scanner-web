# Card Scanner (web)

Scan Pokémon cards with your phone's camera, see prices, and keep binders for your
collection. Works on iPhone and Android in the browser, and can be added to the home
screen like an app. Card data and prices come from TCGdex (free).

## Publish it (GitHub Pages, free)

1. Create a new **public** GitHub repository, for example `card-scanner-web`.
2. **Add file › Upload files** and upload every file in this folder (they all sit at the top level).
3. **Settings › Pages**: Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`. Save.
4. After a minute or two the app is live at `https://YOUR-USERNAME.github.io/card-scanner-web/`.

## Install on a phone

- **iPhone:** open the link in Safari › Share › **Add to Home Screen**.
- **Android:** open the link in Chrome › ⋮ › **Add to Home screen** (or **Install app**).

Add it to the home screen: iPhones can clear data for websites that aren't, and the
camera works best from the installed icon.

## Update it

Upload the changed files to the same repository (they replace the old ones). Pages
republishes in a minute or two, and phones get the new version the next time the app is
opened. "Check for updates" at the bottom of the scanner forces a refresh.

## Back up binders to Google Sheets

In the app: **Binders › Back up** walks through it. Each family uses their own Google
Sheet; the script is `apps-script.txt` (the app has a Copy button for it).

## Prices

Prices come from TCGdex. If TCGdex has no US price for an English card, the app checks a nightly
copy of TCGplayer's data (tcgcsv.com) and then pokemontcg.io. Cards that only have a European
(Cardmarket) price show an approximate dollar amount using the day's exchange rate. If nothing is
found, you can type in a price yourself; it's replaced automatically once a real price appears.

## Files

| File | What it does |
|---|---|
| `index.html` | Layout and styles |
| `logic.js` | Reading card numbers and names, matching, card lookups |
| `binder.js` / `binder.css` | The binders screen: a binder with pockets and turning pages, and the card that floats out of its pocket |
| `app.js` | Camera, text recognition (Tesseract.js), results, binders, sheet backup |
| `sw.js` | Offline support and quick updates |
| `apps-script.txt` | Google Sheet backup script |
