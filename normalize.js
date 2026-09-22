// normalize.js  — FUENTE ÚNICA DE VERDAD. Isomorfo: corre en Node y en el navegador.
(function (root) {
  'use strict';

  // Las 6 reglas se aplican en orden fijo (Requirement 10.2). a→b→c→d→f;
  // el corte de artista principal (regla e) lo aplica normalizeArtist.
  function normalize(str) {
    let s = (str || '');
    s = s.toLowerCase().trim();                                      // (a) minúsculas + trim
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');          // (b) sin acentos (NFD + strip combinantes)
    s = s.replace(/\s*-\s*(acoustic|remix|live|remastered).*$/, ''); // (c) sufijos de versión
    s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, '')                       // (d) paréntesis/corchetes
         .replace(/\b(feat\.?|ft\.?)\b.*$/, '');                     // (d) feat./ft.
    s = s.replace(/\s+/g, ' ').trim();                               // (f) colapsar espacios
    return s;
  }

  function normalizeArtist(str) {
    // (e) artista principal: cortar en el primer ; , & o "feat" sobre el string crudo,
    // luego normalizar el fragmento con las reglas a→b→c→d→f.
    const primary = (str || '').split(/[;,&]|\bfeat\b/i)[0];
    return normalize(primary);
  }

  const api = { normalize, normalizeArtist };

  // Doble exportación sin duplicar lógica:
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node:  const { normalize } = require('./normalize')
  } else {
    root.SM_NORMALIZE = api;         // Navegador: window.SM_NORMALIZE.normalize(...)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
