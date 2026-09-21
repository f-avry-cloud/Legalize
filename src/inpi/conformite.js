'use strict';

/**
 * Vérifie un payload contre le dictionnaire officiel du mandataire.
 *
 * Le guichet unique refuse en bloc, avec un message du genre « Le type de
 * "content.personneMorale.beneficiairesEffectifs[0].beneficiaireId" doit
 * correspondre à "string" ("int" fourni) ». Autant s'en apercevoir avant
 * l'envoi : ce module parcourt l'arbre émis en suivant les classes déclarées
 * et signale les propriétés inconnues comme les types qui ne collent pas.
 */

const { DICTIONNAIRE } = require('./referentiels');

/** Racine du champ `content` d'une formalité. */
const RACINE = 'Company';

/** `App\Entity\…\BlocAdresse` → `BlocAdresse` ; `Tableau de BlocPouvoir` → `BlocPouvoir`. */
function nomClasse(type) {
  if (!type) return null;
  const tableau = /^Tableau de (.+?)\[?\]?$/.exec(type);
  const brut = tableau ? tableau[1] : type;
  const court = brut.includes('\\') ? brut.split('\\').pop() : brut;
  return DICTIONNAIRE[court] ? court : null;
}

function estTableau(type) {
  return Boolean(type) && (type.startsWith('Tableau de') || type.endsWith('Collection'));
}

/** Le type JS effectivement transmis, dans le vocabulaire du dictionnaire. */
function typeJs(valeur) {
  if (typeof valeur === 'boolean') return 'bool';
  if (typeof valeur === 'number') return Number.isInteger(valeur) ? 'int' : 'float';
  if (typeof valeur === 'string') return 'string';
  if (Array.isArray(valeur)) return 'tableau';
  return 'objet';
}

function typeAccepte(attendu, valeur) {
  const recu = typeJs(valeur);
  switch (attendu) {
    case 'string':
    case 'DateTime':
      return recu === 'string';
    case 'int':
      return recu === 'int';
    // Un entier est un flottant valide : 1000 pour un capital ne pose pas de
    // problème, l'inverse si.
    case 'float':
      return recu === 'int' || recu === 'float';
    case 'bool':
      return recu === 'bool';
    case 'Tableau de string':
      return recu === 'tableau' && valeur.every((v) => typeof v === 'string');
    default:
      return true;
  }
}

/**
 * @returns {Array<{chemin: string, probleme: string, attendu?: string, recu?: string}>}
 */
function verifier(contenu, classe = RACINE, chemin = 'content') {
  const def = DICTIONNAIRE[classe];
  if (!def || !contenu || typeof contenu !== 'object') return [];

  const ecarts = [];
  for (const [cle, valeur] of Object.entries(contenu)) {
    if (valeur === undefined || valeur === null) continue;
    const ici = `${chemin}.${cle}`;
    const propriete = def.proprietes[cle];

    if (!propriete) {
      ecarts.push({ chemin: ici, probleme: `propriété absente de ${classe}` });
      continue;
    }

    const sousClasse = nomClasse(propriete.type);
    if (estTableau(propriete.type) && Array.isArray(valeur)) {
      valeur.forEach((element, i) => {
        if (sousClasse && element && typeof element === 'object') {
          ecarts.push(...verifier(element, sousClasse, `${ici}[${i}]`));
        } else if (!typeAccepte(propriete.type, valeur)) {
          ecarts.push({ chemin: `${ici}[${i}]`, probleme: 'type inattendu', attendu: propriete.type, recu: typeJs(element) });
        }
      });
      continue;
    }

    if (sousClasse) {
      ecarts.push(...verifier(valeur, sousClasse, ici));
      continue;
    }

    if (!typeAccepte(propriete.type, valeur)) {
      ecarts.push({ chemin: ici, probleme: 'type inattendu', attendu: propriete.type, recu: typeJs(valeur) });
    }
  }
  return ecarts;
}

module.exports = { verifier, RACINE };
