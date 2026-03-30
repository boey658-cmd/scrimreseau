import { help } from './help.js';
import { helpAdmin } from './helpAdmin.js';
import { listeScrims } from './listeScrims.js';
import { mesDemandes } from './mesDemandes.js';
import { rechercheScrim } from './rechercheScrim.js';
import { spammer } from './spammer.js';
import { scrimConfig } from './scrimConfig.js';
import { scrimDev } from './scrimDev.js';
import { scrimModeration } from './scrimModeration.js';
import { scrimTrouve } from './scrimTrouve.js';

/** Commandes déployées partout (global ou guildes non-dev), sans /scrim-dev. */
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
];

export { scrimDev };

/** Toutes les commandes (le bot doit résoudre /scrim-dev même si déployée seulement sur la guilde dev). */
export const commandList = [...commandListWithoutDev, scrimDev];
