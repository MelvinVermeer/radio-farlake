# Radio Farlake

Persoonlijke Spotify-radio: gewogen trekking uit je eigen playlists, templates die op tijdvensters actief worden en
bij elkaar optellen, tuning in het moment en anti-herhaalregels (nummer 4 uur, artiest 1 uur).

## Starten

```sh
npm install
npm run dev   # http://127.0.0.1:5173
npm test      # kanslogica (src/engine.ts)
```

Spotify-app (Development Mode): redirect URI `http://127.0.0.1:5173/callback`. Afspelen vereist Premium.

## Keuzes

- **Geen backend**: Authorization Code + PKCE in de browser; tokens in `localStorage`.
- **Opslag**: alles (gekoppelde playlists met nummer-cache, templates, tuning, 24 uur afspeelgeschiedenis) staat in
  één `localStorage`-object. Eén gebruiker, kleine data, blijft staan na herstart. Plafond: ~5 MB, dus tot zo'n
  20.000 gecachete nummers; daarna de cache naar IndexedDB verplaatsen.
- **Cache**: nummers worden per playlist bewaard en alleen opnieuw opgehaald als de `snapshot_id` op Spotify
  veranderd is ("Vernieuwen" op het Playlists-scherm).
- **Eigen wachtrij**: de app start elk nummer los op de Web Playback SDK-speler. Spotify's eigen wachtrij laat geen
  verwijderen toe, dus overslaan en herberekenen zou daar niet kunnen.
- **Tuning** blijft gelden tot je op Reset drukt, ook na herstart. Elke wijziging van de verhouding (tuning, een
  template dat aan of uit gaat, playlists koppelen) berekent de hele wachtrij opnieuw; wat nu speelt blijft.
- **Regels versoepelen**: is er geen toegestaan nummer, dan vervalt eerst de artiestregel en daarna ook de
  nummerregel. Dat zie je in de app.
- **Aanbevelingen via ReccoBeats**: Spotify's recommendations en audio-features zijn dicht voor nieuwe apps (sinds
  november 2024). "Aanbevelingen ophalen" (Radio → Sfeer) haalt ~400 aanbevelingen bij ReccoBeats op, geseed met
  nummers uit wat nu draait, plus hun negen audio-features (akoestiek, dansbaarheid, energie, instrumentaal, live,
  luidheid, spraak, tempo, vrolijkheid). Dat wordt één extra bron
  (`ReccoBeats-aanbevelingen`) met een gewicht zoals elke playlist. De sfeer-schuiven filteren en sorteren die
  pool in eigen code (`matchMood`, marge 20% van het bereik per feature), zonder nieuwe requests; Reset wist ze samen met de tuning.
- **Alleen eigen playlists**: sinds februari 2026 geeft Spotify alleen nog inhoud van playlists die je bezit of
  waaraan je meewerkt. Een gevolgde playlist eerst kopiëren.

Nieuwe soorten triggers: een case erbij in `isTriggerActive` (`src/engine.ts`) en in het `Trigger`-type.
