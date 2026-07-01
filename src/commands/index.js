import { dashboardAdmin } from './dashboardAdmin.js';
import { dashboardReseau } from './dashboardReseau.js';
import { help } from './help.js';
import { helpAdmin } from './helpAdmin.js';
import { helpAdminJoueur } from './helpAdminJoueur.js';
import { helpJoueur } from './helpJoueur.js';
import { joueurConfig } from './joueurConfig.js';
import { joueurTrouve } from './joueurTrouve.js';
import { listeScrims } from './listeScrims.js';
import { mesDemandes } from './mesDemandes.js';
import { mesDemandesJoueur } from './mesDemandesJoueur.js';
import { rechercheJoueur } from './rechercheJoueur.js';
import { rechercheScrim } from './rechercheScrim.js';
import { spammer } from './spammer.js';
import { scrimConfig } from './scrimConfig.js';
import { scrimDev } from './scrimDev.js';
import { scrimModeration } from './scrimModeration.js';
import { scrimTrouve } from './scrimTrouve.js';

/** Commandes déployées partout (global ou guildes), sans commandes owner/dev. */
export const commandListWithoutDev = [
  scrimConfig,
  scrimModeration,
  listeScrims,
  help,
  helpAdmin,
  mesDemandes,
  rechercheScrim,
  scrimTrouve,
  spammer,
  joueurConfig,
  rechercheJoueur,
  joueurTrouve,
  mesDemandesJoueur,
  helpJoueur,
  helpAdminJoueur,
];

/** Commandes réservées à la guilde dev/owner (DEV_GUILD_ID). Invisibles ailleurs. */
export { dashboardAdmin, dashboardReseau, scrimDev };

/** Toutes les commandes (résolution runtime, y compris owner/dev). */
export const commandList = [...commandListWithoutDev, dashboardAdmin, dashboardReseau, scrimDev];
