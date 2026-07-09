'use strict';

const path = require('path');
const express = require('express');

const routes = require('./src/routes');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', routes);

// Gestion d'erreurs centralisée (Express 5 propage les rejets async).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Erreur interne' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Legalize démarré sur http://localhost:${PORT}`);
  });
}

module.exports = app;
