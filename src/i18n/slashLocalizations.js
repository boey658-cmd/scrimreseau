/**
 * BOT-I18N-D — métadonnées Discord slash (descriptions / option names / choices).
 *
 * Séparation importante :
 *  - Localizations Discord → locale client Discord (affichage slash)
 *  - Langue bot runtime → ENABLED_GUILD_LOCALES via getGuildLocale (réponses)
 *  Ne jamais brancher interaction.locale sur les réponses bot ici.
 *
 * Codes Discord API utilisés (Locale discord.js) :
 *  fr, en-US, en-GB, es-ES, de, it, pl, pt-BR
 *
 * Note pt : Discord n’expose PAS `pt-PT` — seul `pt-BR` est valide.
 * Les textes `pt` ci-dessous restent en pt-PT (européen) et sont servis sous `pt-BR`.
 *
 * Stratégie noms de commandes :
 *  pas de nameLocalizations sur les commandes publiques (stabilité communauté).
 *  Priorité : description + options (+ choices).
 */

import { Locale } from 'discord.js';

/** Locales Discord réellement envoyées dans les payloads slash. */
export const DISCORD_SLASH_LOCALE_CODES = Object.freeze([
  Locale.French, // fr
  Locale.EnglishUS, // en-US
  Locale.EnglishGB, // en-GB
  Locale.SpanishES, // es-ES
  Locale.German, // de
  Locale.Italian, // it
  Locale.Polish, // pl
  Locale.PortugueseBR, // pt-BR (pas de pt-PT côté Discord)
]);

/**
 * @typedef {{
 *   fr: string,
 *   en: string,
 *   es: string,
 *   de: string,
 *   it: string,
 *   pl: string,
 *   pt: string,
 * }} SlashText7
 */

/**
 * Tuple compact [fr, en, es, de, it, pl, pt].
 * @param {[string, string, string, string, string, string, string]} parts
 * @returns {SlashText7}
 */
export function L(parts) {
  const [fr, en, es, de, it, pl, pt] = parts;
  return { fr, en, es, de, it, pl, pt };
}

/**
 * Convertit un texte 7 locales bot → map Discord API.
 * @param {SlashText7} texts
 * @returns {Record<string, string>}
 */
export function discordLocalizations(texts) {
  return {
    [Locale.French]: texts.fr,
    [Locale.EnglishUS]: texts.en,
    [Locale.EnglishGB]: texts.en,
    [Locale.SpanishES]: texts.es,
    [Locale.German]: texts.de,
    [Locale.Italian]: texts.it,
    [Locale.Polish]: texts.pl,
    [Locale.PortugueseBR]: texts.pt,
  };
}

/**
 * Applique description globale EN + localizations 7 langues.
 * @template {import('discord.js').SharedNameAndDescription} T
 * @param {T} target
 * @param {SlashText7} texts
 * @returns {T}
 */
export function applyDescriptionLocalizations(target, texts) {
  target.setDescription(texts.en);
  target.setDescriptionLocalizations(discordLocalizations(texts));
  return target;
}

/**
 * @param {import('discord.js').ApplicationCommandOptionBase} opt
 * @param {{ name?: SlashText7, description: SlashText7 }} meta
 */
export function applyOptionLocalizations(opt, meta) {
  opt.setDescription(meta.description.en);
  opt.setDescriptionLocalizations(discordLocalizations(meta.description));
  if (meta.name) {
    opt.setNameLocalizations(discordLocalizations(meta.name));
  }
  return opt;
}

/**
 * Choice Discord avec labels localisés (value métier inchangée).
 * @param {string} value
 * @param {SlashText7} names  name global = EN
 * @returns {{ name: string, value: string, name_localizations: Record<string, string> }}
 */
export function localizedChoice(value, names) {
  return {
    name: names.en,
    value,
    name_localizations: discordLocalizations(names),
  };
}

// ---------------------------------------------------------------------------
// Métadonnées par commande
// ---------------------------------------------------------------------------

export const slashMeta = Object.freeze({
  findScrim: {
    description: L([
      'Diffuse une recherche de scrim sur le réseau ScrimRéseau.',
      'Broadcast a scrim search on the ScrimRéseau network.',
      'Difunde una búsqueda de scrim en la red ScrimRéseau.',
      'Veröffentliche eine Scrim-Suche im ScrimRéseau-Netzwerk.',
      'Diffondi una ricerca scrim sulla rete ScrimRéseau.',
      'Opublikuj poszukiwanie scrima w sieci ScrimRéseau.',
      'Difunde uma procura de scrim na rede ScrimRéseau.',
    ]),
    options: {
      rang: {
        name: L(['rang', 'rank', 'rango', 'rang', 'grado', 'ranga', 'classificação']),
        description: L([
          'Rang League of Legends (saisie ou sélection).',
          'League of Legends rank (type or select).',
          'Rango de League of Legends (escribe o elige).',
          'League-of-Legends-Rang (eingeben oder wählen).',
          'Rank di League of Legends (digita o seleziona).',
          'Ranga League of Legends (wpisz lub wybierz).',
          'Rank de League of Legends (escreve ou escolhe).',
        ]),
      },
      date: {
        name: L(['date', 'date', 'fecha', 'datum', 'data', 'data', 'data']),
        description: L([
          'Date du scrim (ex. 23/03 ou 23/03/2026).',
          'Scrim date (e.g. 23/03 or 23/03/2026).',
          'Fecha del scrim (ej. 23/03 o 23/03/2026).',
          'Scrim-Datum (z. B. 23/03 oder 23/03/2026).',
          'Data dello scrim (es. 23/03 o 23/03/2026).',
          'Data scrima (np. 23/03 lub 23/03/2026).',
          'Data do scrim (ex. 23/03 ou 23/03/2026).',
        ]),
      },
      heure: {
        name: L(['heure', 'time', 'hora', 'uhrzeit', 'ora', 'godzina', 'hora']),
        description: L([
          'Heure de début (ex. 20:30 ou 20h).',
          'Scrim start time (e.g. 20:30 or 20h).',
          'Hora de inicio (ej. 20:30 o 20h).',
          'Startzeit (z. B. 20:30 oder 20 Uhr).',
          'Ora di inizio (es. 20:30 o 20h).',
          'Godzina startu (np. 20:30 lub 20:00).',
          'Hora de início (ex. 20:30 ou 20h).',
        ]),
      },
      contact: {
        name: L(['contact', 'contact', 'contacto', 'kontakt', 'contatto', 'kontakt', 'contacto']),
        description: L([
          'Joueur à contacter pour organiser le scrim.',
          'Contact user for organizing the scrim.',
          'Usuario de contacto para organizar el scrim.',
          'Kontaktperson zur Organisation des Scrims.',
          'Utente di contatto per organizzare lo scrim.',
          'Osoba kontaktowa do organizacji scrima.',
          'Utilizador de contacto para organizar o scrim.',
        ]),
      },
      format: {
        name: L(['format', 'format', 'formato', 'format', 'formato', 'format', 'formato']),
        description: L([
          'Format du match (ex. BO1, BO3).',
          'Match format (e.g. BO1, BO3).',
          'Formato de la partida (ej. BO1, BO3).',
          'Matchformat (z. B. BO1, BO3).',
          'Formato della partita (es. BO1, BO3).',
          'Format meczu (np. BO1, BO3).',
          'Formato do jogo (ex. BO1, BO3).',
        ]),
      },
      fearless: {
        name: L(['fearless', 'fearless', 'fearless', 'fearless', 'fearless', 'fearless', 'fearless']),
        description: L([
          'Activer le draft Fearless.',
          'Enable Fearless draft pick mode.',
          'Activar el draft Fearless.',
          'Fearless-Draft aktivieren.',
          'Attiva il draft Fearless.',
          'Włącz draft Fearless.',
          'Ativar o draft Fearless.',
        ]),
      },
      elo_precision: {
        name: L([
          'elo_precision',
          'elo_precision',
          'precision_elo',
          'elo_praezision',
          'precisione_elo',
          'precyzja_elo',
          'precisao_elo',
        ]),
        description: L([
          'Précision d’Elo optionnelle (ex. Low, High, 500–599 LP).',
          'Optional Elo precision (e.g. Low, High, 500–599 LP).',
          'Precisión de Elo opcional (ej. Low, High, 500–599 LP).',
          'Optionale Elo-Angabe (z. B. Low, High, 500–599 LP).',
          'Precisione Elo opzionale (es. Low, High, 500–599 LP).',
          'Opcjonalna precyzja Elo (np. Low, High, 500–599 LP).',
          'Precisão de Elo opcional (ex. Low, High, 500–599 LP).',
        ]),
      },
      heure_max_debut: {
        name: L([
          'heure_max_debut',
          'latest_start',
          'hora_max_inicio',
          'spaetester_start',
          'inizio_max',
          'najpozniejszy_start',
          'hora_max_inicio',
        ]),
        description: L([
          'Heure de début max si flexible.',
          'Latest possible start time if flexible.',
          'Hora máxima de inicio si eres flexible.',
          'Späteste Startzeit, falls flexibel.',
          'Ultimo orario di inizio se flessibile.',
          'Najpóźniejsza godzina startu przy elastyczności.',
          'Hora máxima de início se fores flexível.',
        ]),
      },
      multi_opgg: {
        name: L([
          'multi_opgg',
          'multi_opgg',
          'multi_opgg',
          'multi_opgg',
          'multi_opgg',
          'multi_opgg',
          'multi_opgg',
        ]),
        description: L([
          'Lien HTTPS vers une page Multi-OP.GG.',
          'HTTPS link to a Multi-OP.GG page.',
          'Enlace HTTPS a una página Multi-OP.GG.',
          'HTTPS-Link zu einer Multi-OP.GG-Seite.',
          'Link HTTPS a una pagina Multi-OP.GG.',
          'Link HTTPS do strony Multi-OP.GG.',
          'Link HTTPS para uma página Multi-OP.GG.',
        ]),
      },
      structure: {
        name: L([
          'structure',
          'structure',
          'estructura',
          'struktur',
          'struttura',
          'struktura',
          'estrutura',
        ]),
        description: L([
          'Ta structure partenaire ScrimRéseau.',
          'Select your ScrimRéseau partner structure.',
          'Tu estructura asociada de ScrimRéseau.',
          'Deine ScrimRéseau-Partnerstruktur.',
          'La tua struttura partner ScrimRéseau.',
          'Twoja partnerska struktura ScrimRéseau.',
          'A tua estrutura parceira ScrimRéseau.',
        ]),
      },
      nombre_de_games: {
        name: L([
          'nombre_de_games',
          'game_count',
          'numero_de_partidas',
          'anzahl_spiele',
          'numero_partite',
          'liczba_gier',
          'numero_de_jogos',
        ]),
        description: L([
          'Nombre de games (formats série uniquement).',
          'Number of games (series format only).',
          'Número de partidas (solo formato serie).',
          'Anzahl der Spiele (nur Serienformat).',
          'Numero di partite (solo formato serie).',
          'Liczba gier (tylko format serii).',
          'Número de jogos (apenas formato de série).',
        ]),
      },
    },
    choices: {
      fearlessOui: L(['Oui', 'Yes', 'Sí', 'Ja', 'Sì', 'Tak', 'Sim']),
      fearlessNon: L(['Non', 'No', 'No', 'Nein', 'No', 'Nie', 'Não']),
      fearlessAny: L([
        'N’importe',
        'Any',
        'Cualquiera',
        'Egal',
        'Qualsiasi',
        'Dowolny',
        'Qualquer',
      ]),
      eloNone: L([
        'Non précisé',
        'Not specified',
        'Sin especificar',
        'Nicht angegeben',
        'Non specificato',
        'Nie określono',
        'Não especificado',
      ]),
      elo900: L([
        '900 LP et plus',
        '900+ LP',
        '900+ LP',
        '900+ LP',
        '900+ LP',
        '900+ LP',
        '900+ LP',
      ]),
    },
  },

  helpScrim: {
    description: L([
      'Affiche l’aide ScrimRéseau.',
      'Show ScrimRéseau help.',
      'Muestra la ayuda de ScrimRéseau.',
      'Zeigt die ScrimRéseau-Hilfe.',
      'Mostra la guida ScrimRéseau.',
      'Pokaż pomoc ScrimRéseau.',
      'Mostra a ajuda do ScrimRéseau.',
    ]),
  },

  helpAdminScrim: {
    description: L([
      'Affiche l’aide d’administration ScrimRéseau.',
      'Show ScrimRéseau administration help.',
      'Muestra la ayuda de administración de ScrimRéseau.',
      'Zeigt die ScrimRéseau-Admin-Hilfe.',
      'Mostra la guida admin ScrimRéseau.',
      'Pokaż pomoc administracyjną ScrimRéseau.',
      'Mostra a ajuda de administração do ScrimRéseau.',
    ]),
  },

  listScrims: {
    description: L([
      'Liste les recherches de scrim actives.',
      'List active scrim searches.',
      'Lista las búsquedas de scrim activas.',
      'Listet aktive Scrim-Suchen auf.',
      'Elenca le ricerche scrim attive.',
      'Wyświetl aktywne poszukiwania scrimów.',
      'Lista as procuras de scrim ativas.',
    ]),
    options: {
      elo: {
        name: L(['elo', 'elo', 'elo', 'elo', 'elo', 'elo', 'elo']),
        description: L([
          'Filtrer par rang.',
          'Filter by rank.',
          'Filtrar por rango.',
          'Nach Rang filtern.',
          'Filtra per rank.',
          'Filtruj według rangi.',
          'Filtrar por rank.',
        ]),
      },
      date: {
        name: L(['date', 'date', 'fecha', 'datum', 'data', 'data', 'data']),
        description: L([
          'Filtrer par date (JJ/MM ou JJ/MM/AAAA).',
          'Filter by date (DD/MM or DD/MM/YYYY).',
          'Filtrar por fecha (DD/MM o DD/MM/AAAA).',
          'Nach Datum filtern (TT/MM oder TT/MM/JJJJ).',
          'Filtra per data (GG/MM o GG/MM/AAAA).',
          'Filtruj według daty (DD/MM lub DD/MM/RRRR).',
          'Filtrar por data (DD/MM ou DD/MM/AAAA).',
        ]),
      },
      heure_debut: {
        name: L([
          'heure_debut',
          'start_time',
          'hora_inicio',
          'startzeit',
          'ora_inizio',
          'godzina_od',
          'hora_inicio',
        ]),
        description: L([
          'Heure de début minimale (nécessite une date).',
          'Minimum start time (requires date).',
          'Hora de inicio mínima (requiere fecha).',
          'Minimale Startzeit (Datum erforderlich).',
          'Ora di inizio minima (richiede data).',
          'Minimalna godzina startu (wymaga daty).',
          'Hora de início mínima (requer data).',
        ]),
      },
      heure_fin: {
        name: L([
          'heure_fin',
          'end_time',
          'hora_fin',
          'endzeit',
          'ora_fine',
          'godzina_do',
          'hora_fim',
        ]),
        description: L([
          'Heure de début maximale (nécessite une date).',
          'Maximum start time (requires date).',
          'Hora de inicio máxima (requiere fecha).',
          'Maximale Startzeit (Datum erforderlich).',
          'Ora di inizio massima (richiede data).',
          'Maksymalna godzina startu (wymaga daty).',
          'Hora de início máxima (requer data).',
        ]),
      },
    },
  },

  myScrims: {
    description: L([
      'Affiche tes recherches de scrim actives.',
      'Show your active scrim searches.',
      'Muestra tus búsquedas de scrim activas.',
      'Zeigt deine aktiven Scrim-Suchen.',
      'Mostra le tue ricerche scrim attive.',
      'Pokaż swoje aktywne poszukiwania scrimów.',
      'Mostra as tuas procuras de scrim ativas.',
    ]),
  },

  scrimClose: {
    description: L([
      'Ferme une de tes recherches de scrim actives.',
      'Close one of your active scrim searches.',
      'Cierra una de tus búsquedas de scrim activas.',
      'Schließe eine deiner aktiven Scrim-Suchen.',
      'Chiudi una delle tue ricerche scrim attive.',
      'Zamknij jedno ze swoich aktywnych poszukiwań scrimów.',
      'Fecha uma das tuas procuras de scrim ativas.',
    ]),
    /**
     * @param {number} max
     * @returns {{ name?: SlashText7, description: SlashText7 }}
     */
    idOption(max) {
      return {
        name: L(['id', 'id', 'id', 'id', 'id', 'id', 'id']),
        description: L([
          `Identifiant public de ta recherche (1–${max}).`,
          `Your scrim search public ID (1–${max}).`,
          `ID público de tu búsqueda (1–${max}).`,
          `Öffentliche ID deiner Suche (1–${max}).`,
          `ID pubblico della tua ricerca (1–${max}).`,
          `Publiczne ID twojego poszukiwania (1–${max}).`,
          `ID público da tua procura (1–${max}).`,
        ]),
      };
    },
  },

  scrimConfig: {
    description: L([
      'Configure ScrimRéseau pour ce serveur.',
      'Configure ScrimRéseau for this server.',
      'Configura ScrimRéseau para este servidor.',
      'Konfiguriere ScrimRéseau für diesen Server.',
      'Configura ScrimRéseau per questo server.',
      'Skonfiguruj ScrimRéseau dla tego serwera.',
      'Configura o ScrimRéseau para este servidor.',
    ]),
  },

  scrimModeration: {
    description: L([
      'Gère les utilisateurs bloqués pour les scrims sur ce serveur.',
      'Manage blocked scrim users for this server.',
      'Gestiona usuarios bloqueados de scrims en este servidor.',
      'Verwalte gesperrte Scrim-Nutzer auf diesem Server.',
      'Gestisci gli utenti bloccati dagli scrim su questo server.',
      'Zarządzaj zablokowanymi użytkownikami scrimów na tym serwerze.',
      'Gere utilizadores bloqueados de scrims neste servidor.',
    ]),
    subUser: {
      description: L([
        'Bloquer ou débloquer les annonces scrim d’un utilisateur.',
        "Block or unblock a user's scrim announcements on this server.",
        'Bloquear o desbloquear los anuncios de scrim de un usuario.',
        'Scrim-Ankündigungen eines Nutzers sperren oder entsperren.',
        'Blocca o sblocca gli annunci scrim di un utente.',
        'Zablokuj lub odblokuj ogłoszenia scrim użytkownika.',
        'Bloquear ou desbloquear os anúncios de scrim de um utilizador.',
      ]),
    },
    options: {
      action: {
        name: L(['action', 'action', 'accion', 'aktion', 'azione', 'akcja', 'acao']),
        description: L([
          'Action à effectuer.',
          'Action to perform.',
          'Acción a realizar.',
          'Auszuführende Aktion.',
          'Azione da eseguire.',
          'Akcja do wykonania.',
          'Ação a executar.',
        ]),
      },
      utilisateur: {
        name: L([
          'utilisateur',
          'user',
          'usuario',
          'nutzer',
          'utente',
          'uzytkownik',
          'utilizador',
        ]),
        description: L([
          'Utilisateur à modérer.',
          'Select the user to moderate.',
          'Usuario a moderar.',
          'Zu moderierender Nutzer.',
          'Utente da moderare.',
          'Użytkownik do moderacji.',
          'Utilizador a moderar.',
        ]),
      },
    },
    choices: {
      block: L(['Bloquer', 'Block', 'Bloquear', 'Sperren', 'Blocca', 'Zablokuj', 'Bloquear']),
      unblock: L([
        'Débloquer',
        'Unblock',
        'Desbloquear',
        'Entsperren',
        'Sblocca',
        'Odblokuj',
        'Desbloquear',
      ]),
    },
  },

  reportSpam: {
    description: L([
      'Signale un utilisateur pour spam excessif de recherches.',
      'Report a user for excessive scrim search spam.',
      'Reporta a un usuario por spam excesivo de búsquedas.',
      'Melde einen Nutzer wegen übermäßigem Scrim-Spam.',
      'Segnala un utente per spam eccessivo di ricerche.',
      'Zgłoś użytkownika za nadmierny spam poszukiwań.',
      'Reporta um utilizador por spam excessivo de procuras.',
    ]),
    options: {
      user: {
        name: L(['user', 'user', 'usuario', 'nutzer', 'utente', 'uzytkownik', 'utilizador']),
        description: L([
          'Utilisateur à signaler.',
          'Select the user to report.',
          'Usuario a reportar.',
          'Zu meldender Nutzer.',
          'Utente da segnalare.',
          'Użytkownik do zgłoszenia.',
          'Utilizador a reportar.',
        ]),
      },
    },
  },

  language: {
    description: L([
      'Définit la langue ScrimRéseau pour ce serveur.',
      'Set the ScrimRéseau language for this server.',
      'Define el idioma de ScrimRéseau para este servidor.',
      'Legt die ScrimRéseau-Sprache für diesen Server fest.',
      'Imposta la lingua ScrimRéseau per questo server.',
      'Ustaw język ScrimRéseau dla tego serwera.',
      'Define o idioma do ScrimRéseau para este servidor.',
    ]),
    options: {
      language: {
        name: L([
          'language',
          'language',
          'idioma',
          'sprache',
          'lingua',
          'jezyk',
          'idioma',
        ]),
        description: L([
          'Langue utilisée par le bot sur ce serveur.',
          'Select the language used by the bot on this server.',
          'Idioma usado por el bot en este servidor.',
          'Sprache, die der Bot auf diesem Server nutzt.',
          'Lingua usata dal bot su questo server.',
          'Język używany przez bota na tym serwerze.',
          'Idioma usado pelo bot neste servidor.',
        ]),
      },
    },
    choices: {
      fr: L([
        'Français',
        'French',
        'Francés',
        'Französisch',
        'Francese',
        'Francuski',
        'Francês',
      ]),
      en: L([
        'English',
        'English',
        'Inglés',
        'Englisch',
        'Inglese',
        'Angielski',
        'Inglês',
      ]),
      es: L([
        'Español',
        'Spanish',
        'Español',
        'Spanisch',
        'Spagnolo',
        'Hiszpański',
        'Espanhol',
      ]),
      de: L([
        'Deutsch',
        'German',
        'Alemán',
        'Deutsch',
        'Tedesco',
        'Niemiecki',
        'Alemão',
      ]),
      it: L([
        'Italiano',
        'Italian',
        'Italiano',
        'Italienisch',
        'Italiano',
        'Włoski',
        'Italiano',
      ]),
      pl: L([
        'Polski',
        'Polish',
        'Polaco',
        'Polnisch',
        'Polacco',
        'Polski',
        'Polaco',
      ]),
      pt: L([
        'Português',
        'Portuguese',
        'Portugués',
        'Portugiesisch',
        'Portoghese',
        'Portugalski',
        'Português',
      ]),
    },
  },

  structureLink: {
    description: L([
      'Gère le lien Discord associé à une structure.',
      'Manage the Discord link associated with a structure.',
      'Gestiona el enlace de Discord asociado a una estructura.',
      'Verwalte den Discord-Link einer Struktur.',
      'Gestisci il link Discord associato a una struttura.',
      'Zarządzaj linkiem Discord powiązanym ze strukturą.',
      'Gere o link Discord associado a uma estrutura.',
    ]),
    subSet: {
      description: L([
        'Définit le lien d’invitation Discord de ta structure.',
        'Set the Discord invite link associated with your structure.',
        'Define el enlace de invitación de Discord de tu estructura.',
        'Lege den Discord-Einladungslink deiner Struktur fest.',
        'Imposta il link di invito Discord della tua struttura.',
        'Ustaw link zaproszenia Discord swojej struktury.',
        'Define o link de convite Discord da tua estrutura.',
      ]),
    },
    subRemove: {
      description: L([
        'Supprime le lien Discord associé à ta structure.',
        'Remove the Discord invite link associated with your structure.',
        'Elimina el enlace de Discord de tu estructura.',
        'Entferne den Discord-Link deiner Struktur.',
        'Rimuovi il link Discord della tua struttura.',
        'Usuń link Discord swojej struktury.',
        'Remove o link Discord da tua estrutura.',
      ]),
    },
    options: {
      lien: {
        name: L(['lien', 'link', 'enlace', 'link', 'link', 'link', 'link']),
        description: L([
          'Lien d’invitation Discord (ex. https://discord.gg/xxxx).',
          'Discord invite link (e.g. https://discord.gg/xxxx).',
          'Enlace de invitación de Discord (ej. https://discord.gg/xxxx).',
          'Discord-Einladungslink (z. B. https://discord.gg/xxxx).',
          'Link di invito Discord (es. https://discord.gg/xxxx).',
          'Link zaproszenia Discord (np. https://discord.gg/xxxx).',
          'Link de convite Discord (ex. https://discord.gg/xxxx).',
        ]),
      },
    },
  },

  // --- Dev / owner (localisés si raisonnable) ---
  scrimDev: {
    description: L([
      'Outils de modération globale du bot.',
      'Global bot moderation tools.',
      'Herramientas de moderación global del bot.',
      'Globale Moderationswerkzeuge des Bots.',
      'Strumenti di moderazione globale del bot.',
      'Globalne narzędzia moderacji bota.',
      'Ferramentas de moderação global do bot.',
    ]),
  },

  dashboardReseau: {
    description: L([
      'Initialise ou met à jour le dashboard réseau ScrimRéseau.',
      'Create or update the ScrimRéseau network dashboard.',
      'Inicializa o actualiza el panel de red ScrimRéseau.',
      'Erstellt oder aktualisiert das ScrimRéseau-Netzwerk-Dashboard.',
      'Inizializza o aggiorna il dashboard di rete ScrimRéseau.',
      'Utwórz lub zaktualizuj panel sieci ScrimRéseau.',
      'Inicializa ou atualiza o painel de rede ScrimRéseau.',
    ]),
    options: {
      salon: {
        name: L(['salon', 'channel', 'canal', 'kanal', 'canale', 'kanal', 'canal']),
        description: L([
          'Salon texte où poster le dashboard.',
          'Text channel where the dashboard is posted.',
          'Canal de texto donde publicar el panel.',
          'Textkanal für das Dashboard.',
          'Canale di testo dove pubblicare il dashboard.',
          'Kanał tekstowy, w którym opublikować panel.',
          'Canal de texto onde publicar o painel.',
        ]),
      },
    },
  },

  dashboardAdmin: {
    description: L([
      'Gestion des dashboards réseau ScrimRéseau (owner only).',
      'Manage ScrimRéseau network dashboards (owner only).',
      'Gestión de paneles de red ScrimRéseau (solo owner).',
      'Verwaltung der ScrimRéseau-Netzwerk-Dashboards (nur Owner).',
      'Gestione dei dashboard di rete ScrimRéseau (solo owner).',
      'Zarządzanie panelami sieci ScrimRéseau (tylko owner).',
      'Gestão dos painéis de rede ScrimRéseau (apenas owner).',
    ]),
  },

  scrimChannel: {
    description: L([
      'Dev only — retire une destination de réception scrim par IDs.',
      'Dev only — remove a scrim reception destination by guild/channel ID.',
      'Solo dev — elimina un destino de recepción de scrim por IDs.',
      'Nur Dev — Scrim-Empfangsziel per Guild-/Kanal-ID entfernen.',
      'Solo dev — rimuovi una destinazione di ricezione scrim per ID.',
      'Tylko dev — usuń miejsce odbioru scrimów po ID.',
      'Só dev — remove um destino de receção de scrim por IDs.',
    ]),
  },
});
