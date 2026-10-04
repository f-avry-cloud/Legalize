'use strict';

/**
 * Analyse des pièces par Claude : lire les actes déposés (PV, statuts,
 * attestations…) et en tirer les informations du formulaire ciblé.
 *
 * Le modèle reçoit les PDF et la liste exacte des champs attendus pour les
 * opérations du dossier ; il répond dans un format imposé (sortie
 * structurée), champ par champ, en laissant vide ce que les pièces ne disent
 * pas. Rien n'est enregistré sans passer sous les yeux de l'utilisateur :
 * les valeurs sont proposées, signalées comme issues de l'analyse, et
 * restent modifiables.
 *
 * Activée dès que la variable ANTHROPIC_API_KEY est configurée.
 */

const Anthropic = require('@anthropic-ai/sdk');

const Client = Anthropic.default || Anthropic;
const MODELE = process.env.LEGALIZE_MODELE_ANALYSE || 'claude-opus-5-5';

function disponible() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const chaine = { type: 'string' };
const objet = (props) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
const ADRESSE = objet({ numVoie: chaine, typeVoie: chaine, voie: chaine, complementLocalisation: chaine, codePostal: chaine, commune: chaine });
const PERSONNE = objet({
  nom: chaine, prenoms: chaine, genre: chaine, date_naissance: chaine, lieu_naissance: chaine,
  code_insee_naissance: chaine, nationalite: chaine, qualite: chaine, adresse: ADRESSE,
});
const PERSONNE_MORALE = objet({
  denomination: chaine, siren: chaine, forme: chaine, greffe: chaine, representant: chaine, adresse: ADRESSE,
});

/** Clé d'un champ dans la réponse du modèle. */
const cle = (op, name) => `${op}__${name}`;

function typeSchema(champ) {
  if (champ.type === 'adresse') return ADRESSE;
  if (champ.type === 'personne') return PERSONNE;
  if (champ.type === 'personne_morale') return PERSONNE_MORALE;
  return chaine;
}

/** Les champs que l'analyse peut remplir (les renvois et rubriques n'en sont pas). */
function champsAnalysables(groupes) {
  return groupes.flatMap((g) => g.champs
    .filter((c) => c.type !== 'renvoi')
    .map((c) => ({ ...c, op: g.op, groupe: g.titre })));
}

function schemaDe(champs) {
  const valeurs = {};
  for (const c of champs) valeurs[cle(c.op, c.name)] = typeSchema(c);
  return objet({
    valeurs: objet(valeurs),
    incoherences: { type: 'array', items: chaine },
  });
}

function consigne(champs, fiche, operations) {
  const lignes = champs.map((c) => {
    const actuel = c.actuel ? ` (valeur actuelle au registre : ${c.actuel})` : '';
    const indication = {
      date: ' — date au format AAAA-MM-JJ',
      money: ' — montant en euros, chiffres seuls',
      number: ' — nombre seul',
      ouinon: ' — « oui » ou « non »',
      personne: ' — genre « 1 » masculin ou « 2 » féminin ; date de naissance AAAA-MM-JJ ; code INSEE de la commune de naissance si vous le connaissez avec certitude',
      choix: c.options ? ` — l’une des valeurs : ${c.options.map(([v, l]) => `« ${v} » (${l})`).join(', ')}` : '',
    }[c.type] || '';
    return `- ${cle(c.op, c.name)} : ${c.groupe} — ${c.label}${actuel}${indication}`;
  }).join('\n');

  return [
    `Société : ${fiche.denomination || 'nouvelle société'}${fiche.siren ? `, SIREN ${fiche.siren}` : ''}${fiche.forme_juridique ? `, ${fiche.forme_juridique}` : ''}.`,
    `Opérations du dossier : ${operations.join(' ; ')}.`,
    '',
    'Relevez dans les pièces jointes les informations suivantes, telles que les actes les arrêtent :',
    lignes,
    '',
    'Règles :',
    '- N’inscrivez une valeur que si une pièce l’établit. Sinon, laissez la chaîne vide : une case vide vaut mieux qu’une supposition.',
    '- Retenez ce que les actes décident (la nouvelle valeur), pas l’état antérieur.',
    '- Recopiez noms, dénominations et adresses à l’identique des actes.',
    '- Dans « incoherences », signalez en une phrase chacune les contradictions entre pièces, ou entre une pièce et la valeur actuelle du registre, qui méritent l’attention du juriste (date différente entre PV et annonce, capital incohérent, signataire sans pouvoir apparent…). Laissez la liste vide s’il n’y en a pas.',
  ].join('\n');
}

const SYSTEME = 'Vous assistez un cabinet d’avocats en droit des sociétés qui prépare des formalités au registre du commerce. '
  + 'Vous lisez des actes juridiques français (procès-verbaux, statuts, décisions d’associés, annonces légales, pièces d’identité, extraits Kbis) '
  + 'et vous en extrayez des informations avec exactitude. Votre réponse alimente un formulaire que le juriste relit avant dépôt.';

/**
 * @param {{documents: {nom: string, buffer: Buffer}[], groupes: object[], fiche: object, operations: string[]}} p
 * @returns {Promise<{valeurs: object, incoherences: string[], modele: string, documents: string[]}>}
 */
async function extraire({ documents, groupes, fiche, operations }) {
  if (!disponible()) {
    throw Object.assign(new Error('Analyse automatique non activée : la clé ANTHROPIC_API_KEY n’est pas configurée.'), { status: 503 });
  }
  const champs = champsAnalysables(groupes);
  if (!champs.length) return { valeurs: {}, incoherences: [], modele: MODELE, documents: [] };
  if (!documents.length) {
    throw Object.assign(new Error('Aucune pièce à analyser : chargez d’abord les actes (PV, statuts…).'), { status: 422 });
  }

  const client = new Client();
  let message;
  try {
    message = await client.beta.messages.create({
      model: MODELE,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: schemaDe(champs) } },
      system: SYSTEME,
      messages: [{
        role: 'user',
        content: [
          ...documents.map((d) => ({
            type: 'document',
            title: d.nom,
            source: { type: 'base64', media_type: 'application/pdf', data: d.buffer.toString('base64') },
          })),
          { type: 'text', text: consigne(champs, fiche, operations) },
        ],
      }],
    });
  } catch (e) {
    if (e instanceof Client.AuthenticationError) {
      throw Object.assign(new Error('Analyse automatique : clé ANTHROPIC_API_KEY refusée.'), { status: 503 });
    }
    if (e instanceof Client.RateLimitError) {
      throw Object.assign(new Error('Analyse automatique momentanément saturée : réessayer dans une minute.'), { status: 429 });
    }
    if (e instanceof Client.BadRequestError) {
      throw Object.assign(new Error(`Analyse automatique impossible : ${e.message}`), { status: 422 });
    }
    if (e instanceof Client.APIError) {
      throw Object.assign(new Error(`Service d’analyse indisponible (${e.status}).`), { status: 502 });
    }
    throw e;
  }

  if (message.stop_reason === 'refusal') {
    throw Object.assign(new Error('L’analyse a été refusée par le modèle : compléter le formulaire à la main.'), { status: 422 });
  }
  const texte = message.content.find((b) => b.type === 'text')?.text;
  if (!texte) throw Object.assign(new Error('Réponse d’analyse vide.'), { status: 502 });
  const brut = JSON.parse(texte);

  // Retour au format des réponses du dossier : { op: { champ: valeur } },
  // sans les valeurs vides, qui ne doivent rien écraser.
  const valeurs = {};
  for (const c of champs) {
    const v = nettoyer(brut.valeurs?.[cle(c.op, c.name)], c);
    if (v === undefined) continue;
    (valeurs[c.op] = valeurs[c.op] || {})[c.name] = v;
  }
  return {
    valeurs,
    incoherences: (brut.incoherences || []).filter(Boolean),
    modele: message.model,
    documents: documents.map((d) => d.nom),
  };
}

function nettoyer(v, champ) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'object') {
    const plein = Object.fromEntries(Object.entries(v)
      .map(([k, x]) => [k, typeof x === 'object' ? nettoyer(x, {}) : String(x).trim()])
      .filter(([, x]) => x !== undefined && x !== ''));
    return Object.keys(plein).length ? plein : undefined;
  }
  const s = String(v).trim();
  if (!s) return undefined;
  if (champ.type === 'ouinon') return /^o/i.test(s);
  return s;
}

module.exports = { disponible, extraire, schemaDe, champsAnalysables, MODELE };
