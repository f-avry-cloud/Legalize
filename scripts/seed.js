'use strict';

const { seedIfEmpty } = require('../src/demo-seed');

console.log(seedIfEmpty()
  ? 'Seed terminé : Groupe Horizon (3 sociétés), 2 opérations, 1 devis.'
  : 'Base non vide — seed ignoré.');
