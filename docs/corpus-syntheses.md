# Corpus des synthèses du Guichet unique

Le programme `scripts/corpus-syntheses.js` lit un dossier de synthèses du guichet
(PDF), les anonymise et en tire des statistiques. Il sert à régler le connecteur
sur la pratique réelle du cabinet :
- quelles formalités le cabinet dépose ;
- quelles rubriques sont réellement remplies ;
- quelles valeurs sont retenues ;
- quelles pièces sont jointes ;
- ce qui change d'une version à l'autre.

## Lancer l'analyse

```
npm run corpus:syntheses -- "<dossier des PDF>" --sortie "<dossier des résultats>"
```

Le programme n'a besoin que de Node.js 20.16 ou plus récent et de `pdfjs-dist`,
qui figure dans les dépendances du projet.

### Sur un poste Windows, hors du projet

`node scripts/paquet-syntheses.js` fabrique `analyse-syntheses-legalize.zip`
(environ 600 Ko). Le zip contient le lanceur `LANCER.cmd` et sa notice
(`outils/analyse-syntheses`), le programme, le module de lecture et pdf.js.

Sur le poste, il suffit de Node.js : pas d'installation de paquets, pas de
réseau. On extrait le zip, puis on double-clique sur `LANCER.cmd`.
- Par défaut, il lit `Téléchargements\Documents de synthèse pour Legalize` et
  écrit dans `Téléchargements\Resultats syntheses Legalize`.
- Un autre dossier de synthèses peut être glissé sur `LANCER.cmd`.

pdf.js réclame à son chargement une bibliothèque graphique native
(`@napi-rs/canvas`), absente du paquet. Une matrice minimale la remplace :
la lecture du texte n'a pas besoin de dessiner les pages.

Il parcourt aussi les sous-dossiers du dossier indiqué. Il ignore :
- les fichiers cachés, dont les `._…` de macOS ;
- les PDF qui ne sont pas des synthèses (reçus, actes…).

Les versions d'une même formalité sont regroupées : v1, v2, signée, et
bénéficiaires effectifs à part. Deux fichiers identiques comptent pour une
seule version.

Options :
- `--limite <n>` : ne traiter que les n premiers PDF, pour un essai ;
- `--sans-fiches` : ne pas écrire de fiche par formalité.

Durée : environ 0,2 seconde par PDF, soit une vingtaine de minutes pour
6 000 synthèses. Il n'y a pas de reconnaissance de caractères : les synthèses
du guichet sont des PDF générés, dont le texte se lit directement.

## Ce qui sort, ce qui ne sort pas

Le dossier de résultats contient trois fichiers :
- `rapport.md` : la synthèse lisible ;
- `agregats.json` : les statistiques complètes ;
- `fiches.jsonl` : une fiche par formalité.

Ces fichiers ne contiennent que :
- la structure : titres sans leur partie nominative, libellés des rubriques,
  présence ou absence d'une valeur ;
- les valeurs de liste : type de formalité, forme juridique, greffe, rôle,
  journal d'annonces légales, catégories d'activité, régimes fiscaux, oui / non ;
- des tranches : capital, pourcentages de détention des bénéficiaires effectifs ;
- le mois de dépôt ;
- l'intitulé et l'origine de chaque pièce jointe : déposant, guichet ou greffe.

Ne sortent jamais :
- les noms et prénoms ;
- les dates et lieux de naissance ;
- les adresses, téléphones et courriels ;
- les noms de fichiers ;
- les numéros de liasse, SIREN et SIRET, la dénomination ;
- l'objet social, les observations et la référence client.

Le programme ne connaît d'avance que les rubriques des formalités déjà vues. Pour
une rubrique qu'il ne connaît pas, la valeur ne sort que si elle figure dans au
moins 20 formalités distinctes : c'est alors une valeur de liste (motif,
nature, option…), non une donnée propre à un dossier. Une valeur qui reste
sous ce seuil est réduite à sa présence.

Cette règle ne s'applique jamais aux libellés qui désignent :
- une personne : nom, prénom, naissance, genre, nationalité ;
- des coordonnées : adresse, courriel, téléphone ;
- une date, un numéro, un montant ;
- un texte libre : objet, description, observations.

Une formalité n'est désignée que par un pseudonyme. Il est tiré d'une clé
aléatoire propre à chaque exécution, qui n'est écrite nulle part. Les fichiers
illisibles sont listés à l'écran, jamais dans les résultats.

## Lire les résultats

Les statistiques sont calculées par strate :
- par type de formalité ;
- par type croisé avec la forme juridique ;
- par type croisé avec chaque modification déclarée.

Chaque strate porte une mention de fiabilité :

| Exemplaires dans la strate | Fiabilité |
|---|---|
| 60 ou plus | fiable : tout ce qui figure dans au moins 5 % des dossiers est repéré |
| 30 à 59 | indicatif |
| moins de 30 | insuffisant |

La mise en page est mesurée sur chaque document, et non fixée d'après les
exemples. Le programme mesure la taille du texte courant, en déduit les seuils
des titres, puis repère la colonne des valeurs.

La section « Qualité de la lecture » donne, par année et par type de
formalité, la part des documents « à vérifier ». Un document est à vérifier
dans l'un de ces cas :
- il compte moins de 10 rubriques ;
- une rubrique n'a pas de libellé ;
- une ligne est restée hors rubrique ;
- sa colonne des valeurs est inhabituelle.

Une autre version du modèle du guichet apparaîtrait ainsi au lieu de fausser
les statistiques en silence.

Les « rubriques modifiées » d'une version à l'autre excluent ce qui relève du
dépôt lui-même : signature, paiement, pièces jointes et observations. Il reste
les corrections de contenu, signe probable d'une régularisation demandée par
le greffe.

Les libellés inconnus restent réduits à leur présence. Après une première
analyse, la liste des valeurs conservées (`VALEURS_LISTE` dans
`src/inpi/synthese-gu.js`) peut être complétée.

Tests : `npm run test:syntheses`. Ils utilisent des synthèses fictives et un PDF
généré à la volée, jamais de vraie synthèse.
