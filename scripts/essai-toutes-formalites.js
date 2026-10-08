const { tables } = require('./fake-supa');
const express = require('express');
const app = express(); app.use(express.json()); app.use('/api', require('../src/routes'));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
const s = app.listen(0); const B = `http://127.0.0.1:${s.address().port}/api`;
const j = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { st: r.status, c: await r.json() }; };
(async () => {
  const ops = (await j('GET', '/parcours/operations')).c;
  let ko = 0;
  for (const o of ops) {
    const r = await j('POST', '/parcours', { operations: [o.code], siren: o.creation ? '' : '794598813' });
    if (r.st !== 201) { ko++; console.log('ÉCHEC ouverture', o.code, r.c.error); continue; }
    const d = (await j('GET', `/parcours/${r.c.id}`)).c;
    const n = d.pieces.obligatoires.length + d.pieces.a_preciser.length;
    const portail = d.etat.non_deposables.length > 0;
    if (!n) ko++;
    console.log(`${o.code.padEnd(6)} ${o.guidee ? 'guidée ' : 'fiche  '} pièces:${String(n).padStart(2)} ${portail ? 'portail' : 'dépôt auto'} | ${o.nom.slice(0, 70)}`);
  }
  console.log(`\n${ops.length} formalités ouvertes, dont ${ko} sans aucune pièce dans leur fiche`);
  s.close();
})();
