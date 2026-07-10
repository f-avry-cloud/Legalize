'use strict';

require('../src/demo-seed').seedIfEmpty()
  .then((seeded) => {
    console.log(seeded
      ? 'Seed terminé : Groupe Horizon (3 sociétés), 2 opérations, 1 devis.'
      : 'Base non vide — seed ignoré.');
  })
  .catch((e) => {
    console.error('Échec du seed :', e.message);
    process.exit(1);
  });
