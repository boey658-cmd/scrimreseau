# ScrimRéseau — Bot Discord

Bot Discord **réseau de scrims** : une annonce peut être diffusée sur tous les serveurs ayant configuré un salon pour le jeu concerné. Stack : **Node.js**, **discord.js v14**, **better-sqlite3** (requêtes préparées uniquement).

## Prérequis

- Node.js **20+**
- Une application Discord avec bot et commandes slash activés

## Installation

```bash
npm install
```

Copier `.env.example` vers `.env` et renseigner :

- `DISCORD_TOKEN` — token du bot
- `CLIENT_ID` — ID de l’application (onglet « General Information »)
- Optionnel : `GUILD_IDS` — liste d’IDs séparés par des virgules, déploiement **multi-guildes** en dev (instantané)
- Optionnel : `GUILD_ID` — une seule guilde (équivalent à une entrée dans `GUILD_IDS`) si vous ne utilisez pas `GUILD_IDS`
- Optionnel : `DEV_GUILD_ID` — guilde sur laquelle `/scrim-dev` est enregistrée (commande **guilde** uniquement ; invisible ailleurs après déploiement)
- Optionnel : `SQLITE_PATH` — chemin du fichier SQLite (défaut : `data/scrim.db`)

## Déploiement des commandes slash

```bash
npm run deploy-commands
```

Sans `GUILD_IDS` ni `GUILD_ID`, les commandes **publiques** (`/scrim-config`, `/scrim-moderation`, `/recherche-scrim`, etc.) sont enregistrées **globalement** (propagation pouvant prendre jusqu’environ une heure).  
Si `DEV_GUILD_ID` est défini, `/scrim-dev` est en plus enregistrée **uniquement** sur cette guilde (sans être ajoutée au global).

**Nettoyage manuel (désactivé par défaut)** — en cas de doublons (commandes globales + guilde visibles partout) :

- `CLEAR_ALL_COMMANDS_BEFORE_DEPLOY=1` : supprime d’abord **toutes** les commandes **globales**, puis si vous êtes en mode guilde (`GUILD_IDS` / `GUILD_ID`) supprime aussi les commandes de **chaque** guilde listée ; ensuite le script redéploie selon le mode (guilde ou global). À utiliser ponctuellement pour repartir propre.
- `CLEAR_GUILD_COMMANDS_BEFORE_DEPLOY=1` : sans toucher au global, vide uniquement les commandes des guildes ciblées puis redéploie (mode guilde uniquement).

## Inviter le bot

Permissions nécessaires (**uniquement**) :

- Voir les salons  
- Envoyer des messages  
- Intégrer des liens (embeds)  

Somme des permissions : `19456`. URL type :

`https://discord.com/api/oauth2/authorize?client_id=VOTRE_CLIENT_ID&permissions=19456&scope=bot%20applications.commands`

## Démarrage

```bash
npm start
```

## Emojis « jeu » (optionnel)

1. Créez une guilde Discord dédiée aux assets (ou utilisez un serveur interne).
2. Invitez le bot avec la permission **Gérer les expressions** (Manage Emojis and Stickers) sur cette guilde.
3. Ajoutez dans `.env` : `ASSET_GUILD_ID=<id de cette guilde>` (voir « Activer le mode développeur » dans Discord pour copier l’ID).
4. Placez des fichiers **PNG** (≤ 256 Ko) dans `assets/emojis/`, nommés comme les clés de `games.js` (ex. `valorant.png`, `league_of_legends.png`). Détail dans `assets/emojis/README.md`.
5. Exécutez :

```bash
npm run upload-emojis
```

Cela génère / met à jour `src/config/gameEmojis.generated.json`. Côté code, utilisez `getGameEmoji(gameKey)` (`src/utils/gameEmoji.js`) : emote custom si présente, sinon `🎮`, sans jamais lever d’erreur.

Sur les serveurs où les messages affichent ces emojis, le bot doit aussi avoir **Utiliser des emojis externes**.

**Comportement upload** : si une emote du même nom existe déjà sur la guilde assets, elle est **réutilisée** (pas de suppression ni remplacement automatique).

L’embed **recherche scrim** (diffusion) met le jeu en avant avec `getGameEmoji`, une ligne compacte 🏆📅⏰⚔️ (valeurs en gras) et le contact en dessous. Le module `getScrimEmoji` / `scrimFieldEmojis.json` reste disponible pour d’autres écrans si besoin.

## Commandes (V1)

| Commande | Qui | Description |
|----------|-----|-------------|
| `/scrim-config` | **Administrateur** | Groupes : `channel` (`set` / `remove`), `command-channel` (`set` / `reset`), `permissions` (`set` / `remove`) ; sous-commande `view`. |
| `/scrim-moderation` | **Administrateur** | Sous-commande `user` : `action` block ou unblock + utilisateur. |
| `/scrim-dev` | **Dev** (`BOT_DEV_ID`) | Sous-commande `blacklist` ; enregistrée **uniquement** sur la guilde `DEV_GUILD_ID` (déploiement via script). |
| `/recherche-scrim` | Selon la config du serveur | Diffuse une recherche (autocomplete rang + format selon le jeu). |
| `/mes-demandes` | Tout utilisateur | Liste tes recherches actives (ID public, date/heure, rang, format). |
| `/scrim-trouve` | Auteur de l’annonce | Marque une recherche LoL comme terminée (identifiant public). |
| `/spammer` | **Administrateur** | Signale un joueur pour spam de recherches scrim LoL. |
| `/help` | Tout utilisateur | Aide générale (embed, éphémère). |
| `/helpadmin` | **Administrateur** | Aide configuration et modération (embed, éphémère). |

## Sécurité & robustesse

- Requêtes SQL **préparées** (aucune concaténation)
- Validation des entrées (date, heure, rangs et formats par jeu, contact non-bot)
- Diffusion : **75 ms** entre chaque salon, **try/catch** par envoi
- Gestion des rejets de promesses et erreurs de commandes sans faire tomber le processus (logs structurés)

## Structure

```
src/
  commands/     # Slash commands
  config/       # Jeux (rangs, formats)
  database/     # SQLite + statements
  services/     # Diffusion, permissions salon
  utils/        # Logs, validation
assets/emojis/   # PNG par jeu (voir README du dossier)
index.js
scripts/deploy-commands.js
scripts/upload-game-emojis.js
```
