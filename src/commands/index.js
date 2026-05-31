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

/** Commandes déployées partout (global ou guildes), sans /scrim-dev. */
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

export { scrimDev };

/** Toutes les commandes (résolution runtime, y compris dev-only). */
export const commandList = [...commandListWithoutDev, scrimDev];
