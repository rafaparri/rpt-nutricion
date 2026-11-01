/* RPT Nutrición · motor de recetas.
   Lee fichas de receta en Word (.docx) y calcula calorías y macros a partir de los ingredientes.
   Es un traslado fiel del importador de la app anterior (recipe_import.py). Los datos (tabla de
   alimentos, unidades…) están en recetas_datos.js. */
(function(){
'use strict';
const D = window.RPT_DATOS;
const FOOD_DB = D.FOOD_DB, UNIDADES = D.UNIDADES, ALIAS = D.ALIAS;
/* Alimentos que la app anterior no tenía: kcal, proteína, hidratos, grasa por 100 g y peso de una unidad (g). */
const EXTRA_FOODS = {
  "fruta": [45,0.6,11,0.2,150], "pera": [57,0.4,15,0.1,170], "kiwi": [61,1.1,15,0.5,75], "uva": [69,0.7,18,0.2,5],
  "melocoton": [39,0.9,10,0.3,150], "mandarina": [53,0.8,13,0.3,80], "sandia": [30,0.6,8,0.2,300], "melon": [34,0.8,8,0.2,300],
  "pina": [50,0.5,13,0.1,100], "mango": [60,0.8,15,0.4,250], "cereza": [63,1.1,16,0.2,8], "ciruela": [46,0.7,11,0.3,60],
  "higo": [74,0.8,19,0.3,50], "frambuesa": [52,1.2,12,0.7,5], "arandano": [57,0.7,14,0.3,2], "limon": [29,1.1,9,0.3,100],
  "zumo de naranja": [45,0.7,10,0.2,200], "pasas": [299,3.1,79,0.5,1], "datil": [282,2.5,75,0.4,8],
  "pan integral": [247,13,41,3.4,30], "pan de molde": [265,8,49,3.5,25], "tortita de arroz": [387,8,82,3,9],
  "arroz integral": [350,7.5,77,2.7,185], "cuscus": [376,13,77,0.6,100], "copos de maiz": [357,7,84,0.9,30],
  "muesli": [360,10,66,6,40], "galleta": [450,6,70,16,8], "cacao": [228,20,58,14,10], "chocolate negro": [546,5,61,31,10],
  "secreto de cerdo": [146,19.1,0.5,7.5,100], "presa de cerdo": [180,19,0,11,100], "pluma de cerdo": [190,19,0,12.5,100],
  "solomillo de cerdo": [143,21,0,6,100], "lomo de cerdo": [143,22,0,6,100], "cinta de lomo": [157,21,0,8,100], "chuleta de cerdo": [190,20,0,12,100],
  "carrillera de cerdo": [200,21,0,13,100], "paletilla de cerdo": [190,19,0,13,100], "magro de cerdo": [150,21,0,7,100], "carne de cerdo": [180,20,0,11,100], "cerdo": [180,20,0,11,100],
  "pechuga de pavo": [104,22,0.5,1.7,100], "pavo": [104,22,0.5,1.7,100], "jamon york": [107,17,1,4,20], "lomo": [143,22,0,6,100],
  "clara": [52,11,0.7,0.2,33], "queso fresco": [98,11,3.5,4.5,125], "requeson": [98,11,3.4,4.3,100], "queso crema": [342,6,4,34,20],
  "tofu": [76,8,1.9,4.8,100], "mantequilla": [717,0.9,0.1,81,10], "nata": [345,2,3,36,15], "leche desnatada": [35,3.4,5,0.1,200],
  "bebida de soja": [33,3.3,0.5,1.8,200], "bebida de avena": [45,1,8,1.5,200], "proteina en polvo": [400,80,8,6,30],
  "crema de cacahuete": [600,25,20,50,15], "cacahuete": [567,26,16,49,1], "pistacho": [560,20,28,45,1], "avellana": [628,15,17,61,1],
  "semillas de chia": [486,17,42,31,10], "semillas de lino": [534,18,29,42,10], "hummus": [166,8,14,10,30],
  "aceituna": [115,0.8,6,11,4], "tomate frito": [80,1.5,10,4,30], "judia verde": [31,1.8,7,0.2,100]
};
Object.keys(EXTRA_FOODS).forEach(k => { if (!D.FOOD_DB[k]) D.FOOD_DB[k] = EXTRA_FOODS[k]; });

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
    const parte = (a, b) => a.length >= 3 && b.indexOf(a) >= 0; // coincidencia por parte de palabra: mínimo 3 letras (evita que «g» encaje con «integral»)
    const coinc = pk.filter(k => ing.some(i => k === i || parte(k, i) || parte(i, k))).length;
    if (coinc !== pk.length) continue;
    const esPrincipal = pk.some(k => k === primera || (primera !== undefined && (parte(k, primera) || parte(primera, k))));
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
/* Valores propios por 100 g escritos en la línea: «250 g secreto de cerdo [146/19,1/0,5/7,5]»
   = kcal / proteína / hidratos / grasa por cada 100 g (los de la etiqueta). */
const RE_PROPIOS = /\[\s*(\d+[.,]?\d*)\s*[\/;]\s*(\d+[.,]?\d*)\s*[\/;]\s*(\d+[.,]?\d*)\s*[\/;]\s*(\d+[.,]?\d*)\s*\]/;
function valoresPropios(linea){
  const m = linea.match(RE_PROPIOS); if (!m) return {linea, v:null};
  const n = x => parseFloat(x.replace(',', '.'));
  return {linea: linea.replace(RE_PROPIOS, '').replace(/\s+/g, ' ').trim(), v:[n(m[1]), n(m[2]), n(m[3]), n(m[4])]};
}
function estimarMacros(lineas, raciones){
  raciones = raciones || RACIONES_DEF;
  let kcal = 0, prot = 0, carb = 0, grasa = 0, gramosTot = 0;
  const noRec = [];
  lineas.forEach(linea0 => {
    if (!linea0.trim()) return;
    const pr = valoresPropios(linea0), linea = pr.linea;
    let [cantidad, unidad, nombre] = parseIngrediente(linea);
    const nn = normalizar(nombre);
    if (!nn || esIgnorable(nn)) return;
    const clave = pr.v ? null : buscarIngrediente(nn);
    if (pr.v) {
      const g = (unidad && Object.prototype.hasOwnProperty.call(UNIDADES, unidad)) ? (cantidad === null ? 1 : cantidad) * UNIDADES[unidad] : gramosIndicados(linea);
      if (!g) { noRec.push(capitalize(nombre.trim()) + ' (falta la cantidad en g)'); return; }
      const f = g / 100; kcal += pr.v[0]*f; prot += pr.v[1]*f; carb += pr.v[2]*f; grasa += pr.v[3]*f; gramosTot += g; return;
    }
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

/* ---- lista de la compra: una línea de ingrediente de UNA receta → datos agregables ---- */
const CATS_COMPRA = [
  ['Verduras y hortalizas', /tomate|lechuga|cebolla|ajo|pimiento|zanahoria|calabac|berenjena|espinaca|brocoli|coliflor|pepino|champi|seta|judia verde|puerro|calabaza|acelga|rucula|canonigo|esparrago|verdura|ensalada|apio|repollo|col\b|remolacha|guisante|patata|boniato|batata/],
  ['Frutas', /manzana|platano|naranja|pera|fresa|kiwi|melon|sandia|uva|limon|lima\b|mandarina|melocoton|fruta|arandano|frambuesa|pina|mango|aguacate|cereza|ciruela|higo|datil|pasas/],
  ['Carnes y pescados', /pollo|pavo|ternera|cerdo|lomo|jamon|cordero|carne|hamburguesa|salchicha|merluza|salmon|atun|bacalao|dorada|lubina|gamba|langostino|calamar|sepia|pescado|sardina|caballa|mejillon|almeja|pulpo|conejo|pechuga|solomillo|bonito/],
  ['Lácteos y huevos', /leche|yogur|queso|huevo|nata|mantequilla|kefir|requeson|cuajada|clara|yema|skyr/],
  ['Cereales, legumbres y pan', /arroz|pasta|macarron|espagueti|fideo|pan\b|avena|harina|cereal|lenteja|garbanzo|alubia|judias|quinoa|cuscus|tortita|tostada|galleta|tortilla de trigo|wrap|copos|muesli|legumbre|soja/],
  ['Aceites, frutos secos y despensa', /aceite|nuez|nueces|almendra|anacardo|cacahuete|pistacho|avellana|semilla|chia|lino|sesamo|mantequilla de|crema de|miel|azucar|chocolate|cacao|salsa|vinagre|sal\b|especia|caldo|tomate frito|conserva/]
];
function categoriaCompra(nn){ for (const [c, re] of CATS_COMPRA) if (re.test(nn)) return c; return 'Otros'; }
function ingredienteCompra(linea){
  linea = valoresPropios(linea).linea;
  let [cantidad, unidad, nombre] = parseIngrediente(linea);
  const nn = normalizar(nombre);
  if (!nn || esIgnorable(nn)) return null;
  const clave = buscarIngrediente(nn);
  let gramos = null, uds = null;
  if (clave !== null) {
    const pesoU = FOOD_DB[clave][4];
    if (cantidad === null) cantidad = 1;
    if (unidad && Object.prototype.hasOwnProperty.call(UNIDADES, unidad)) gramos = cantidad * UNIDADES[unidad];
    else { gramos = cantidad * pesoU; uds = cantidad; if (nn.indexOf('grande') >= 0) gramos *= 1.3; else if (nn.indexOf('pequen') >= 0) gramos *= 0.7; }
    if (/aprox/i.test(linea)) { const g = gramosIndicados(linea); if (g) gramos = g; }
  } else {
    const g = gramosIndicados(linea); if (g) gramos = g; else if (cantidad !== null && !unidad) uds = cantidad;
  }
  const nombreBonito = capitalize(nombre.replace(/\s+/g, ' ').trim().replace(/[,;(].*$/, '').trim() || nombre.trim());
  return { clave: clave !== null ? 'k:' + clave : 'n:' + nn.replace(/[,;(].*$/, '').trim(), nombre: nombreBonito, gramos, uds, cat: categoriaCompra(nn), suelto: gramos === null && uds === null };
}

window.RPT_RECETAS = { ingredienteCompra,  estimarMacros, categorizar, parseIngrediente, leerDocx, recetaDeLineas, parseLineas, lineasDocumento };
})();
