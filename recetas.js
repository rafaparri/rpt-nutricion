/* RPT Nutrición · motor de recetas.
   Lee fichas de receta en Word (.docx) y calcula calorías y macros a partir de los ingredientes.
   Es un traslado fiel del importador de la app anterior (recipe_import.py). Los datos (tabla de
   alimentos, unidades…) están en recetas_datos.js. */
(function(){
'use strict';
const D = window.RPT_DATOS;
const FOOD_DB = D.FOOD_DB, UNIDADES = D.UNIDADES, ALIAS = D.ALIAS;
const IGNORAR = D.IGNORAR, VERBOS = new Set(D.VERBOS), VACIAS = new Set(D.VACIAS);
const RACIONES_DEF = D.RACIONES;

/* ---- utilidades que en Python vienen de serie ---- */
function pyRound(x, n){ // redondeo "al par" como Python
  const f = Math.pow(10, n || 0), v = x * f, r = Math.round(v);
  const dec = Math.abs(v - Math.trunc(v));
  return ((Math.abs(dec - 0.5) < 1e-9 && r % 2 !== 0 ? r - 1 : r)) / f;
}
const title = s => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const capitalize = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
function normalizar(t){ return String(t).toLowerCase().trim().normalize('NFKD').replace(/[^\x00-\x7F]/g, ''); }
function stem(p){
  if (p.length > 4 && p.endsWith('es')) return p.slice(0, -2);
  if (p.length > 3 && p.endsWith('s')) return p.slice(0, -1);
  return p;
}
const ALIAS_ORDEN = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
function traducirIngles(t){
  let r = t;
  ALIAS_ORDEN.forEach(a => { const an = normalizar(a); if (an && r.indexOf(an) >= 0) r = r.split(an).join(normalizar(ALIAS[a])); });
  return r;
}

function parecePasoPreparacion(linea){
  const texto = linea.trim(); if (!texto) return false;
  if (colonAlFinal(texto) !== texto) return false; // "Ingrediente: cantidad" es un ingrediente, aunque sea largo
  const palabras = normalizar(texto).split(/\s+/).filter(Boolean); if (!palabras.length) return false;
  if (/^\d/.test(palabras[0])) return false;
  const primera = palabras[0];
  if (VERBOS.has(primera) || VERBOS.has(stem(primera))) return true;
  const hayVerbo = palabras.some(p => VERBOS.has(stem(p)) || VERBOS.has(p));
  if (hayVerbo && palabras.length >= 5) return true;
  if (palabras.length >= 16) return true;
  return false;
}

function buscarIngrediente(nombreNorm){
  nombreNorm = traducirIngles(nombreNorm);
  const todas = nombreNorm.split(/\s+/).filter(Boolean).map(stem);
  const ing = todas.filter(w => !VACIAS.has(w)).length ? todas.filter(w => !VACIAS.has(w)) : todas;
  const primera = ing[0];
  let mejor = null, mejorP = 0, mejorPrincipal = false;
  for (const clave of Object.keys(FOOD_DB)) {
    const pk = clave.split(/\s+/).filter(w => w && !VACIAS.has(w)).map(stem);
    if (!pk.length) continue;
    const coinc = pk.filter(k => ing.some(i => k === i || i.indexOf(k) >= 0 || k.indexOf(i) >= 0)).length;
    if (coinc !== pk.length) continue;
    const esPrincipal = pk.some(k => k === primera || (primera !== undefined && (primera.indexOf(k) >= 0 || k.indexOf(primera) >= 0)));
    if (esPrincipal && !mejorPrincipal) { mejor = clave; mejorP = coinc; mejorPrincipal = true; }
    else if (esPrincipal === mejorPrincipal && coinc > mejorP) { mejor = clave; mejorP = coinc; }
  }
  return mejor;
}
function esIgnorable(nombreNorm){
  const a = new Set(nombreNorm.split(/\s+/).filter(Boolean).map(stem));
  return IGNORAR.some(p => a.has(stem(p)));
}
function convertirFracciones(t){
  let m = t.match(/^(\d+)\s+(\d+)\/(\d+)(.*)$/);
  if (m) { const v = parseInt(m[1], 10) + parseInt(m[2], 10) / parseInt(m[3], 10); return quitaCeros(v) + m[4]; }
  m = t.match(/^(\d+)\/(\d+)(.*)$/);
  if (m) { const v = parseInt(m[1], 10) / parseInt(m[2], 10); return quitaCeros(v) + m[3]; }
  return t;
}
function quitaCeros(v){ return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); }
function convertirNumeroTexto(t){
  const n = t.toLowerCase().trim();
  for (const [frase, valor] of D.NUMEROS) if (n === frase || n.startsWith(frase + ' ')) return valor + t.slice(frase.length);
  return t;
}
const NUM_INICIO = /^(?:\d|medi[oa]\b|un[ao]?\b|dos\b|tres\b|cuatro\b|cinco\b|seis\b|siete\b|ocho\b|nueve\b|diez\b)/i;
/* Formato "Huevo: 2 unidades" / "Aceite de oliva: 4 cucharadas" -> "2 unidades Huevo" */
function colonAlFinal(t){
  const m = t.match(/^([^:]+):\s*(.+)$/);
  if (!m || !NUM_INICIO.test(m[2].trim())) return t;
  const nombre = m[1].replace(/\([^)]*\)/g, '').trim();
  return m[2].trim().replace(/^(\d+[.,]?\d*)\s*(?:unidades|unidad|uds?\.?)\s*/i, '$1 ') + ' ' + nombre;
}
function parseIngrediente(linea){
  let t = colonAlFinal(linea.trim().replace(/^[-•*]\s*/, ''));
  t = convertirNumeroTexto(t.trim());
  t = convertirFracciones(t.trim());
  const m = t.match(/^(\d+[.,]?\d*)\s*([a-zA-Záéíóúñ]*)\s*(?:de\s+)?(.*)$/);
  if (!m) return [null, null, t];
  const cantidad = parseFloat(m[1].replace(',', '.'));
  let unidad = m[2].toLowerCase().trim(), resto = m[3];
  if (!Object.prototype.hasOwnProperty.call(UNIDADES, unidad)) { resto = (unidad + ' ' + resto).trim(); unidad = null; }
  else resto = resto.trim().replace(/^(?:soperas?|generos[oa]s?|colmad[oa]s?|rasas?|grandes?|peque[ñn][oa]s?)\s+(?:de\s+)?/i, '');
  return [cantidad, unidad, resto.trim()];
}
function gramosIndicados(linea){
  let m = linea.match(/(\d+[.,]?\d*)\s*(?:-|–|a)\s*(\d+[.,]?\d*)\s*(?:g|gr|grs|gramos)\b/i);
  if (m) return (parseFloat(m[1].replace(',', '.')) + parseFloat(m[2].replace(',', '.'))) / 2;
  m = linea.match(/(\d+[.,]?\d*)\s*(?:g|gr|grs|gramos)\b/i);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

/* Calorías y macros de UNA ración, a partir de las líneas de ingredientes. */
function estimarMacros(lineas, raciones){
  raciones = raciones || RACIONES_DEF;
  let kcal = 0, prot = 0, carb = 0, grasa = 0, gramosTot = 0;
  const noRec = [];
  lineas.forEach(linea => {
    if (!linea.trim()) return;
    let [cantidad, unidad, nombre] = parseIngrediente(linea);
    const nn = normalizar(nombre);
    if (!nn || esIgnorable(nn)) return;
    const clave = buscarIngrediente(nn);
    if (clave === null) {
      noRec.push(capitalize(nombre.trim()));
      const g = gramosIndicados(linea); if (g) gramosTot += g;
      return;
    }
    const [k100, p100, c100, g100, pesoU] = FOOD_DB[clave];
    if (cantidad === null) cantidad = 1;
    let gramos;
    if (unidad && Object.prototype.hasOwnProperty.call(UNIDADES, unidad)) gramos = cantidad * UNIDADES[unidad];
    else { gramos = cantidad * pesoU; if (nn.indexOf('grande') >= 0) gramos *= 1.3; else if (nn.indexOf('pequen') >= 0) gramos *= 0.7; }
    if (/aprox/i.test(linea)) { const g = gramosIndicados(linea); if (g) gramos = g; }
    const f = gramos / 100;
    kcal += k100 * f; prot += p100 * f; carb += c100 * f; grasa += g100 * f; gramosTot += gramos;
  });
  return { kcal: pyRound(kcal / raciones), prot: pyRound(prot / raciones, 1), carb: pyRound(carb / raciones, 1),
           grasa: pyRound(grasa / raciones, 1), peso: pyRound(gramosTot / raciones), noReconocidos: noRec };
}
function categorizar(kcal, prot, carb, grasa){
  const kp = prot * 4, kc = carb * 4, kg = grasa * 9, tot = Math.max(kp + kc + kg, 1);
  if (kcal < 300) return 'Ligero';
  if (kp / tot >= 0.35) return 'Alto en Proteína';
  if (kc / tot >= 0.55) return 'Alto en Hidratos';
  if (kg / tot >= 0.40) return 'Alto en Grasas';
  return 'Equilibrado';
}

/* ---- lectura del Word ---- */
function detectarSeccion(n){
  if (n.length > 45) return null;
  if (n.startsWith('INGREDIENTE')) return 'ingredientes';
  for (const p of ['PREPARACION','ELABORACION','MODO DE PREPARACION','MODO DE EMPLEO','INSTRUCCIONES','PASOS','COMO SE HACE','ELABORA','PROCEDIMIENTO']) if (n.startsWith(p)) return 'preparacion';
  for (const p of ['UTILIZAR EN','APTO PARA','MOMENTO DEL DIA','USAR EN']) if (n.startsWith(p)) return 'utilizar_en';
  if (n.startsWith('CLASE DE PLATO')) return 'descartado';
  for (const p of ['ESTUDIO ENERGETICO','INFORMACION NUTRICIONAL','VALOR NUTRICIONAL','APORTE CALORICO','APORTE NUTRICIONAL','DATOS NUTRICIONALES','ANALISIS NUTRICIONAL','VALORES NUTRICIONALES','COMPOSICION NUTRICIONAL']) if (n.startsWith(p)) return 'estudio_energetico';
  return null;
}
const numEs = t => { const n = parseFloat(String(t).replace(/\./g, '').replace(',', '.')); return isFinite(n) ? n : null; };
function macrosDeclarados(lineas){
  const res = {}, junto = lineas.join(' ');
  let m = junto.match(/(\d[\d.,]*)\s*k?cal/i);
  if (m) { const n = numEs(m[1]); if (n) res.kcal = n; }
  const pat = { prot: /prote[ií]nas?\D{0,15}?(\d[\d.,]*)\s*g/i, carb: /(?:hidratos de carbono|carbohidratos)\D{0,15}?(\d[\d.,]*)\s*g/i, grasa: /grasas?\D{0,15}?(\d[\d.,]*)\s*g/i };
  Object.keys(pat).forEach(k => { const mm = junto.match(pat[k]); if (mm) { const n = numEs(mm[1]); if (n !== null) res[k] = n; } });
  let nombre = null;
  for (const l of lineas) {
    if (/\d/.test(l) || l.indexOf(':') >= 0 || l.length > 60) continue;
    const may = l.split(/\s+/).filter(w => w.length > 2 && w === w.toUpperCase() && w !== w.toLowerCase()).length;
    if (may >= 2) { nombre = title(l.trim()); break; }
  }
  return [res, nombre];
}

/* Texto de un Word: líneas en el orden real de párrafos y tablas */
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const hijos = (el, nombre) => Array.from(el.childNodes).filter(n => n.nodeType === 1 && n.localName === nombre && n.namespaceURI === W);
function textoParrafo(p){
  let t = '';
  (function rec(n){
    Array.from(n.childNodes).forEach(c => {
      if (c.nodeType !== 1) return;
      const ln = c.localName;
      if (ln === 't') t += c.textContent;
      else if (ln === 'tab') t += '\t';
      else if (ln === 'br' || ln === 'cr') t += '\n';
      else if (ln === 'del' || ln === 'pPr') return;
      else rec(c);
    });
  })(p);
  return t;
}
function textoCelda(tc){ return hijos(tc, 'p').map(textoParrafo).join('\n'); }
function lineasDeTabla(tbl){
  const out = [];
  hijos(tbl, 'tr').forEach(tr => {
    const celdas = [];
    hijos(tr, 'tc').forEach(tc => { const t = textoCelda(tc).trim(); if (t) celdas.push(t); });
    if (!celdas.length) return;
    if (celdas.length === 1) celdas[0].split('\n').forEach(x => out.push(x)); else out.push(celdas.join(' '));
  });
  return out;
}
function lineasDocumento(xml){
  const body = xml.getElementsByTagNameNS(W, 'body')[0], out = [];
  if (!body) return out;
  Array.from(body.childNodes).forEach(n => {
    if (n.nodeType !== 1 || n.namespaceURI !== W) return;
    if (n.localName === 'p') { const t = textoParrafo(n).trim(); if (t) out.push(t); }
    else if (n.localName === 'tbl') {
      lineasDeTabla(n).forEach(x => out.push(x));
      hijos(n, 'tr').forEach(tr => hijos(tr, 'tc').forEach(tc => hijos(tc, 'tbl').forEach(sub => lineasDeTabla(sub).forEach(x => out.push(x)))));
    }
  });
  return out;
}

/* Interpreta las líneas de una ficha de receta. */
function parseLineas(parrafos){
  let nombre = 'Plato sin nombre', raciones = RACIONES_DEF;
  const listas = { ingredientes: [], preparacion: [], utilizar_en: [], estudio_energetico: [] };
  let seccion = null, tituloDetectado = false, hayEncabezado = false;
  const sinSeccion = [];
  const agregar = (dest, texto) => {
    if (!listas[dest]) return;
    let frag = texto.split('\n');
    if (dest === 'ingredientes') { const e = []; frag.forEach(f => f.split(',').forEach(x => e.push(x))); frag = e; }
    frag.forEach(s => { s = s.replace(/^[\s\-•*•]+/, '').trim(); s = s.replace(/^\d+[.)]\s*/, ''); if (s) listas[dest].push(s); });
  };
  for (const linea of parrafos) {
    const limpio = linea.trim(); if (!limpio) continue;
    const normal = normalizar(limpio).toUpperCase();
    const i = limpio.indexOf(':');
    const cabecera = i >= 0 ? limpio.slice(0, i) : limpio, resto = i >= 0 ? limpio.slice(i + 1) : '';
    if (!tituloDetectado) {
      const ya = detectarSeccion(normalizar(cabecera).toUpperCase()) || detectarSeccion(normal);
      tituloDetectado = true;
      if (!ya) {
        const m = limpio.match(/\(?\s*(\d+)\s*(?:raci|persona)/i);
        if (m) raciones = parseInt(m[1], 10);
        const n = limpio.replace(/\(.*(?:raci|persona).*\)/i, '').trim();
        nombre = n ? title(n) : 'Plato sin nombre';
        continue;
      }
    }
    const nueva = detectarSeccion(normalizar(cabecera).toUpperCase()) || detectarSeccion(normal);
    if (nueva) {
      seccion = nueva; hayEncabezado = true;
      if (nueva === 'ingredientes') { const m = limpio.match(/\(?\s*(\d+)\s*(?:raci|persona)/i); if (m) raciones = parseInt(m[1], 10); }
      if (resto.trim()) agregar(seccion, resto);
      continue;
    }
    if (listas[seccion]) agregar(seccion, limpio); else sinSeccion.push(limpio);
  }
  if (!hayEncabezado && sinSeccion.length) sinSeccion.forEach(l => agregar(parecePasoPreparacion(l) ? 'preparacion' : 'ingredientes', l));
  const tags = [];
  listas.utilizar_en.forEach(tag => {
    const t = normalizar(tag); let enc = false;
    if (t.indexOf('almuerz') >= 0) { tags.push('Almuerzo'); enc = true; }
    if (t.indexOf('cena') >= 0) { tags.push('Cena'); enc = true; }
    if (t.indexOf('desayun') >= 0) { tags.push('Desayuno'); enc = true; }
    if (!enc && tag) tags.push(capitalize(tag.trim()));
  });
  if (!tags.length) tags.push('Almuerzo', 'Cena');
  const ingr = [], pasos = [];
  listas.ingredientes.forEach(l => (parecePasoPreparacion(l) ? pasos : ingr).push(l));
  const [decl, nombreTabla] = macrosDeclarados(listas.estudio_energetico);
  if (nombre === 'Plato sin nombre' && nombreTabla) nombre = nombreTabla;
  return { nombre, raciones, ingredientes: ingr, preparacion: pasos.concat(listas.preparacion).join('\n'),
           utilizarEn: Array.from(new Set(tags)).join(', '), declarados: decl };
}

/* De líneas a receta completa, con macros (declarados en el documento si los trae los cuatro) */
function recetaDeLineas(parrafos){
  const d = parseLineas(parrafos);
  let est;
  try { est = estimarMacros(d.ingredientes, d.raciones); } catch (e) { est = { kcal: 0, prot: 0, carb: 0, grasa: 0, peso: 0, noReconocidos: [] }; }
  const dec = d.declarados || {}, usaDecl = ['kcal', 'prot', 'carb', 'grasa'].every(k => k in dec);
  const kcal = usaDecl ? dec.kcal : est.kcal, prot = usaDecl ? dec.prot : est.prot, carb = usaDecl ? dec.carb : est.carb, grasa = usaDecl ? dec.grasa : est.grasa;
  return { name: d.nombre || 'Plato sin nombre', servings: d.raciones, ingredients: d.ingredientes, prep: d.preparacion, useIn: d.utilizarEn,
           kcal: Math.round(kcal) || 0, prot: prot || 0, carb: carb || 0, fat: grasa || 0, weight: est.peso || 0,
           category: categorizar(kcal, prot, carb, grasa), unrecognized: est.noReconocidos, sinIngredientes: d.ingredientes.length === 0, declarado: usaDecl };
}

async function leerDocx(arrayBuffer){
  if (!window.JSZip) throw new Error('No se ha cargado el lector de Word. Comprueba la conexión.');
  const zip = await window.JSZip.loadAsync(arrayBuffer);
  const f = zip.file('word/document.xml');
  if (!f) throw new Error('El archivo no parece un documento Word (.docx).');
  const xml = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  return recetaDeLineas(lineasDocumento(xml));
}

window.RPT_RECETAS = { estimarMacros, categorizar, parseIngrediente, leerDocx, recetaDeLineas, parseLineas, lineasDocumento };
})();
