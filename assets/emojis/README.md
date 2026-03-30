# Emojis « jeu » (assets)

Placez ici des **PNG** (max. **256 Ko** chacun), nommés exactement comme la clé dans `src/config/games.js` :

| Fichier |
|---------|
| `league_of_legends.png` |
| `valorant.png` |
| `cs2.png` |
| `rocket_league.png` |
| `rainbow_six_siege.png` |
| `overwatch_2.png` |
| `apex_legends.png` |
| `fortnite.png` |
| `teamfight_tactics.png` |
| `dota_2.png` |

Ensuite, avec `ASSET_GUILD_ID` et `DISCORD_TOKEN` dans `.env` :

```bash
npm run upload-emojis
```

Le mapping est généré dans `src/config/gameEmojis.generated.json`.

Les noms courts Discord réels (`lol`, `r6`, etc.) sont définis dans `src/config/gameEmojiNames.js`.
