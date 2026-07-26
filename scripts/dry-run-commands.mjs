import { commandListWithoutDev } from '../src/commands/index.js';

console.log('=== COMMANDES PUBLIQUES (' + commandListWithoutDev.length + ') ===');
commandListWithoutDev.forEach(c => {
  const d = c.data.toJSON();
  const req = (d.options || []).filter(o => o.required).map(o => o.name);
  const opt = (d.options || []).filter(o => !o.required).map(o => o.name);
  let line = '  ' + d.name;
  if (req.length) line += ' [required: ' + req.join(',') + ']';
  if (opt.length) line += ' [optional: ' + opt.join(',') + ']';
  console.log(line);
});

const allPublic = commandListWithoutDev.map(c => c.data.toJSON().name);
const dups = allPublic.filter((n, i) => allPublic.indexOf(n) !== i);
console.log('');
if (dups.length) console.log('DOUBLONS DETECTES: ' + dups.join(', '));
else console.log('Aucun doublon detecte.');

const oldNames = ['liste-scrims', 'mes-demandes-scrim', 'recherche-scrim', 'scrim-configurer', 'scrim-trouve', 'spammer', 'structure-lien'];
const found = oldNames.filter(n => allPublic.includes(n));
if (found.length) console.log('ANCIENS NOMS PRESENT: ' + found.join(', '));
else console.log('Aucun ancien nom present.');

let optOrderOk = true;
commandListWithoutDev.forEach(c => {
  const d = c.data.toJSON();
  let seenOptional = false;
  (d.options || []).forEach(o => {
    if (seenOptional && o.required) {
      console.log('ORDRE INVALIDE dans ' + d.name + ': required apres optional');
      optOrderOk = false;
    }
    if (!o.required) seenOptional = true;
  });
});
if (optOrderOk) console.log('Ordre required/optional correct dans toutes les commandes.');
