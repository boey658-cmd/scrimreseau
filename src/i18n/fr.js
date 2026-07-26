/**
 * Langue source et fallback — Français.
 * Toutes les clés doivent être présentes ici.
 * Les clés manquantes dans en.js tombent automatiquement sur ce fichier.
 */

/** @type {Record<string, string>} */
export const fr = {
  // ── Générique ────────────────────────────────────────────────────────
  'generic.guildOnly': '❌ Cette commande doit être utilisée sur un serveur.',
  'generic.adminOnly': '❌ Réservé aux administrateurs du serveur.',
  'generic.error': '❌ Une erreur est survenue. Réessayez plus tard.',
  'generic.blacklistServiceUnavailable': '❌ Le service est momentanément indisponible. Réessaie plus tard.',
  'generic.blacklistedUser': '❌ Tu es actuellement blacklist de ScrimRéseau.\nSi tu penses que c\'est une erreur, contacte le support.',

  // ── /language ────────────────────────────────────────────────────────
  'language.successFr': '✅ La langue de ScrimRéseau est maintenant définie sur le **français** pour ce serveur.',
  'language.successEn': '✅ ScrimRéseau is now set to **English** for this server.',
  'language.invalidChoice': '❌ Valeur de langue invalide. Choisissez `fr` ou `en`.',

  // ── /find-scrim ──────────────────────────────────────────────────────
  'findScrim.lock': '⏳ Une recherche de scrim est déjà en cours de traitement.',
  'findScrim.guildOnly': '❌ Cette commande ne peut être utilisée que dans un serveur.',
  'findScrim.activeLimit': '❌ Tu as déjà {max} recherches de scrim actives. Ferme-en une ou attends qu\'elle expire avant d\'en créer une nouvelle.',
  'findScrim.cooldown': '❌ Tu dois attendre encore {seconds} seconde(s) avant de publier une nouvelle recherche.',
  'findScrim.windowLimit': '❌ Tu as atteint la limite de créations de recherche de scrim ({limit} sur {min} minutes). Réessaie un peu plus tard.',
  'findScrim.noTargets': '❌ Aucun serveur du réseau n\'a configuré de salon de diffusion pour le scrim League of Legends.',
  'findScrim.sending': '⏳ Envoi de l\'annonce…',
  'findScrim.scheduledAtError': '❌ Date ou heure invalide pour le calendrier français. Vérifie ta saisie.',
  'findScrim.scheduledAtEndError': '❌ Heure max invalide pour le calendrier français. Vérifie ta saisie.',
  'findScrim.dbError': '❌ Impossible d\'enregistrer la recherche. Réessayez plus tard.',
  'findScrim.prepareError': '❌ Impossible de préparer l\'annonce. Réessayez plus tard.',
  'findScrim.broadcastError': '❌ Une erreur est survenue pendant l\'envoi (cible : **{count}** serveur configuré(s)). Réessayez plus tard.',
  'findScrim.zeroDelivery': '⚠️ Aucune annonce n\'a pu être livrée sur **{count}** serveur(s) configuré(s) (permissions, salons ou blocages). Réessayez plus tard.',
  'findScrim.nombreDeGamesFormat': '❌ Le nombre de games ne peut être utilisé qu\'avec le format scrim série.',
  'findScrim.structureInvalid': '❌ La structure sélectionnée n\'est pas reconnue comme partenaire ScrimRéseau. Utilise l\'autocomplétion pour choisir une structure valide.',
  'findScrim.accessError': '❌ Impossible de vérifier l\'accès. Réessayez plus tard.',
  'findScrim.success': '✅ Ta recherche de scrim est en ligne sur le réseau !\n\n📡 Diffusée dans {count} serveurs\n\n🛑 Quand tu as trouvé un scrim :\n/scrim-close id:{id}\n\n💬 Pour ne plus recevoir de messages inutiles et garder les salons propres.\n\n💡 Astuce :\n\nPour éviter les problèmes de contact, pense à rejoindre le serveur ScrimRéseau :\n{url}\n👉 Cela crée un discord commun entre les joueurs.\n👉 Tu peux continuer à utiliser le bot normalement depuis ton serveur.',
  'findScrim.successPersistent': '✅ Ta recherche de scrim est en ligne.\n📡 Première diffusion confirmée. Publication en cours vers {targetCount} serveur(s).\n🛑 Quand tu as trouvé un scrim : /scrim-close id:{id}\n\n💡 Astuce :\n{url}',
  'findScrim.bootstrapZeroDelivery': '⚠️ Aucune destination disponible pour le moment ({targetCount} configurée(s)). Réessaie plus tard.',

  // ── /list-scrims ─────────────────────────────────────────────────────
  'listScrims.guildOnly': '❌ Cette commande doit être utilisée sur un serveur.',
  'listScrims.dateRequiredForTime': '❌ Indique une **date** pour filtrer sur les heures.',
  'listScrims.hourOrder': '❌ L\'heure de début doit être avant ou égale à l\'heure de fin.',
  'listScrims.none': 'ℹ️ Aucune recherche de scrim active ne correspond à ces critères.',
  'listScrims.header': 'Scrims actives trouvées : {total}',
  'listScrims.truncated': '\n\n20 résultats affichés sur {total}. Affine ta recherche si tu veux trouver plus précis.',
  'listScrims.seeMessage': 'Voir le message',
  'listScrims.fearlessYes': ' — Fearless : Oui',
  'listScrims.fearlessNo': ' — Fearless : Non',

  // ── /my-scrims ───────────────────────────────────────────────────────
  'myScrims.empty': 'ℹ️ Tu n\'as actuellement aucune recherche de scrim active.',
  'myScrims.embedTitle': '📋 Tes demandes de scrim actives',
  'myScrims.footerHint': 'Utilise /scrim-close id:XXX (1–{max}) pour fermer une recherche.',
  'myScrims.createdAt': 'créée {date}',
  'myScrims.error': '❌ Impossible de charger tes demandes pour le moment. Réessaie plus tard.',

  // ── /scrim-close ─────────────────────────────────────────────────────
  'scrimClose.error': '❌ Une erreur est survenue. Réessaie plus tard ou contacte un administrateur.',

  // ── lifecycle (scrimLifecycle.js) ────────────────────────────────────
  'lifecycle.tooMany': '❌ Trop de recherches actives actuellement. Réessaie dans quelques minutes.',
  'lifecycle.noActive': '❌ Aucune recherche active trouvée pour cet ID.',
  'lifecycle.notAuthor': '❌ Tu ne peux fermer que tes propres recherches.',
  'lifecycle.alreadyDone': '❌ Cette recherche est déjà terminée.',
  'lifecycle.okClose': '✅ Ta recherche de scrim a été marquée comme terminée.',

  // ── /scrim-moderation ────────────────────────────────────────────────
  'scrimModeration.blockBot': '❌ Vous ne pouvez pas bloquer le bot.',
  'scrimModeration.alreadyBlocked': 'ℹ️ **{tag}** est déjà bloqué pour les scrims sur ce serveur.',
  'scrimModeration.blockSuccess': '✅ Les annonces de **{tag}** ne seront plus diffusées sur ce serveur.',
  'scrimModeration.notBlocked': 'ℹ️ **{tag}** n\'était pas bloqué pour les scrims.',
  'scrimModeration.unblockSuccess': '✅ Les annonces de **{tag}** pourront à nouveau être diffusées sur ce serveur.',

  // ── /report-spam ─────────────────────────────────────────────────────
  'reportSpam.guildOnly': '❌ Cette commande doit être utilisée sur un serveur.',
  'reportSpam.adminOnly': '❌ Réservé aux administrateurs du serveur.',
  'reportSpam.selfReport': '❌ Tu ne peux pas te signaler toi-même.',
  'reportSpam.botReport': '❌ Tu ne peux pas signaler un bot.',
  'reportSpam.alreadyReported': '❌ Tu as déjà signalé ce joueur récemment. Réessaie dans quelques jours.',
  'reportSpam.alreadyBlacklisted': '❌ Ce joueur est déjà blacklist.',
  'reportSpam.noChannel': '❌ Salon de signalement non configuré (SPAM_REPORT_CHANNEL_ID).',
  'reportSpam.channelInaccessible': '❌ Le salon de modération configuré est inaccessible pour ce bot.',
  'reportSpam.modFail': '❌ Le signalement n\'a pas pu être transmis au salon de modération. Réessaie plus tard.',
  'reportSpam.success': '✅ Signalement envoyé.',
  'reportSpam.error': '❌ Erreur lors du signalement.',

  // ── /structure-link ──────────────────────────────────────────────────
  'structureLink.guildOnly': '❌ Cette commande ne peut être utilisée que dans un serveur.',
  'structureLink.setSuccess': '✅ Lien Discord de la structure enregistré.',
  'structureLink.removeSuccess': '✅ Lien Discord de la structure retiré.',
  'structureLink.removeNotFound': 'ℹ️ Aucun lien Discord n\'était configuré pour cette structure.',
  'structureLink.dbErrorSet': '❌ Une erreur est survenue lors de l\'enregistrement. Réessayez plus tard.',
  'structureLink.dbErrorRemove': '❌ Une erreur est survenue lors de la suppression. Réessayez plus tard.',

  // ── /scrim-config panel ───────────────────────────────────────────────
  'scrimConfig.adminOnly': '❌ Vous devez être administrateur pour utiliser cette commande.',
  'scrimConfig.guildOnly': '❌ Cette commande doit être utilisée sur un serveur.',
  'scrimConfig.accessError': '❌ Impossible de vérifier l\'accès à ce moment. Réessayez plus tard.',
  'scrimConfig.readConfigError': '❌ Impossible de lire la configuration. Réessayez plus tard.',
  'scrimConfig.panelClosed': '✅ Panneau fermé.',
  'scrimConfig.panelExpired': '⏰ Le panneau a expiré.',
  'scrimConfig.noPermissions': '❌ Vous n\'avez plus les permissions nécessaires.',
  'scrimConfig.genericError': '❌ Une erreur est survenue.',
  // Main embed
  'scrimConfig.mainTitle': '⚙️ Configuration ScrimRéseau',
  'scrimConfig.mainDescription': 'Utilisez les boutons pour modifier la configuration de ce serveur.',
  'scrimConfig.fieldReception': '📢 Salon des annonces',
  'scrimConfig.fieldCommand': '📝 Salon des commandes',
  'scrimConfig.fieldPerms': '🔑 Permissions /find-scrim',
  'scrimConfig.fieldMessages': '💬 Messages inactifs',
  'scrimConfig.notConfigured': '*Non configuré*',
  'scrimConfig.allChannels': '*Tous les salons*',
  'scrimConfig.permEveryone': 'Tout le monde',
  'scrimConfig.permRolesNone': 'Rôles spécifiques *(aucun rôle configuré)*',
  'scrimConfig.permRoles': 'Rôles : {list}',
  'scrimConfig.policyDelete': 'Supprimer automatiquement',
  'scrimConfig.policyKeep': 'Garder et marquer',
  // Buttons (main)
  'scrimConfig.btnSalons': '📢 Salons',
  'scrimConfig.btnPerms': '🔑 Permissions',
  'scrimConfig.btnMsgs': '💬 Messages',
  'scrimConfig.btnReset': '🔄 Réinitialiser',
  'scrimConfig.btnClose': '✖ Fermer',
  'scrimConfig.btnBack': '← Retour',
  // Salons embed
  'scrimConfig.salonsTitle': '📢 Configuration — Salons',
  'scrimConfig.salonsFieldReception': 'Salon des annonces',
  'scrimConfig.salonsFieldCommand': 'Salon des commandes',
  'scrimConfig.salonsDescLine1': '**Salon des annonces** — où sont publiées les recherches de scrim.',
  'scrimConfig.salonsDescLine2': '**Salon des commandes** — où `/find-scrim` peut être utilisée.',
  // Salons buttons
  'scrimConfig.btnRemoveReception': 'Retirer le salon des annonces',
  'scrimConfig.btnAllChannels': 'Autoriser les commandes partout',
  // Salons placeholders
  'scrimConfig.placeholderReception': 'Choisir le salon des annonces scrim',
  'scrimConfig.placeholderCommand': 'Restreindre /find-scrim à un salon',
  // Salons status messages
  'scrimConfig.chanAnnSet': '✅ Salon des annonces configuré : {channel}',
  'scrimConfig.chanAnnNotFound': '❌ Salon introuvable.',
  'scrimConfig.chanAnnRemoved': '✅ Salon des annonces retiré.',
  'scrimConfig.chanAnnNone': 'ℹ️ Aucun salon d\'annonces n\'était configuré.',
  'scrimConfig.chanCmdSet': '✅ Salon des commandes configuré : {channel}',
  'scrimConfig.chanCmdWrongType': '❌ Choisis un salon texte ou une annonce.',
  'scrimConfig.chanCmdRemoved': '✅ Les commandes sont maintenant autorisées partout.',
  // Perms embed
  'scrimConfig.permsTitle': '🔑 Configuration — Permissions',
  'scrimConfig.permsDesc': 'Sélectionnez les rôles autorisés à utiliser `/find-scrim` (max {max}).\nLa sélection **remplace** la liste actuelle.\nPour autoriser tout le monde, utilisez le bouton dédié.',
  'scrimConfig.permsFieldCurrent': 'Configuration actuelle',
  // Perms buttons
  'scrimConfig.btnAllEveryone': 'Autoriser tout le monde',
  // Perms placeholder
  'scrimConfig.placeholderRoles': 'Sélectionnez les rôles autorisés (1 à {max})',
  // Perms status
  'scrimConfig.rolesInvalidCount': '❌ Sélectionnez entre 1 et {max} rôles.',
  'scrimConfig.rolesSet': '✅ Permissions mises à jour : {roles}',
  'scrimConfig.everyoneSet': '✅ Tout le monde peut utiliser /find-scrim.',
  // Messages embed
  'scrimConfig.msgsTitle': '💬 Configuration — Messages inactifs',
  'scrimConfig.msgsDesc': 'Comportement des messages de scrims **terminés, expirés ou remplacés** sur ce serveur.',
  'scrimConfig.msgsFieldCurrent': 'Configuration actuelle',
  'scrimConfig.msgsPlaceholder': 'Choisir le comportement des messages inactifs',
  'scrimConfig.msgsPolicyKeepLabel': 'Garder et marquer les messages',
  'scrimConfig.msgsPolicyKeepDesc': 'Comportement par défaut',
  'scrimConfig.msgsPolicyDeleteLabel': 'Supprimer automatiquement',
  'scrimConfig.msgsPolicyDeleteDesc': 'Supprime les annonces de scrims terminés/remplacés',
  'scrimConfig.msgsPolicyInvalid': '❌ Valeur invalide.',
  'scrimConfig.msgsPolicySet': '✅ Politique mise à jour : **{policy}**',
  // Reset embed
  'scrimConfig.resetTitle': '🔄 Réinitialisation',
  'scrimConfig.resetDesc': 'Choisissez ce que vous souhaitez réinitialiser.\n**Attention** : la réinitialisation complète demande une confirmation.',
  'scrimConfig.resetBtnAnn': 'Salon annonces',
  'scrimConfig.resetBtnCmd': 'Salon commandes',
  'scrimConfig.resetBtnPerm': 'Permissions',
  'scrimConfig.resetBtnMsg': 'Messages',
  'scrimConfig.resetBtnAll': '⚠️ Tout réinitialiser',
  'scrimConfig.resetAnnDone': '✅ Salon des annonces réinitialisé.',
  'scrimConfig.resetCmdDone': '✅ Salon des commandes réinitialisé.',
  'scrimConfig.resetPermDone': '✅ Permissions réinitialisées (tout le monde).',
  'scrimConfig.resetMsgDone': '✅ Politique des messages réinitialisée.',
  'scrimConfig.resetAllDone': '✅ Configuration entièrement réinitialisée.',
  // Reset confirm
  'scrimConfig.resetConfirmTitle': '⚠️ Confirmer la réinitialisation complète ?',
  'scrimConfig.resetConfirmDesc': 'Cette action va **supprimer toute la configuration** de ce serveur :\n- Salon des annonces\n- Salon des commandes\n- Permissions\n- Politique des messages\n\n**Cette action est irréversible. Confirmez-vous ?**',
  'scrimConfig.resetConfirmOk': '✅ Confirmer',
  'scrimConfig.resetConfirmCancel': '❌ Annuler',

  // ── /help-scrim ──────────────────────────────────────────────────────
  'help.title': '🎮 ScrimRéseau — Aide',
  'help.findTitle': '📢 Trouver un scrim',
  'help.findValue': '`/find-scrim` → publie une recherche de scrim dans le réseau\n`/list-scrims` → affiche les scrims actuellement disponibles selon tes filtres',
  'help.manageTitle': '📌 Gérer tes scrims',
  'help.manageValue': '`/my-scrims` → affiche tes demandes de scrim en cours\n`/scrim-close` → ferme une de tes demandes quand tu as trouvé un scrim',
  'help.tipTitle': '💡 Astuce',
  'help.tipValue': 'Les scrims expirent automatiquement une fois la date/heure dépassée, et les messages sont ensuite nettoyés pour garder les salons lisibles.',

  // ── /helpadmin-scrim ──────────────────────────────────────────────────
  'helpAdmin.title': '🛠️ ScrimRéseau — Aide Admin',
  'helpAdmin.description': 'Configuration et modération du réseau de scrims pour votre serveur.',
  'helpAdmin.scrimConfigTitle': '⚙️ /scrim-config',
  'helpAdmin.scrimConfigValue': 'Ouvre le panneau de configuration interactif ScrimRéseau.\n\n**📢 Salons** — salon des annonces (diffusion scrims) et salon des commandes (`/find-scrim`).\n\n**🔑 Permissions** — rôles autorisés à utiliser `/find-scrim`, ou tout le monde.\n\n**💬 Messages** — comportement des messages de scrims terminés ou remplacés (garder / supprimer).\n\n**🔄 Réinitialiser** — réinitialise un paramètre ou toute la configuration (confirmation requise).\n\nLe panneau est éphémère, interactif, et expire après 10 minutes.',
  'helpAdmin.moderationTitle': '🛡️ /scrim-moderation',
  'helpAdmin.moderationValue': 'Modération locale des scrims :\n\n**• user → bloquer**\nEmpêche un utilisateur d\'utiliser les scrims sur ce serveur.\n\n**• user → débloquer**\nRéautorise un utilisateur.',
  'helpAdmin.reportSpamTitle': '🚨 /report-spam',
  'helpAdmin.reportSpamValue': 'Commande admin pour signaler un joueur pour spam de scrims.\n\nLe bot applique des vérifications :\n- impossible de se signaler soi-même\n- impossible de signaler un bot\n- protections anti-abus',
  'helpAdmin.practicesTitle': '⚠️ Bonnes pratiques',
  'helpAdmin.practicesValue': '- Vérifiez que le bot peut envoyer **et** modifier ses messages\n- Évitez de supprimer les messages du bot sauf nécessité\n- Gardez un seul salon scrim propre et lisible\n- Utilisez `/scrim-config` pour vérifier et ajuster la configuration',
  'helpAdmin.tipTitle': '💡 Conseil',
  'helpAdmin.tipValue': 'Un bon setup = un salon clair + permissions bien définies',

  // ── Embed scrim (broadcast / lifecycle) ─────────────────────────────
  'embed.joinServerButton': '🔗 Rejoindre le serveur ScrimRéseau',
  'embed.contactHint1': '⚠️ Si la mention du contact ci-dessus n\'est pas cliquable',
  'embed.contactHint2': '👉 Rejoignez le serveur ScrimRéseau avec le bouton ci-dessous',
  'embed.contactHint3': '👉 Cela permet généralement de rendre la mention cliquable',
  'embed.fearlessOui': 'Fearless : Oui',
  'embed.fearlessNon': 'Fearless : Non',
  'embed.fearlessNimporte': 'Fearless : N\'importe',
  'embed.structureLabel': '🌐 Structure : {name}',
  'embed.structureLabelLinked': '🌐 Structure : [{safeName}]({url})',
  'embed.unknownTime': 'Heure inconnue',

  // ── Gate réception scrims ────────────────────────────────────────────
  'gate.refusalBody': '🔒 La réception des scrims ScrimRéseau est activée manuellement afin de garder un réseau propre et actif.\n\nPour demander l\'accès :\n• ouvrez un ticket sur le Discord ScrimRéseau\n• envoyez le lien de votre serveur\n• indiquez le salon prévu pour les scrims\n\nUne fois validé, votre serveur pourra recevoir automatiquement les scrims du réseau directement chez vous 🙂',

  // ── Gate serveur public ScrimRéseau ──────────────────────────────────
  'publicGate.refusal': 'Bonjour, pour utiliser cette commande, tu dois être présent sur le Discord ScrimRéseau : {url}\n\nUne fois dedans, tu pourras faire tes recherches depuis ton propre serveur. Cela permet aux autres joueurs de pouvoir te retrouver et te contacter plus facilement pour organiser les scrims.\n\nLes autres commandes du bot restent disponibles.',

  // ── Restrictions salon / permissions ────────────────────────────────
  'restrictions.wrongChannel': '❌ Tu ne peux pas utiliser cette commande dans ce salon.',
  'restrictions.noPermission': '❌ Tu n\'as pas la permission d\'utiliser cette commande.',
  'restrictions.configError': '❌ Impossible de vérifier la configuration du serveur. Réessayez plus tard.',

  // ── Liste query (formatListeScrimLine) ───────────────────────────────
  'listeQuery.fearlessYes': ' — Fearless : Oui',
  'listeQuery.fearlessNo': ' — Fearless : Non',
  'listeQuery.seeMessage': 'Voir le message',
  'listeQuery.at': ' à ',

  // ── Validation (codes d'erreur stables, utilisés par les handlers) ──
  'validation.date.not_string': '❌ La date doit être une chaîne de caractères.',
  'validation.date.required': '❌ La date est obligatoire.',
  'validation.date.invalid_format': '❌ Format de date invalide. Utilisez JJ/MM, JJ-MM ou JJ/MM/AAAA.',
  'validation.date.invalid_numbers': '❌ La date contient des nombres invalides.',
  'validation.date.invalid_year': '❌ Année invalide (attendu entre 2000 et 2100).',
  'validation.date.invalid_month': '❌ Mois invalide (1\u201312).',
  'validation.date.invalid_day': '❌ Jour invalide.',
  'validation.date.invalid_calendar': '❌ Date invalide (jour ou mois incorrect).',
  'validation.date.past': '❌ La date choisie ne peut pas être antérieure à aujourd\u2019hui.',
  'validation.date.window': '❌ La date choisie doit être comprise entre aujourd\u2019hui et les 30 prochains jours.',
  'validation.time.not_string': '❌ L\u2019heure doit être une chaîne de caractères.',
  'validation.time.required': '❌ L\u2019heure est obligatoire.',
  'validation.time.invalid_hour': '❌ Heure invalide (0\u201323).',
  'validation.time.invalid_hours': '❌ Heures invalides (0\u201323).',
  'validation.time.invalid_minutes': '❌ Minutes invalides (0\u201359).',
  'validation.time.invalid_format': '❌ Format d\u2019heure invalide. Ex.\u00a0: 20:30, 20h30, 20h.',
  'validation.time.flex_parse_error': '❌ Heure de début ou heure max invalide.',
  'validation.time.flex_before_start': '❌ L\u2019heure max doit être strictement après l\u2019heure de début.',
  'validation.time.flex_max_span': '❌ L\u2019écart entre l\u2019heure de début et l\u2019heure max ne peut pas dépasser 12 heures.',
  'validation.rank.unknown_game': '❌ Jeu inconnu.',
  'validation.rank.required': '❌ Le rang est obligatoire.',
  'validation.rank.invalid': '❌ Le rang sélectionné ne correspond pas au jeu choisi. Merci de sélectionner un rang valide pour ce jeu.',
  'validation.format.unknown_game': '❌ Jeu inconnu.',
  'validation.format.required': '❌ Le format est obligatoire.',
  'validation.format.invalid': '❌ Le format sélectionné ne correspond pas au jeu choisi. Merci de sélectionner un format valide pour ce jeu.',
  'validation.contact.missing': '❌ Contact Discord invalide (utilisateur manquant).',
  'validation.contact.bot': '❌ Le contact ne peut pas être un bot.',
  'validation.discordUrl.invalid': '❌ Merci d\u2019indiquer un lien d\u2019invitation Discord valide (ex. https://discord.gg/xxxx).',
  'validation.multiOpgg.wrong_game': '❌ Le champ multi OP.GG est disponible uniquement pour League of Legends.',
  'validation.multiOpgg.invalid': '❌ Le lien multi OP.GG est invalide. Merci de fournir une URL HTTPS valide provenant uniquement de op.gg.',

  // ── myScrims date format ─────────────────────────────────────────────
  'myScrims.createdAtFormat': "dd/MM/yyyy HH'h'mm",

  // ── Rangs LoL (affichage localisé) ───────────────────────────────────
  // Ces clés ne sont utilisées que si le projet traduit les rangs à l'affichage.
  // Les valeurs en DB restent inchangées (Fer, Argent, etc.).
  'rank.fer': 'Fer',
  'rank.bronze': 'Bronze',
  'rank.argent': 'Argent',
  'rank.or': 'Or',
  'rank.platine': 'Platine',
  'rank.emeraude': 'Émeraude',
  'rank.diamant': 'Diamant',
  'rank.master': 'Master',
  'rank.grandmaster': 'Grandmaster',
  'rank.challenger': 'Challenger',
  'rank.mix': 'Mix niveau',
};
