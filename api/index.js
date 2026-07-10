'use strict';

// Point d'entrée serverless (Vercel) : l'app Express gère /api/* ;
// les fichiers statiques de public/ sont servis par la plateforme.
module.exports = require('../server');
