/* RPT Nutrición — app del nutricionista (y del usuario, en una fase posterior).
   Mismo Firebase y misma cuenta que WorkOut 2.0, pero datos propios:
     nu_patients/{pid}                  ficha del usuario (la crea el nutricionista a mano)
     nu_patients/{pid}/weights/{día}    peso (un registro por día)
     nu_patients/{pid}/weeks/{lunes}    intensidad de entreno de la semana (4 niveles)
   El permiso de nutricionista es users/{uid}/roleGrants/nutritionist. */
(function(){
'use strict';

const NIVELES = ['Descanso','Baja','Media','Alta'];
const DIAS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- fechas ---------- */
function iso(d){ return d.toLocaleDateString('sv-SE'); }
function lunesDe(d){ const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const w = (x.getDay()+6)%7; x.setDate(x.getDate()-w); return x; }
function lunesISO(d){ return iso(lunesDe(d)); }
function sumaDias(isoStr, n){ const p = isoStr.split('-').map(Number); const d = new Date(p[0], p[1]-1, p[2]+n); return iso(d); }
function fechaCorta(isoStr){ const p = isoStr.split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }
function kgTxt(k){ return String(k).replace('.', ','); }
function versionTexto(){
  const m = String(window.RPT_VERSION||'').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? m[3]+'/'+m[2]+'/'+m[1]+' '+m[4]+':'+m[5] : 'desconocida';
}

/* ---------- estado ---------- */
const S = {
  view:'boot',            // boot | login | activar | app
  user:null, isNutri:false,
  tab:'pacientes',        // usuarios | recetario | cuenta
  patients:[], pid:null, ptab:'menu', measures:[], side:false, compraOn:false, menuBase:null,
  weights:[], weekStart:lunesISO(new Date()), levels:null,
  links:[], requests:[], wo:{}, woPlanId:null, woMsg:null,
  recipes:[], sharedRecipes:[], rtab:'mias', rq:'', cola:[], rmsg:null,
  menu:null, slot:null, prefs:{},
  msg:null, msgOk:false, busy:false
};
const refPac = pid => db.collection('nu_patients').doc(pid);
try { S.side = window.innerWidth >= 900 && localStorage.getItem('nu_side') !== '0'; } catch(e){ S.side = window.innerWidth >= 900; }
/* Espacio de trabajo: el titular y las personas con acceso completo comparten usuarios, recetas y menús. */
const miEmail = () => ((S.user && S.user.email) || '').toLowerCase();
const wsUid = () => S.wsOwner || S.user.uid;
const esMiembro = () => !!S.wsOwner && S.wsOwner !== S.user.uid;
const wsTeam = () => esMiembro() ? (S.wsTeamList || []) : (S.team || []);
const pacienteActual = () => S.patients.find(p => p.id === S.pid);

/* ---------- vínculo con WorkOut ---------- */
const linkDe = pid => S.links.filter(l => l.patientId === pid).sort((a,b) => (b.createdMs||0)-(a.createdMs||0))[0] || null;
const DIAKEYS = ['L','M','X','J','V','S','D'];
function cargaDia(entries){
  let t = 0;
  (entries || []).forEach(e => {
    if (e.type && e.type !== 'exercise') return;
    (e.sets || []).forEach(x => { t += (Number(x.kg)||0) * (Number(x.series)||1) * (Number(x.reps)||1); });
  });
  return t;
}
// 1 Descanso (sin carga) · 2 Baja (menos de la mitad del día más duro) · 3 Media · 4 Alta (el día más duro)
function nivelesDePlan(plan){
  const dia = k => (plan && plan.days && plan.days[k]) || [];
  const c = DIAKEYS.map(k => cargaDia(dia(k)));
  const hay = DIAKEYS.map(k => dia(k).some(e => e.type === 'exercise'));
  const max = Math.max.apply(null, c.concat([1]));
  return c.map((x, i) => !hay[i] ? 1 : (x >= 0.95*max ? 4 : (x >= 0.5*max ? 3 : 2)));
}
// Aplica los días que el atleta pasó de uno a otro ("pasar el entreno del jueves al viernes")
function planConMovimientos(plan, moves){
  const days = {}; DIAKEYS.forEach(k => days[k] = (plan.days && plan.days[k] || []).slice());
  DIAKEYS.forEach(src => {
    const dst = moves && moves[plan.id + '|' + src];
    if (dst && dst !== src && days[dst] && days[src].length) { days[dst] = days[dst].concat(days[src]); days[src] = []; }
  });
  return Object.assign({}, plan, {days});
}
function nombrePlan(p){ return (p.meta && p.meta.week != null) ? 'Semana '+p.meta.week : (p.id || 'Plan'); }
function compsDeLaSemana(pid){
  const w = S.wo[pid]; if (!w) return [];
  const fin = sumaDias(S.weekStart, 6);
  return w.comps.map(c => ({c, d:c.day || c.startDate})).filter(x => x.d && x.d >= S.weekStart && x.d <= fin);
}
function buscaSolicHtml(){
  if (S.requests.some(l => l.status === 'pending')) return '';
  return '<div class="card"><h3>Solicitudes de vinculación con WorkOut</h3><p class="sub" style="margin-bottom:10px">Has entrado como <b>'+esc(miEmail())+'</b>. '+
    (S.reqErr ? 'No se pudieron leer las solicitudes ('+esc(S.reqErr)+').' : 'No hay ninguna solicitud pendiente para este correo.')+' Si esperabas una, comprueba que el correo es exactamente el que escribió quien te la envió.</p>' +
    '<button class="btn secondary" data-act="buscarSolic">🔄 Buscar solicitudes de nuevo</button></div>';
}
function solicitudesHtml(){
  return S.requests.filter(l => l.status === 'pending').map(l =>
    '<div class="card accent"><h3>Solicitud de '+esc(l.nutriName||'tu nutricionista')+'</h3>' +
    '<p class="sub" style="margin-bottom:12px">Quiere leer tus datos de WorkOut (entrenos, competiciones y peso) y anotarte pesos. Puedes retirar el permiso cuando quieras.</p>' +
    '<div class="btn-row"><button class="btn secondary" data-act="rechazar" data-id="'+esc(l.id)+'">Rechazar</button><button class="btn" data-act="aceptar" data-id="'+esc(l.id)+'">Aceptar</button></div></div>').join('');
}

/* ---------- pantallas ---------- */
function topBar(){
  return '<header class="topbar">' + (S.view === 'app' ? '<button class="menubtn" data-act="side" aria-label="Abrir o cerrar el menú">☰</button>' : '') +
    '<div class="brand"><img class="appicon" src="static/icon-192.png" alt="" width="38" height="38"><span>NutriForce</span></div>' +
    (S.user ? '<button class="user" data-act="tab" data-v="cuenta">'+esc((S.user.email||'').split('@')[0])+' ▾</button>' : '') + '</header>';
}
/* Menú lateral: lo que son datos de base (usuario, recetario, cuenta). Se puede ocultar. */
function sideHtml(){
  if (S.view !== 'app') return '';
  const p = S.pid ? pacienteActual() : null;
  const it = (act, v, ico, txt, cur) => '<button class="sitem" data-act="'+act+'" data-v="'+v+'"'+(cur ? ' aria-current="page"' : '')+'><span class="ico">'+ico+'</span><span>'+txt+'</span></button>';
  return '<div class="sidebk" data-act="side"></div><aside class="side'+(S.side ? ' open' : '')+'" aria-label="Menú">' +
    '<div class="sidehead"><b>Menú</b><button class="btn small secondary" data-act="side" aria-label="Cerrar el menú">✕</button></div>' +
    it('tab', 'pacientes', '👥', 'Usuarios', S.tab === 'pacientes' && !(p && S.ptab === 'datos')) +
    (p ? '<div class="sgroup">Usuario: '+esc(p.name)+'</div>' + it('sideDatos', 'datos', '📋', 'Datos, peso y WorkOut', S.tab === 'pacientes' && S.ptab === 'datos') : '') +
    '<div class="sgroup">Base</div>' +
    it('tab', 'recetario', '📖', 'Recetario', S.tab === 'recetario') +
    it('tab', 'cuenta', '⚙️', 'Cuenta', S.tab === 'cuenta') + '</aside>';
}
function msgHtml(){ return S.msg ? '<div class="msg '+(S.msgOk?'ok':'err')+'">'+esc(S.msg)+'</div>' : '<div class="msg"></div>'; }

function vLogin(){
  return '<div class="app">'+topBar()+'<div class="login">' +
    '<div class="center"><img class="appicon big" src="static/icon-192.png" alt="NutriForce" width="96" height="96" style="margin:0 auto 12px"><h1>NutriForce</h1><p class="sub">Entra con la misma cuenta que usas en WorkOut, o crea una nueva.</p></div>' +
    '<div class="field"><label class="f" for="em">Correo</label><input id="em" type="email" autocomplete="username" inputmode="email"></div>' +
    '<div class="field"><label class="f" for="pw">Contraseña</label><input id="pw" type="password" autocomplete="current-password"></div>' +
    msgHtml() +
    '<button class="btn" data-act="entrar">Entrar</button>' +
    '<button class="btn secondary" data-act="crear">Crear cuenta nueva</button>' +
    '<button class="linkbtn" data-act="olvido">He olvidado la contraseña</button>' +
    '</div></div>';
}
function vActivar(){
  return '<div class="app">'+topBar()+'<div class="content">' +
    '<h1>Bienvenido</h1>' + solicitudesHtml() + buscaSolicHtml() +
    '<div class="card"><h3>Soy nutricionista</h3><p class="sub" style="margin-bottom:14px">Podrás crear tus usuarios, marcar su semana de entreno y preparar sus menús.</p>' +
    '<button class="btn" data-act="activar">Activar modo nutricionista</button></div>' +
    '<div class="card"><h3>Soy usuario</h3><p class="sub">Tu nutricionista te dará acceso con tu correo. Cuando lo haga, tu menú aparecerá aquí.</p></div>' +
    msgHtml() +
    '<button class="btn secondary" data-act="salir">Salir</button></div></div>';
}
function vPacientes(){
  const lista = S.patients.length
    ? '<div class="list">' + S.patients.map(p =>
        '<button class="row" data-act="abrir" data-id="'+esc(p.id)+'"><div class="avatar">'+esc((p.name||'?').trim().charAt(0).toUpperCase())+'</div>' +
        '<div class="grow"><b>'+esc(p.name)+'</b><p class="sub">'+esc([p.sex, p.heightCm ? p.heightCm+' cm' : '', p.goal].filter(Boolean).join(' · ') || 'Sin más datos')+'</p></div><span class="chev">›</span></button>').join('') + '</div>'
    : '<div class="empty">Todavía no tienes usuarios.<br>Crea el primero con el botón de abajo.</div>';
  return '<div class="crumbs"><b>Usuarios</b></div><div class="content"><h1>Usuarios</h1>'+solicitudesHtml()+lista+
    '<button class="btn" data-act="nuevo">＋ Nuevo usuario</button></div>';
}
function vPaciente(){
  const p = pacienteActual();
  if (!p) return '<div class="content"><div class="empty">Usuario no encontrado.</div></div>';
  const t = (v, txt) => '<button role="tab" data-act="ptab" data-v="'+v+'" aria-selected="'+(S.ptab===v)+'">'+txt+'</button>';
  const tabs = '<div class="tabs" role="tablist">'+t('entreno','Entreno')+t('menu','Menú')+t('resumen','Resumen')+t('informe','Informe')+(S.compraOn ? t('compra','🛒 Compra') : '')+'</div>';
  const kg = kgDe();
  const cuerpo = S.ptab==='datos' ? vResumen(p) : S.ptab==='entreno' ? vEntreno(p) : S.ptab==='informe' ? vInforme(p) : S.ptab==='resumen' ? vResumenSem(p) : S.ptab==='compra' ? vCompraTab(p) : vMenuTab(p);
  return '<div class="crumbs"><a href="#" data-act="volver">Usuarios</a> › <b>'+esc(p.name)+'</b></div><div class="content">' +
    '<div class="pacthead"><h1>'+esc(p.name)+'</h1><button class="pesochip" data-act="pesoDlg" aria-label="Anotar peso">⚖️ '+(kg ? kgTxt(kg)+' kg' : 'Anotar peso')+'</button></div>' + avisosHtml(p) + tabs + cuerpo + '</div>';
}
function vResumen(p){
  const w = S.weights;
  const ultimo = w.length ? w[0] : null;
  return '<div class="card"><h3 style="margin-bottom:0">Peso</h3>' +
    '<div class="bigw">'+(ultimo ? kgTxt(ultimo.kg)+' kg' : 'Sin datos')+'</div>' +
    '<p class="sub" style="margin-bottom:12px">'+(ultimo ? 'Anotado el '+fechaCorta(ultimo.id) : 'Anota el primer peso.')+'</p>' +
    '<div class="btn-row"><input id="kg" inputmode="decimal" placeholder="kg, por ejemplo 72,5" style="flex:2"><button class="btn" style="flex:1" data-act="guardarPeso">Guardar</button></div>' +
    msgHtml() +
    (w.length > 1 ? '<div class="hist">'+w.slice(1).map(x => fechaCorta(x.id)+': '+kgTxt(x.kg)+' kg').join(' · ')+'</div>' : '') + '</div>' +
    vMedidasCard(p) + vCalCard(p) + vWorkOutCard(p) + vCompeticion(p) +
    '<div class="card"><h3>Datos</h3><p class="sub">'+esc([p.sex, p.birthYear ? 'nacido en '+p.birthYear : '', p.heightCm ? p.heightCm+' cm' : '', p.goal ? 'Objetivo: '+p.goal : ''].filter(Boolean).join(' · ') || 'Sin datos')+'</p>' +
    (p.notes ? '<p style="margin:8px 0 0">'+esc(p.notes)+'</p>' : '') + '</div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="editar">Editar datos</button><button class="btn danger" data-act="borrar">Eliminar</button></div>';
}
function vWorkOutCard(p){
  const l = linkDe(p.id);
  let cuerpo;
  if (!l || l.status === 'revoked' || l.status === 'rejected') {
    cuerpo = (l ? '<p class="sub" style="margin-bottom:10px">'+(l.status==='rejected' ? 'El usuario rechazó la solicitud.' : 'El usuario retiró el permiso.')+'</p>' : '') +
      '<p class="sub" style="margin-bottom:12px">Si el usuario usa WorkOut, puedes leer su semana, competiciones y peso, con su permiso.</p>' +
      '<button class="btn ghost" data-act="vincular">🔗 Vincular con WorkOut</button>';
  } else if (l.status === 'pending') {
    cuerpo = '<p class="sub" style="margin-bottom:12px">Solicitud enviada a <b>'+esc(l.email)+'</b>. Falta que el usuario la acepte entrando en esta app con ese correo.</p>' +
      '<button class="btn secondary" data-act="quitarVinculo" data-id="'+esc(l.id)+'">Cancelar solicitud</button>';
  } else {
    const w = S.wo[p.id];
    let datos = '';
    if (S.woMsg) datos = '<div class="msg err">'+esc(S.woMsg)+'</div>';
    else if (!l.clubId) datos = '<p class="sub">Su cuenta no es de atleta en WorkOut: solo se comparte el peso.</p>';
    else if (!w) datos = '<p class="sub">Cargando datos de WorkOut…</p>';
    else {
      const prox = w.comps.map(c => ({c, d:c.day||c.startDate})).filter(x => x.d >= iso(new Date())).sort((a,b)=>a.d<b.d?-1:1)[0];
      datos = '<p class="sub">'+w.plans.length+' semanas de entreno'+(prox ? ' · Próxima competición: <b>'+esc(prox.c.name||'Competición')+'</b> el '+fechaCorta(prox.d)+(prox.c.category ? ' ('+esc(prox.c.category)+')' : '') : '')+'</p>';
    }
    cuerpo = '<div class="notice ok" style="margin-bottom:10px">✓ Vinculado con WorkOut</div>' + datos +
      '<div class="btn-row" style="margin-top:12px"><button class="btn secondary" data-act="leerwo">Actualizar</button><button class="btn secondary" data-act="quitarVinculo" data-id="'+esc(l.id)+'">Quitar vínculo</button></div>';
  }
  return '<div class="card"><h3>WorkOut</h3>'+cuerpo+'</div>';
}
function vWorkOutSemana(p){
  const l = linkDe(p.id), w = S.wo[p.id];
  if (!l || l.status !== 'accepted' || !l.clubId) return '';
  if (!w) return '<div class="card"><p class="sub">Cargando datos de WorkOut…</p></div>';
  if (!w.plans.length) return '<div class="card"><p class="sub">Este atleta aún no tiene semanas en WorkOut.</p></div>';
  const sel = S.woPlanId && w.plans.some(x => x.id === S.woPlanId) ? S.woPlanId : w.plans[0].id;
  const comps = compsDeLaSemana(p.id);
  return '<div class="card"><h3>Proponer desde WorkOut</h3><p class="sub" style="margin-bottom:10px">Elige qué semana de WorkOut corresponde a estas fechas y se rellenan los niveles según la carga de cada día. Después puedes corregirlos.</p>' +
    '<div class="field"><label class="f" for="woplan">Semana de WorkOut</label><select id="woplan" data-act="woplan">'+w.plans.map(x => '<option value="'+esc(x.id)+'"'+(x.id===sel?' selected':'')+'>'+esc(nombrePlan(x))+'</option>').join('')+'</select></div>' +
    (comps.length ? '<p class="sub" style="margin-bottom:10px">'+comps.map(x => '🏆 '+esc(x.c.name||'Competición')+' · '+DIAS[(new Date(x.d+'T00:00').getDay()+6)%7]).join('<br>')+'</p>' : '') +
    '<button class="btn" data-act="proponer">Proponer niveles</button></div>';
}
/* ---------- calorías y macros ----------
   Gasto en reposo: Mifflin-St Jeor. Gasto del día = reposo × factor del nivel de entreno.
   Bajar peso: el déficit SOLO se aplica en Descanso y Baja, nunca en Media/Alta, ni el día
   de competición ni el anterior, y nunca por debajo del gasto en reposo.
   Subir peso: superávit en todos los días. */
const FACTOR = [1.2, 1.375, 1.55, 1.725];   // Descanso, Baja, Media, Alta
const DEFICIT = 0.15, SUPERAVIT = 0.10;
const PROT_G_KG = 2.0, GRASA_G_KG = 1.0, GRASA_MIN_G_KG = 0.7, CARB_MIN_G_KG = 3.0;
function tipoObjetivo(p){
  if (p.goalType) return p.goalType;
  const t = (p.goal || '').toLowerCase();
  return /baj|adelgaz|perd|defin/.test(t) ? 'bajar' : /sub|gan|volumen|masa/.test(t) ? 'subir' : 'mantener';
}
const claveComp = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
// Competiciones del usuario: las de WorkOut (fechas, con su permiso) + las puestas a mano.
// Las horas de pesaje y de inicio siempre las escribe el nutricionista (p.compData).
function compsDe(p){
  const w = S.wo[p.id], datos = p.compData || {}, out = [], vistas = {};
  (w ? w.comps : []).forEach(c => {
    const date = c.day || c.startDate; if (!date) return;
    const k = claveComp(c.id), d = datos[k] || {}; vistas[k] = true;
    out.push({key:k, name:c.name || 'Competición', date, category:c.category || '', weighIn:d.weighIn || '', start:d.start || '', manual:false});
  });
  Object.keys(datos).forEach(k => { if (vistas[k] || !datos[k].manual) return;
    out.push({key:k, name:datos[k].name || 'Competición', date:datos[k].date, category:'', weighIn:datos[k].weighIn || '', start:datos[k].start || '', manual:true}); });
  return out.filter(c => c.date).sort((a,b) => a.date < b.date ? -1 : 1);
}
const compsProximas = p => compsDe(p).filter(c => c.date >= iso(new Date()));
/* Fecha objetivo del peso: la que se haya puesto a mano; si no, la competición más próxima. */
function fechaObjetivo(p){
  if (p.targetDate) return {date:p.targetDate, comp:false};
  const c = compsProximas(p).sort((a, b) => a.date < b.date ? -1 : 1)[0];
  return c ? {date:c.date, comp:true, name:c.name} : {date:'', comp:false};
}
function diasCompeticion(pid){
  const p = S.patients.find(x => x.id === pid), out = {};
  (p ? compsDe(p) : []).forEach(c => { out[c.date] = true; out[sumaDias(c.date, -1)] = true; });
  return out;
}
function vCompeticion(p){
  const cs = compsProximas(p);
  const filas = cs.map(c => {
    const falta = !c.weighIn || !c.start;
    return '<div style="padding:12px 0;border-top:1px solid var(--t-line)"><b style="font-size:1.1em">'+esc(c.name)+'</b>' +
      '<p class="sub" style="margin:4px 0 10px">'+fechaCorta(c.date)+(c.category ? ' · '+esc(c.category) : '')+(c.manual ? ' · a mano' : '')+'<br>' +
      (falta ? '⏰ Faltan las horas' : 'Pesaje '+esc(c.weighIn)+' · Inicio '+esc(c.start))+'</p>' +
      '<button class="btn '+(falta ? '' : 'secondary')+'" style="width:100%" data-act="horasComp" data-k="'+esc(c.key)+'">'+(falta ? 'Poner horas' : 'Editar horas')+'</button></div>';
  }).join('');
  return '<div class="card"><h3>Competición</h3>' + (filas ? filas : '<p class="sub" style="margin-bottom:10px">No hay competiciones próximas.</p>') +
    '<button class="btn ghost" style="margin-top:10px" data-act="horasComp" data-k="">＋ Añadir competición a mano</button></div>';
}
/* Reparto semanal del déficit (o superávit). El ritmo pedido (kg/semana) se traduce en kcal de la semana
   y se reparte SOLO entre los días que lo admiten: Descanso y Baja (nunca Media, Alta ni competición).
   Cada día tiene un tope y nunca baja del gasto en reposo. Si el ritmo pedido no cabe, se dice cuánto cabe. */
const TOPE_DEFICIT = {1:0.20, 2:0.15}, TOPE_SUPERAVIT = 0.15, KCAL_KG = 7700, RITMO_BAJAR = 0.5, RITMO_SUBIR = 0.25;
const reposoDe = (p, kg) => 10*kg + 6.25*p.heightCm - 5*(new Date().getFullYear() - p.birthYear) + (p.sex === 'Hombre' ? 5 : -161);
function idxSemana(fecha){ return Math.round((new Date(fecha+'T00:00') - new Date(S.weekStart+'T00:00'))/864e5); }
let _planCache = {k:null, v:null};
function planSemana(p){
  const lv = S.levels, kg = kgDe();
  if (!lv || !lv.some(x => x) || !kg || !datosOk(p)) return null;
  const comp = diasCompeticion(p.id), obj = tipoObjetivo(p);
  const clave = [p.id, S.weekStart, lv.join(''), kg, obj, p.rateKg || '', p.targetKg || '', fechaObjetivo(p).date, p.heightCm, p.birthYear, p.sex, Object.keys(comp).sort().join(',')].join('|');
  if (_planCache.k === clave) return _planCache.v;
  const reposo = reposoDe(p, kg), dias = [];
  for (let i = 0; i < 7; i++) {
    const nivel = lv[i], mant = nivel ? reposo*FACTOR[nivel-1] : 0, fecha = sumaDias(S.weekStart, i);
    let cap = 0;
    if (nivel && obj === 'bajar' && nivel <= 2 && !comp[fecha]) cap = Math.max(Math.min(TOPE_DEFICIT[nivel]*mant, mant - reposo), 0);
    else if (nivel && obj === 'subir') cap = TOPE_SUPERAVIT*mant;
    dias.push({nivel, mant, cap});
  }
  const capacidad = dias.reduce((a, d) => a + d.cap, 0);
  const meta = parseFloat(p.targetKg), fObj = fechaObjetivo(p).date;
  let ritmoPedido, semRest = null, fechaPasada = false;
  if (obj !== 'mantener' && meta > 0 && fObj) {
    // El ritmo sale de la fecha: kilos que faltan entre las semanas que quedan (desde el lunes de la semana que se ve).
    const dias = Math.round((new Date(fObj+'T00:00') - new Date(S.weekStart+'T00:00'))/864e5);
    const falta = obj === 'bajar' ? kg - meta : meta - kg;
    if (falta <= 0) ritmoPedido = 0;
    else if (dias < 7) { fechaPasada = true; ritmoPedido = 0; }
    else { semRest = dias/7; ritmoPedido = falta/semRest; }
  } else ritmoPedido = obj === 'mantener' ? 0 : (parseFloat(p.rateKg) > 0 ? parseFloat(p.rateKg) : (obj === 'bajar' ? RITMO_BAJAR : RITMO_SUBIR));
  const pedido = ritmoPedido*KCAL_KG, aplicado = Math.min(pedido, capacidad);
  const adj = dias.map(d => !capacidad ? 0 : (obj === 'bajar' ? -1 : 1) * d.cap*aplicado/capacidad);
  const v = {adj, obj, capacidad, pedido, aplicado, ritmoPedido, ritmo: aplicado/KCAL_KG, limitado: pedido > capacidad + 1, semRest, fechaPasada, porFecha: semRest !== null, diasConDeficit: dias.filter(d => d.cap > 0).length};
  _planCache = {k:clave, v};
  return v;
}
function calcDia(p, nivel, fecha, kg, comp){
  const reposo = reposoDe(p, kg);
  const mant = reposo * FACTOR[nivel-1];
  const obj = tipoObjetivo(p), pl = planSemana(p), i = idxSemana(fecha);
  let kcal = mant, nota = '';
  const adj = pl && i >= 0 && i < 7 ? pl.adj[i] : 0;
  if (obj === 'bajar') {
    if (adj < -1) { kcal = mant + adj; nota = 'déficit'; }
    else nota = comp[fecha] ? 'competición: sin déficit' : 'sin déficit';
  } else if (obj === 'subir') { kcal = mant + adj; nota = adj > 1 ? 'superávit' : ''; }
  // Proteína fija. Grasa 1 g/kg, pero si así los carbohidratos quedan bajo 3 g/kg, la grasa baja
  // (hasta 0,7 g/kg) para protegerlos: son el combustible del entreno.
  const prot = PROT_G_KG*kg;
  let grasa = GRASA_G_KG*kg;
  if ((kcal - 4*prot - 9*grasa)/4/kg < CARB_MIN_G_KG) grasa = Math.max(GRASA_MIN_G_KG*kg, (kcal - 4*prot - 4*CARB_MIN_G_KG*kg)/9);
  const carb = Math.max((kcal - 4*prot - 9*grasa)/4, 0);
  if (carb/kg < CARB_MIN_G_KG) nota += (nota ? ' · ' : '') + 'carbohidratos bajos';
  return {kcal:Math.round(kcal/10)*10, prot:Math.round(prot), carb:Math.round(carb), grasa:Math.round(grasa), nota, carbKg:carb/kg, gasto:Math.round(mant/10)*10, reposo:Math.round(reposo)};
}
/* Tarjeta «Objetivo»: qué se pide, qué cabe de verdad esta semana y cuánto tardaría. */
function vObjetivo(p){
  const pl = planSemana(p), kg = kgDe(); if (!pl) return '';
  const obj = pl.obj, meta = parseFloat(p.targetKg);
  const nombre = obj === 'bajar' ? 'Bajar de peso' : obj === 'subir' ? 'Subir de peso' : 'Mantener el peso';
  const n1 = x => (Math.round(x*100)/100).toLocaleString('es-ES');
  let h = '<div class="card"><h3>Objetivo: '+nombre+'</h3>';
  if (obj === 'mantener') return h + '<p class="sub">Las kcal de cada día son iguales a lo que gasta. No hay déficit ni superávit.</p></div>';
  if (pl.fechaPasada) return h + '<p class="sub" style="color:var(--t-chg-fg)">La fecha objetivo ('+fechaCorta(fechaObjetivo(p).date)+') es esta semana o ya ha pasado, así que no se recorta nada. Cuando termine, elige una fecha nueva en «Editar usuario» (o espera a la siguiente competición).</p></div>';
  if (pl.porFecha) h += '<p style="margin:0 0 6px">Meta: <b>'+kgTxt(meta)+' kg</b> el <b>'+fechaCorta(fechaObjetivo(p).date)+'</b>'+(fechaObjetivo(p).comp ? ' (competición «'+esc(fechaObjetivo(p).name)+'»)' : '')+'. Tienes <b>'+kgTxt(kg)+' kg</b> y quedan unas <b>'+Math.round(pl.semRest)+' semanas</b>: hace falta '+(obj === 'bajar' ? 'bajar' : 'subir')+' <b>'+n1(pl.ritmoPedido)+' kg/semana</b> ('+fmtN(pl.pedido)+' kcal a la semana).</p>';
  else h += '<p style="margin:0 0 6px">'+(meta ? 'De <b>'+kgTxt(kg)+' kg</b> a <b>'+kgTxt(meta)+' kg</b> · ' : '')+'ritmo previsto <b>'+n1(pl.ritmoPedido)+' kg/semana</b> ('+fmtN(pl.pedido)+' kcal a la semana). Si hay una competición próxima o pones una fecha objetivo en «Editar usuario», el ritmo se calcula solo.</p>';
  if (pl.capacidad < 1) return h + '<p class="sub" style="color:var(--t-chg-fg)">Esta semana no hay días que admitan déficit (solo Descanso y Baja, y sin competición). Con tanta carga no se puede bajar peso sin quitar energía al entreno.</p></div>';
  h += '<p style="margin:0 0 6px">Esta semana cabe: <b>'+n1(pl.ritmo)+' kg/semana</b> ('+fmtN(pl.aplicado)+' kcal) repartidos en '+pl.diasConDeficit+' día'+(pl.diasConDeficit === 1 ? '' : 's')+' de '+(obj === 'bajar' ? 'Descanso/Baja' : 'la semana')+'.</p>';
  if (pl.limitado) h += '<p class="sub" style="color:var(--t-chg-fg)">⚠ Ese ritmo no cabe sin tocar los días de entreno. Más días de Descanso o Baja, o una fecha más lejana, lo harían posible. Los días de carga se mantienen siempre a mantenimiento.</p>';
  if (meta && pl.ritmo > 0.01) { const falta = Math.abs(kg - meta), sem = Math.ceil(falta/pl.ritmo); if ((obj === 'bajar' && meta < kg) || (obj === 'subir' && meta > kg)) h += '<p class="sub">'+(pl.porFecha && pl.limitado ? 'Con lo que cabe cada semana, llegarías a '+kgTxt(meta)+' kg hacia el <b>'+fechaCorta(sumaDias(S.weekStart, sem*7))+'</b>.' : 'A este ritmo, unas <b>'+sem+' semanas</b> para llegar a '+kgTxt(meta)+' kg.')+'</p>'; }
  return h + '</div>';
}
function vMacros(p){
  const lv = S.levels;
  if (!lv || !lv.some(x => x)) return '';
  const falta = [];
  if (!p.sex) falta.push('sexo'); if (!p.birthYear) falta.push('año de nacimiento'); if (!p.heightCm) falta.push('altura');
  const kg = S.weights.length ? S.weights[0].kg : null;
  if (!kg) falta.push('un peso');
  if (falta.length) return '<div class="card"><h3>Calorías y macros</h3><p class="sub">Para calcularlos falta: '+falta.join(', ')+'. Complétalo en Datos → Editar datos.</p></div>';
  const comp = diasCompeticion(p.id), obj = tipoObjetivo(p);
  const filas = DIAS.map((d,i) => {
    if (!lv[i]) return '';
    const r = calcDia(p, lv[i], sumaDias(S.weekStart,i), kg, comp);
    return '<div class="row"><div class="grow"><b>'+d+' · '+NIVELES[lv[i]-1]+'</b><p class="sub">P '+r.prot+' g · C '+r.carb+' g · G '+r.grasa+' g'+(r.nota ? ' · '+r.nota : '')+'</p></div><b>'+r.kcal+' kcal</b></div>';
  }).join('');
  return '<div class="card"><h3 style="margin-bottom:0">Calorías y macros</h3><p class="sub" style="margin-bottom:10px">Con '+kgTxt(kg)+' kg · objetivo: '+obj+'. '+(obj==='bajar' ? 'Solo hay déficit en Descanso y Baja; Media, Alta y competición van a mantenimiento.' : '')+'</p><div class="list">'+filas+'</div></div>';
}
/* ---------- menú semanal ----------
   Cada día se reparte en comidas (porcentaje de las kcal y macros del día). Para cada comida se elige
   la receta del recetario que mejor encaja y se ajusta la ración. Todo se puede cambiar a mano. */
const REPARTO_DEF = [['Desayuno',25],['Media mañana',10],['Almuerzo',25],['Postre almuerzo',5],['Merienda',10],['Cena',20],['Postre cena',5]];
const repartoDe = p => {
  const a = p.reparto;
  if (Array.isArray(a) && a.length === 7) return REPARTO_DEF.map((x,i) => [x[0], Number(a[i])||0]);
  if (Array.isArray(a) && a.length === 5) { // reparto antiguo: se saca el postre del almuerzo y de la cena
    const n = a.map(Number), pa = Math.round(n[2]/6), pc = Math.round(n[4]/5);
    return [['Desayuno',n[0]],['Media mañana',n[1]],['Almuerzo',n[2]-pa],['Postre almuerzo',pa],['Merienda',n[3]],['Cena',n[4]-pc],['Postre cena',pc]];
  }
  return REPARTO_DEF;
};
function kgDe(){ return S.weights.length ? S.weights[0].kg : null; }
function datosOk(p){ return !!(p.sex && p.birthYear && p.heightCm && kgDe()); }
function objetivoDia(p, i){
  if (!S.levels || !S.levels[i] || !datosOk(p)) return null;
  const r = calcDia(p, S.levels[i], sumaDias(S.weekStart,i), kgDe(), diasCompeticion(p.id));
  return {kcal:r.kcal, prot:r.prot, carb:r.carb, fat:r.grasa};
}
function aptaPara(r, slot){
  const u = norm(r.useIn || '');
  if (/^Postre/.test(slot)) return u.indexOf('postre') >= 0;
  if (slot === 'Desayuno') return u.indexOf('desayun') >= 0;
  if (slot === 'Almuerzo') return u.indexOf('almuerz') >= 0 || u.indexOf('comida') >= 0;
  if (slot === 'Cena') return u.indexOf('cena') >= 0;
  return u.indexOf('merienda') >= 0 || u.indexOf('media') >= 0 || u.indexOf('snack') >= 0 || u.indexOf('desayun') >= 0;
}
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
function escalaPara(r, t){ return Math.round(clamp(t.kcal / Math.max(r.kcal, 1), 0.5, 2.5) * 20) / 20; }
/* Error entre lo que da el menú y el objetivo. No es simétrico: quedarse corto de proteína es
   lo peor (y más si se quiere bajar peso); pasarse de grasa también; los hidratos, simétrico. */
function errMacros(v, t){
  const d = (x, o, minimo, wFalta, wSobra) => { const dif = x - o, den = Math.max(o, minimo); return (dif < 0 ? -dif*wFalta : dif*wSobra)/den; };
  return d(v.prot, t.prot, 10, 4, 0.4) + d(v.carb, t.carb, 15, 1, 1) + d(v.fat, t.fat, 8, 0.4, 2);
}
function puntua(r, t, usos, previa, delDia){
  const s = escalaPara(r, t);
  const e = errMacros({prot:r.prot*s, carb:r.carb*s, fat:r.fat*s}, t);
  let h = 0; String(r.id).split('').forEach(c => h = (h*31 + c.charCodeAt(0)) % 997);
  return e + 0.25*Math.abs(s - 1) + 0.35*(usos[r.id]||0) + (previa === r.id ? 1 : 0) + (delDia && delDia[r.id] ? 1.5 : 0) + (h % 7) * 0.01;
}
function comidaDe(r, slot, s){
  return {slot, rid:r.id, name:r.name, s, bk:r.kcal||0, bp:r.prot||0, bc:r.carb||0, bf:r.fat||0, bw:r.weight||0};
}
const valsComida = m => ({kcal:m.bk*m.s, prot:m.bp*m.s, carb:m.bc*m.s, fat:m.bf*m.s, g:m.bw*m.s});
const kcalMacros = r => 4*(r.prot||0) + 4*(r.carb||0) + 9*(r.fat||0);
/* Una receta es incoherente si sus kcal no cuadran con sus macros (4 kcal/g de proteína e hidratos, 9 de grasa). */
function recetaIncoherente(r){ const k = r.kcal||0, m = kcalMacros(r); return k > 0 && m > 0 && Math.abs(k - m) > Math.max(60, 0.2*Math.max(k, m)); }
function candidatas(slot){
  const buenas = S.recipes.filter(r => (r.kcal||0) > 0 && !recetaIncoherente(r));
  const todas = buenas.length >= 3 ? buenas : S.recipes.filter(r => (r.kcal||0) > 0);
  const aptas = todas.filter(r => aptaPara(r, slot));
  if (/^Postre/.test(slot)) return aptas;   // sin recetas de postre no se inventa ninguna
  return aptas.length ? aptas : todas;
}
const baseDeMenu = menu => menu.map(d => { const t = totalDia(d || {meals:[]}); return {kcal:Math.round(t.kcal), prot:Math.round(t.prot), carb:Math.round(t.carb), fat:Math.round(t.fat)}; });
async function guardarMenu(){
  try {
    const limpio = JSON.parse(JSON.stringify(S.menu));
    await refPac(S.pid).collection('weeks').doc(S.weekStart).set(Object.assign({menu:limpio, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}, S.menuBase ? {menuBase:S.menuBase} : {}), {merge:true});
    return true;
  } catch(e){ setMsg('No se pudo guardar el menú ('+((e && (e.code||e.message)) || 'error')+'). Lo que ves no está guardado.', false); console.error('menu', e); render(); return false; }
}
const fijasDe = p => (p.fijas !== undefined && p.fijas !== null) ? p.fijas : (S.prefs.fijas || {});
const fijasPropias = p => p.fijas !== undefined && p.fijas !== null;
const fijaDe = (p, slot, i) => {
  const f = fijasDe(p)[slot];
  if (!f || !f.rid || !Array.isArray(f.days) || f.days.indexOf(i) < 0) return null;
  const r = S.recipes.find(x => x.id === f.rid);
  return r ? {r, s:Number(f.s) > 0 ? Number(f.s) : 1} : null;
};
async function proponerMenu(){
  const p = pacienteActual(); if (!p) return;
  if (!S.recipes.length) { setMsg('Primero necesitas recetas en el Recetario.', false); render(); return; }
  const repAll = repartoDe(p), usos = {}, menu = [];
  const rep = repAll.filter(([slot]) => !/^Postre/.test(slot) || candidatas(slot).length);
  for (let i = 0; i < 7; i++) {
    const obj = objetivoDia(p, i), meals = [], hoy = {};
    if (obj) {
      // 1) comidas fijas del día; 2) el resto del día se reparte entre las demás comidas
      const fijas = {}; let resto = {kcal:obj.kcal, prot:obj.prot, carb:obj.carb, fat:obj.fat}, pctLibre = 0;
      rep.forEach(([slot, pct]) => {
        const f = fijaDe(p, slot, i);
        if (f) { fijas[slot] = f; resto.kcal -= f.r.kcal*f.s; resto.prot -= f.r.prot*f.s; resto.carb -= f.r.carb*f.s; resto.fat -= f.r.fat*f.s; hoy[f.r.id] = true; }
        else pctLibre += pct;
      });
      ['kcal','prot','carb','fat'].forEach(k => { resto[k] = Math.max(resto[k], 0); });
      rep.forEach(([slot, pct]) => {
        if (fijas[slot]) { const m = comidaDe(fijas[slot].r, slot, fijas[slot].s); m.fija = true; meals.push(m); return; }
        const q = pctLibre ? pct / pctLibre : 0;
        const t = {kcal:resto.kcal*q, prot:resto.prot*q, carb:resto.carb*q, fat:resto.fat*q};
        const previa = menu[i-1] && (menu[i-1].meals.find(m => m.slot === slot) || {}).rid;
        const mejor = candidatas(slot).map(r => ({r, sc:puntua(r, t, usos, previa, hoy)})).sort((a,b) => a.sc - b.sc)[0];
        if (mejor) { usos[mejor.r.id] = (usos[mejor.r.id]||0) + 1; hoy[mejor.r.id] = true; meals.push(comidaDe(mejor.r, slot, escalaPara(mejor.r, t))); }
        else meals.push({slot, rid:null});
      });
    }
    if (obj) afinarDia(obj, meals, menu[i-1], usos, (S.levels && S.levels[i]) || 0);
    menu.push({meals: obj ? repAll.map(([sl]) => meals.find(m => m.slot === sl) || {slot:sl, rid:null}) : meals});
  }
  S.menu = menu; S.menuBase = baseDeMenu(menu); S.ptab = 'menu'; S.mdia = null; setMsg('Menú generado. Toca un día para ver sus comidas, marcar lo que has hecho o cambiar un plato.', true); render(); window.scrollTo(0, 0); await guardarMenu();
}
/* Segunda pasada: ajusta el día ENTERO (no cada comida por separado) para que las kcal cuadren y
   la proteína no se quede corta ni la grasa se pase. Prueba otras recetas y raciones comida a comida. */
function afinarDia(obj, meals, diaPrevio, usos, nivel){
  const suma = ms => { const t = {kcal:0, prot:0, carb:0, fat:0}; ms.forEach(m => { if (m.rid) { const v = valsComida(m); t.kcal += v.kcal; t.prot += v.prot; t.carb += v.carb; t.fat += v.fat; } }); return t; };
// En los días de carga (Media y Alta) quedarse corto de energía es lo peor: pesa el doble que pasarse.
  const costeDia = ms => { const t = suma(ms), dif = t.kcal - obj.kcal, carga = nivel >= 3;
    const kc = dif < 0 ? Math.max(-dif - (carga ? 0.01 : 0.03)*obj.kcal, 0)*(carga ? 10 : 3) : Math.max(dif - 0.03*obj.kcal, 0)*3;
    return kc/obj.kcal + errMacros(t, obj); };
  for (let pasada = 0; pasada < 3; pasada++) {
    let mejoro = false;
    meals.forEach((m, j) => {
      if (!m.rid || m.fija) return;
      const otras = meals.filter((x, k) => k !== j && x.rid), kOtras = suma(otras).kcal;
      const previa = diaPrevio && (diaPrevio.meals.find(x => x.slot === m.slot) || {}).rid;
      const enDia = {}; otras.forEach(x => { enDia[x.rid] = true; });
      const extra = r => 0.35*((usos[r.id]||0) - (r.id === m.rid ? 1 : 0)) + (previa === r.id ? 1 : 0) + (enDia[r.id] ? 1.5 : 0);
      let mejor = {c:costeDia(meals) + 0.15*Math.abs(m.s - 1) + extra({id:m.rid}), m};
      candidatas(m.slot).forEach(r => {
        const s0 = clamp((obj.kcal - kOtras)/Math.max(r.kcal, 1), 0.5, 2.5);
        [0, -0.1, 0.1].forEach(dl => {
          const s = Math.round(clamp(s0 + dl, 0.5, 2.5)*20)/20, cand = comidaDe(r, m.slot, s);
          const c = costeDia(otras.concat([cand])) + 0.15*Math.abs(s - 1) + extra(r);
          if (c < mejor.c - 1e-9) mejor = {c, m:cand};
        });
      });
      if (mejor.m !== m) { usos[m.rid] = Math.max((usos[m.rid]||1) - 1, 0); usos[mejor.m.rid] = (usos[mejor.m.rid]||0) + 1; meals[j] = mejor.m; mejoro = true; }
    });
    if (!mejoro) break;
  }
}
/* Objetivo de cada comida de un día: las fijas no se tocan; el resto se reparte lo que queda. */
function objetivosComidas(p, i, meals){
  const obj = objetivoDia(p, i); if (!obj) return null;
  const rep = repartoDe(p); let resto = {kcal:obj.kcal, prot:obj.prot, carb:obj.carb, fat:obj.fat}, libre = 0;
  meals.forEach((m, j) => {
    const pct = (rep.find(x => x[0] === m.slot) || [m.slot, 0])[1];
    if (m.rid && m.fija) { const v = valsComida(m); resto.kcal -= v.kcal; resto.prot -= v.prot; resto.carb -= v.carb; resto.fat -= v.fat; }
    else libre += pct;
  });
  ['kcal','prot','carb','fat'].forEach(k => { resto[k] = Math.max(resto[k], 0); });
  return meals.map(m => {
    if (m.rid && m.fija) return null;
    const pct = (rep.find(x => x[0] === m.slot) || [m.slot, 0])[1], q = libre ? pct/libre : 0;
    return {kcal:resto.kcal*q, prot:resto.prot*q, carb:resto.carb*q, fat:resto.fat*q};
  });
}
/* ---------- menú enlazado: un usuario copia el menú de otro (pareja, familia) ---------- */
const esCopia = p => !!p && p.menuMode === 'copia' && !!p.copiaDe;
const fuenteDe = p => esCopia(p) ? S.patients.find(x => x.id === p.copiaDe && x.id !== p.id) : null;
function dlgModoMenu(){
  const p = pacienteActual(); if (!p) return;
  const otros = S.patients.filter(x => x.id !== p.id && x.menuMode !== 'copia');
  const act = esCopia(p) && fuenteDe(p) ? fuenteDe(p).id : null;
  abrirDlg('<h2>Menú de '+esc(p.name)+'</h2><p class="sub" style="margin-bottom:12px">¿Este menú es propio, o es una copia del menú de otro usuario con el que convive? En una copia se repiten los mismos platos y se ajustan las raciones a su peso y objetivos.</p>' +
    '<div class="list"><button class="row" data-act="modoMenuElegir" data-v="propio"><div class="grow"><b>Menú propio (principal)</b><p class="sub">'+(p.menuMode === 'propio' ? '✔ ' : '')+'Se genera con sus recetas y objetivos. Otros usuarios podrán copiarlo.</p></div><span class="chev">›</span></button>' +
    otros.map(x => '<button class="row" data-act="modoMenuElegir" data-v="copia" data-id="'+esc(x.id)+'"><div class="grow"><b>Copia del menú de '+esc(x.name)+'</b><p class="sub">'+(act === x.id ? '✔ ' : '')+'Mismos platos que '+esc(x.name)+', con ración propia.</p></div><span class="chev">›</span></button>').join('') + '</div>' +
    (otros.length ? '' : '<p class="sub" style="margin-top:10px">No hay otros usuarios con menú propio a los que enlazar.</p>') +
    '<button class="btn ghost" style="margin-top:12px" data-act="cerrar">Cancelar</button>');
}
async function elegirModoMenu(modo, id){
  const p = pacienteActual(); if (!p) return;
  const datos = modo === 'copia' ? {menuMode:'copia', copiaDe:id} : {menuMode:'propio', copiaDe:null};
  try { await refPac(p.id).update(datos); } catch(e){ cerrarDlg(); setMsg('No se pudo guardar el enlace ('+((e && (e.code||e.message)) || 'error')+').', false); render(); return; }
  Object.assign(p, datos);
  cerrarDlg();
  if (S.trasModo) { S.trasModo = false; if (modo === 'copia') copiarDeUsuario(); else proponerMenu(); return; }
  setMsg(modo === 'copia' ? 'Menú enlazado: copia del de '+((fuenteDe(p) || {}).name || '')+'. Pulsa el botón de abajo para copiarlo.' : 'Menú propio.', true); render();
}
async function copiarDeUsuario(){
  const p = pacienteActual(), f = fuenteDe(p);
  if (!p || !f) { setMsg('El usuario del que se copia ya no existe. Elige otra opción en «Enlace del menú».', false); render(); return; }
  let src;
  try { const d = await refPac(f.id).collection('weeks').doc(S.weekStart).get(); src = d.exists && Array.isArray(d.data().menu) ? d.data().menu : null; }
  catch(e){ setMsg('No se pudo leer el menú de '+f.name+' ('+((e && (e.code||e.message)) || 'error')+').', false); render(); return; }
  if (!src || !src.some(d => d && d.meals && d.meals.some(m => m.rid))) { setMsg('Esta semana '+f.name+' aún no tiene menú. Genéralo primero en su ficha y vuelve aquí.', false); render(); return; }
  const previo = S.menu || [], menu = [], sinObj = [];
  for (let i = 0; i < 7; i++) {
    const sd = src[i];
    if (!sd || !sd.meals || !sd.meals.some(m => m.rid)) { menu.push(previo[i] && previo[i].manualDia ? previo[i] : {meals:[]}); continue; }
    const pd = (previo[i] && previo[i].meals) || [];
    const reg = JSON.parse(JSON.stringify(sd.meals.filter(m => !m.extra))), ext = JSON.parse(JSON.stringify(sd.meals.filter(m => m.extra && m.rid)));
    [].concat(reg, ext).forEach(m => { delete m.fija; delete m.real; delete m.manual; });
    const t = objetivosComidas(p, i, reg);
    if (!t) sinObj.push(DIAS[i]);
    let kS = 0, kD = 0;
    reg.forEach((m, j) => {
      const r = m.rid && recetaPorId(m.rid); if (!r) return;
      kS += (m.bk||0) * (m.s||1);
      const sd0 = m.s; if (t && t[j] && t[j].kcal > 0 && r.kcal > 0) m.s = escalaPara(r, t[j]);
      kD += (m.bk||0) * (m.s||1);
    });
    const ratio = kS > 0 && kD > 0 ? kD / kS : 1;
    ext.forEach(m => { m.s = Math.round(clamp((m.s||1) * ratio, 0.25, 3) * 20) / 20; });
    // lo que ya cambiaste a mano en este menú se respeta
    const manuales = pd.filter(m => m.manual);
    const res = reg.map(m => manuales.find(x => x.slot === m.slot && !x.extra) || m);
    const usados = res.map(m => m.slot);
    manuales.filter(m => m.extra).forEach(m => { res.push(m); });
    ext.forEach(m => { let n = 1, nom = m.slot; while (res.some(x => x.slot === nom)) { n++; nom = 'Adicional '+n; } m.slot = nom; res.push(m); });
    manuales.filter(m => !m.extra && usados.indexOf(m.slot) < 0).forEach(m => res.push(m));
    menu.push({meals:res});
  }
  S.menu = menu; S.menuBase = baseDeMenu(menu); S.ptab = 'menu'; S.mdia = null;
  setMsg('Menú copiado del de '+f.name+' y ajustado a las raciones de '+p.name+'.'+(sinObj.length ? ' Ojo: faltan los niveles de entreno de '+sinObj.join(', ')+' y esos días se han dejado con las raciones originales.' : '')+' Toca un día para ver sus comidas.', true);
  render(); window.scrollTo(0, 0); await guardarMenu();
}
/* ---------- copiar menú de otra semana ---------- */
async function dlgCopiarSemana(){
  abrirDlg('<h2>Copiar menú de otra semana</h2><div class="empty">Buscando semanas…</div>');
  try {
    const snap = await refPac(S.pid).collection('weeks').get();
    S.semanasMenu = snap.docs.map(d => ({id:d.id, menu:d.data().menu, levels:d.data().levels}))
      .filter(w => w.id !== S.weekStart && Array.isArray(w.menu) && w.menu.some(d => d.meals && d.meals.some(m => m.rid))).sort((a,b) => a.id < b.id ? 1 : -1);
  } catch(e){ abrirDlg('<h2>Copiar menú</h2><div class="msg err">No se pudieron leer las semanas ('+esc((e && (e.code||e.message)) || 'error')+').</div><button class="btn ghost" data-act="cerrar">Cerrar</button>'); return; }
  if (!S.semanasMenu.length) { abrirDlg('<h2>Copiar menú de otra semana</h2><div class="empty">Este usuario aún no tiene menús en otras semanas.</div><button class="btn ghost" data-act="cerrar">Cerrar</button>'); return; }
  abrirDlg('<h2>Copiar menú de otra semana</h2><p class="sub" style="margin-bottom:12px">Se copiará a la semana del '+fechaCorta(S.weekStart).slice(0,5)+'. Sustituye el menú actual de esa semana.</p>' +
    '<label style="display:flex;gap:10px;align-items:center;margin-bottom:12px;font-size:17px"><input id="cp_aj" type="checkbox" checked style="width:24px;min-height:24px"> Ajustar las raciones a los objetivos de esta semana</label>' +
    '<div class="list">' + S.semanasMenu.map(w => '<button class="row" data-act="copiarDe" data-w="'+esc(w.id)+'"><div class="grow"><b>'+fechaCorta(w.id).slice(0,5)+' – '+fechaCorta(sumaDias(w.id,6)).slice(0,5)+'</b><p class="sub">'+w.menu.filter(d => d.meals && d.meals.some(m => m.rid)).length+' días con menú</p></div><span class="chev">›</span></button>').join('') + '</div>' +
    '<button class="btn ghost" style="margin-top:12px" data-act="cerrar">Cancelar</button>');
}
async function copiarDe(wid){
  const w = (S.semanasMenu || []).find(x => x.id === wid), p = pacienteActual(); if (!w || !p) return;
  const ajustar = $('#cp_aj') && $('#cp_aj').checked;
  const menu = JSON.parse(JSON.stringify(w.menu));
  if (ajustar) menu.forEach((dia, i) => {
    const t = objetivosComidas(p, i, dia.meals || []); if (!t) return;
    dia.meals.forEach((m, j) => { const r = m.rid && recetaPorId(m.rid); if (r && t[j] && r.kcal > 0) m.s = escalaPara(r, t[j]); });
  });
  S.menu = menu; S.menuBase = baseDeMenu(menu); cerrarDlg(); setMsg('Menú copiado de la semana del '+fechaCorta(wid).slice(0,5)+'. Toca cualquier comida para cambiarla.', true); render(); await guardarMenu();
}
const CERO = {kcal:0, prot:0, carb:0, fat:0, g:0};
const valsReal = m => m.real ? (m.real.none ? CERO : valsComida(m.real)) : valsComida(m);
const delta = (x, d) => (x >= 0 ? '+' : '−') + kgTxt(Math.abs(Math.round(x*Math.pow(10, d||0))/Math.pow(10, d||0)));
function txtVariacion(a, b){ // b (real) respecto a a (planificado)
  return delta(b.kcal-a.kcal, 0)+' kcal · P '+delta(b.prot-a.prot, 1)+' · C '+delta(b.carb-a.carb, 1)+' · G '+delta(b.fat-a.fat, 1);
}
function totalReal(dia){
  const t = {kcal:0, prot:0, carb:0, fat:0};
  (dia.meals||[]).forEach(m => { if (m.rid) { const v = valsReal(m); t.kcal += v.kcal; t.prot += v.prot; t.carb += v.carb; t.fat += v.fat; } });
  return t;
}
const hayReal = dia => (dia.meals||[]).some(m => m.rid && (m.real || m.estado === 'hecho'));
function dlgReal(){
  const p = pacienteActual(), sl = S.slot; if (!p || !sl) return;
  const m = S.menu[sl.d].meals[sl.m], plan = valsComida(m), ref = refDe(m);
  const q = norm(S.realQ || ''), libre = !!(q || S.realModo === 'libre');
  const buenas = S.recipes.filter(r => (r.kcal||0) > 0);
  let lista;
  if (!libre) lista = buenas.filter(r => r.id !== m.rid).map(r => ({r, sim:simPlato(r, plan, ref)})).sort((a, b) => b.sim - a.sim).slice(0, 8);
  else lista = (q ? buenas.filter(r => norm([r.name, (r.ingredients||[]).join(' ')].join(' ')).indexOf(q) >= 0) : buenas.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'))).slice(0, q ? 30 : 60).map(r => ({r}));
  let h = '<h2>¿Qué has comido?</h2><p class="sub" style="margin-bottom:10px">'+DIAS[sl.d]+' · '+esc(m.slot)+' · previsto: '+esc(m.name)+' ('+Math.round(plan.kcal)+' kcal). Toca un plato y ya está.</p>' +
    modoBotones(libre, 'realModo') +
    (libre ? '<div class="field"><input id="rq2" type="search" value="'+esc(S.realQ||'')+'" placeholder="Buscar plato…" autocomplete="off" aria-label="Buscar plato"></div>' : '') +
    (lista.length ? '<div class="list">'+lista.map(x => { const r = x.r, sc = Math.round(clamp(plan.kcal/Math.max(r.kcal,1), 0.3, 3)*20)/20;
      return '<button class="row" data-act="elegirReal" data-id="'+esc(r.id)+'"><div class="grow"><b>'+esc(r.name)+'</b>'+(x.sim != null ? ' <span style="font-weight:800;color:var(--t-accent)">'+x.sim+' % similar</span>' : '')+'<p class="sub">ración ×'+kgTxt(sc)+' · '+Math.round(r.kcal*sc)+' kcal · P '+r1(r.prot*sc)+' · C '+r1(r.carb*sc)+' · G '+r1(r.fat*sc)+'</p></div><span class="chev">›</span></button>'; }).join('')+'</div>' : '<p class="sub">Sin resultados.</p>') +
    '<details class="card" style="margin-top:12px"><summary style="font-weight:800;font-size:17px">✍ Escribir lo que he comido</summary><div class="field" style="margin-top:10px"><textarea id="rl_txt" rows="3" placeholder="150 g de pollo&#10;100 g de arroz" style="padding:12px 14px;line-height:1.4" aria-label="Ingredientes"></textarea></div><div class="msg err" id="rl_msg"></div><button class="btn secondary" data-act="realLibre">🧮 Calcular y guardar</button></details>' +
    '<div class="btn-row" style="margin-top:12px"><button class="btn secondary" data-act="comidaDlg" data-d="'+sl.d+'" data-m="'+sl.m+'">‹ Volver</button></div>';
  abrirDlg(h);
}
function realLibre(){
  const sl = S.slot, t = ($('#rl_txt').value || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (!t.length) { $('#rl_msg').textContent = 'Escribe lo que has comido.'; return; }
  const e = RPT_RECETAS.estimarMacros(t, 1);
  if (e.noReconocidos.length || !(e.kcal > 0)) { $('#rl_msg').textContent = e.noReconocidos.length ? 'No reconozco: '+e.noReconocidos.join(', ')+'. Escribe cantidades en gramos o añade sus valores entre corchetes.' : 'No he podido calcular las calorías.'; return; }
  cambiarSlot(m => { delete m.estado; m.real = {slot:m.slot, rid:'libre', name:'Otro: '+t.join(', ').slice(0, 70), s:1, bk:e.kcal, bp:e.prot, bc:e.carb, bf:e.grasa, bw:e.peso}; }, false, null, dlgComida);
}
function totalDia(dia){
  const t = {kcal:0, prot:0, carb:0, fat:0};
  (dia.meals||[]).forEach(m => { if (m.rid) { const v = valsComida(m); t.kcal += v.kcal; t.prot += v.prot; t.carb += v.carb; t.fat += v.fat; } });
  return t;
}
const r1 = x => kgTxt(Math.round(x*10)/10);
/* ---------- comidas: hecho / no hecho / cambiado ---------- */
const CERO0 = {kcal:0, prot:0, carb:0, fat:0};
const sumaV = (a, b) => ({kcal:a.kcal+b.kcal, prot:a.prot+b.prot, carb:a.carb+b.carb, fat:a.fat+b.fat});
function estMeal(m){ if (!m || !m.rid) return 'vacia'; if (m.real) return m.real.none ? 'no' : 'cambio'; return m.estado === 'hecho' ? 'hecho' : 'pend'; }
function valsConsum(m){ const e = estMeal(m); return e === 'hecho' ? valsComida(m) : e === 'cambio' ? valsComida(m.real) : CERO0; }
function resumenDia(dia){
  let cons = CERO0, pend = CERO0, n = 0, nc = 0;
  (dia.meals || []).forEach(m => { const e = estMeal(m); if (e === 'vacia') return; n++; if (e === 'pend') pend = sumaV(pend, valsComida(m)); else { nc++; cons = sumaV(cons, valsConsum(m)); } });
  return {cons, pend, n, nc, proj:sumaV(cons, pend)};
}
const CHIP = {hecho:['✅ Hecho','var(--t-good-fg)'], no:['✖ No lo he hecho','var(--t-bad-fg)'], cambio:['🔁 He comido otra cosa','var(--t-chg-fg)'], pend:['⏳ Pendiente','var(--t-muted)'], vacia:['＋ Elegir plato','var(--t-muted)']};
const chip = e => '<span style="font-weight:800;font-size:17px;color:'+CHIP[e][1]+'">'+CHIP[e][0]+'</span>';
const barra = (pct, col) => '<div style="height:10px;border-radius:6px;background:var(--t-line);overflow:hidden;margin:8px 0 6px"><div style="height:100%;width:'+Math.min(100, Math.round(pct*100))+'%;background:'+col+'"></div></div>';
const macTxt = v => fmtN(v.kcal)+' kcal · P '+Math.round(v.prot)+' · C '+Math.round(v.carb)+' · G '+Math.round(v.fat);
/* Cuánto se parece una receta a la comida actual: se compara con la misma energía y se miran los macros. */
const BASES = ['pollo','pavo','ternera','cerdo','lomo','atun','salmon','merluza','bacalao','gamba','huevo','tofu','lentej','garbanzo','arroz','pasta','patata','tortilla','wrap','pan'];
function textoPlato(r){ return norm([r && r.name, ((r && r.ingredients) || []).join(' ')].join(' ')); }
function baseComun(r, ref){ // ingredientes principales que comparten (pollo, arroz, tortilla…)
  const a = textoPlato(r), b = textoPlato(ref); return BASES.filter(w => a.indexOf(w) >= 0 && b.indexOf(w) >= 0);
}
function simPlato(r, v, ref){ // parecido nutricional + pequeño empujón si comparten ingrediente principal
  const c = baseComun(r, ref), prot = c.filter(w => BASES.indexOf(w) < 12);
  return Math.min(100, similitud(r, v) + (prot.length ? 8 : 0) + (c.length > prot.length ? 3 : 0));
}
function refDe(m){ const r = m.rid && recetaPorId(m.rid); return r || {name:m.name, ingredients:m.ing || []}; }
function modoBotones(libre, act){
  return '<div class="btn-row" style="margin-bottom:12px"><button class="btn'+(libre ? ' secondary' : '')+'" data-act="'+act+'" data-n="sim">✨ Recomendar similar</button><button class="btn'+(libre ? '' : ' secondary')+'" data-act="'+act+'" data-n="libre">🔎 Elegir plato libre</button></div>';
}
function similitud(r, v){
  const s = Math.round(clamp(v.kcal/Math.max(r.kcal, 1), 0.5, 2.5)*20)/20;
  const x = {kcal:r.kcal*s, prot:r.prot*s, carb:r.carb*s, fat:r.fat*s};
  const err = 0.15*Math.abs(x.kcal-v.kcal)/Math.max(v.kcal, 50) + 0.4*Math.abs(x.prot-v.prot)/Math.max(v.prot, 8) + 0.25*Math.abs(x.carb-v.carb)/Math.max(v.carb, 12) + 0.2*Math.abs(x.fat-v.fat)/Math.max(v.fat, 6);
  return Math.round(100*clamp(1 - err, 0, 1));
}
/* Desajuste del día: lo previsto (registrado + pendiente) frente al objetivo. */
function ajusteDia(p, i){
  const obj = objetivoDia(p, i), dia = S.menu && S.menu[i]; if (!obj || !dia || !dia.meals) return null;
  const rd = resumenDia(dia), pr = rd.proj;
  const d = {kcal:obj.kcal-pr.kcal, prot:obj.prot-pr.prot, carb:obj.carb-pr.carb, fat:obj.fat-pr.fat}, msgs = [];
  const tk = Math.max(120, 0.06*obj.kcal);
  if (d.kcal > tk) msgs.push('Te faltan unas '+Math.round(d.kcal)+' kcal'); else if (d.kcal < -tk) msgs.push('Te pasas unas '+Math.round(-d.kcal)+' kcal');
  if (d.prot > Math.max(10, 0.1*obj.prot)) msgs.push('Faltan '+Math.round(d.prot)+' g de proteína');
  if (d.carb > Math.max(25, 0.12*obj.carb)) msgs.push('Faltan '+Math.round(d.carb)+' g de hidratos'); else if (d.carb < -Math.max(30, 0.15*obj.carb)) msgs.push('Sobran '+Math.round(-d.carb)+' g de hidratos');
  if (d.fat < -Math.max(10, 0.2*obj.fat)) msgs.push('Sobran '+Math.round(-d.fat)+' g de grasa');
  return {obj, rd, d, msgs, alerta:msgs.length > 0};
}
const COMPL = {prot:['yogur proteico','claras de huevo','pechuga de pavo','atun'], carb:['platano','pan integral','arroz cocido','copos de avena'], fat:['nueces','almendra','aceite de oliva']};
const NOMBRE_COMPL = {'claras de huevo':'claras de huevo','atun':'atún','platano':'plátano','copos de avena':'copos de avena'};
function sugerencias(ad){
  const n = {prot:Math.max(ad.d.prot, 0), carb:Math.max(ad.d.carb, 0), fat:Math.max(ad.d.fat, 0)};
  const rel = {prot:n.prot/Math.max(ad.obj.prot, 1), carb:n.carb/Math.max(ad.obj.carb, 1), fat:n.fat/Math.max(ad.obj.fat, 1)};
  let k = Object.keys(rel).sort((a, b) => rel[b] - rel[a])[0];
  if (rel[k] < 0.05) { if (ad.d.kcal > 120) k = 'carb'; else return []; }
  const need = n[k] > 0 ? n[k] : ad.d.kcal/4;
  return COMPL[k].map(nombre => {
    const e = RPT_RECETAS.estimarMacros(['100 g '+nombre], 1), per = k === 'fat' ? e.grasa : e[k]; if (!per || per < 1) return null;
    const g = clamp(Math.round(need/(per/100)/5)*5, 20, 250), f = g/100;
    return {key:nombre, g, kcal:e.kcal*f, prot:e.prot*f, carb:e.carb*f, fat:e.grasa*f};
  }).filter(Boolean).slice(0, 3);
}
async function addComplemento(d, nombre, g){
  const dia = S.menu[d]; if (!dia) return;
  const e = RPT_RECETAS.estimarMacros([g+' g '+nombre], 1), usados = dia.meals.map(m => m.slot);
  let n = 1, slot = 'Complemento'; while (usados.indexOf(slot) >= 0) { n++; slot = 'Complemento '+n; }
  dia.meals.push({slot, rid:'alim:'+nombre, name:g+' g de '+(NOMBRE_COMPL[nombre] || nombre), s:1, bk:e.kcal, bp:e.prot, bc:e.carb, bf:e.grasa, bw:g, extra:true, alimento:true, ing:[g+' g '+nombre], manual:true});
  setMsg('Añadido: '+g+' g de '+(NOMBRE_COMPL[nombre] || nombre)+' al '+DIAS[d].toLowerCase()+'.', true);
  render(); await guardarMenu();
}
function tarjetaDia(p, i){
  const dia = S.menu[i], lvl = S.levels && S.levels[i], tit = esc(DIAS[i])+(lvl ? ' · '+NIVELES[lvl-1] : '');
  if (!dia || !dia.meals || !dia.meals.some(m => m.rid)) return '<div class="row" style="opacity:.65"><div class="grow"><b>'+tit+'</b><p class="sub">Sin menú</p></div></div>';
  const obj = objetivoDia(p, i), rd = resumenDia(dia), ad = ajusteDia(p, i), pct = obj ? rd.proj.kcal/obj.kcal : 1;
  return '<button class="row" data-act="diaMenu" data-d="'+i+'"><div class="grow"><b>'+tit+'</b>' +
    '<p class="sub">'+rd.nc+' de '+rd.n+' comidas registradas</p>'+barra(rd.nc/Math.max(rd.n, 1), 'var(--t-accent)') +
    '<p class="sub">Previsto: '+fmtN(rd.proj.kcal)+(obj ? ' de '+obj.kcal : '')+' kcal'+(obj ? ' ('+Math.round(pct*100)+' %)' : '')+'</p>' +
    (ad && ad.alerta ? '<p class="sub" style="color:var(--t-chg-fg);font-weight:800">⚠ '+esc(ad.msgs[0])+'</p>' : '')+'</div><span class="chev">›</span></button>';
}
function tarjetaComida(i, j, m){
  const e = estMeal(m), num = '<span class="mnum">'+(j+1)+'</span>';
  if (e === 'vacia') return '<button class="mcard vacia" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'">'+num+'<div class="mbody"><b class="mt">'+esc(m.slot)+'</b><p class="sub">Sin plato · toca para elegir</p></div><span class="chev">＋</span></button>';
  const v = valsComida(m), marca = (m.fija ? ' 📌' : '')+(m.manual ? ' ✎' : '')+(m.ajustada ? ' ⚖' : '');
  let cuerpo;
  if (e === 'cambio') {
    const rv = valsComida(m.real);
    cuerpo = '<p class="mplato">'+esc(m.real.name)+'</p>' +
      '<p class="mkcal">'+Math.round(rv.kcal)+' kcal <small>· P '+r1(rv.prot)+' · C '+r1(rv.carb)+' · G '+r1(rv.fat)+'</small></p>' +
      '<p class="sub mprev">Previsto: '+esc(m.name)+' · '+Math.round(v.kcal)+' kcal ('+delta(rv.kcal-v.kcal, 0)+')</p>';
  } else if (e === 'no') {
    cuerpo = '<p class="mplato mtach">'+esc(m.name)+'</p><p class="sub">No se comió · '+txtVariacion(v, CERO0)+'</p>';
  } else {
    cuerpo = '<p class="mplato">'+esc(m.name)+'</p>' +
      '<p class="sub">×'+kgTxt(Math.round(m.s*100)/100)+(m.bw ? ' · '+Math.round(v.g)+' g' : '')+' · '+Math.round(v.kcal)+' kcal · P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+'</p>';
  }
  return '<button class="mcard e-'+e+'" data-act="comidaDlg" data-d="'+i+'" data-m="'+j+'">'+num+'<div class="mbody"><b class="mt">'+esc(m.slot)+'</b>'+marca+cuerpo+
    '<p style="margin-top:4px">'+chip(e)+'</p></div><span class="chev">›</span></button>';
}
const LET = ['L','M','X','J','V','S','D'];
function diaDefecto(){ const h = iso(new Date()), i = idxSemana(h); return i >= 0 && i < 7 ? i : 0; }
function pildoras(p){
  let h = '<div class="dpills">';
  for (let i = 0; i < 7; i++) {
    const dia = S.menu[i], hay = dia && dia.meals && dia.meals.some(m => m.rid), rd = hay ? resumenDia(dia) : null, ad = hay ? ajusteDia(p, i) : null;
    const punto = !hay ? '' : (ad && ad.alerta ? '<i class="dot warn"></i>' : (rd.nc === rd.n && rd.n ? '<i class="dot ok"></i>' : rd.nc ? '<i class="dot part"></i>' : ''));
    h += '<button class="dpill'+(S.mdia === i ? ' on' : '')+(hay ? '' : ' off')+'" data-act="diaMenu" data-d="'+i+'" aria-label="'+esc(DIAS[i])+'"><span class="dl">'+LET[i]+punto+'</span><span class="dn">'+sumaDias(S.weekStart, i).slice(8)+'</span></button>';
  }
  return h + '<button class="dpill'+(S.mdia === 'semana' ? ' on' : '')+'" data-act="diaMenu" data-d="semana" aria-label="Semana"><span class="dl">Σ</span><span class="dn">Sem</span></button></div>';
}
function vDiaMenu(p, i){
  const dia = S.menu[i], obj = objetivoDia(p, i), rd = resumenDia(dia), lvl = S.levels && S.levels[i], ad = ajusteDia(p, i);
  let h = '<div class="dtit"><div><h2>'+esc(DIAS[i])+'</h2><p class="sub">'+(lvl ? NIVELES[lvl-1]+' · ' : '')+rd.n+' comida'+(rd.n === 1 ? '' : 's')+'</p></div><button class="btn secondary small" data-act="addExtra" data-d="'+i+'">＋ Plato</button></div>';
  let r = '<div class="card" style="margin-top:14px">' +
    (obj ? '<p class="sub">Objetivo: '+obj.kcal+' kcal · P '+obj.prot+' · C '+obj.carb+' · G '+obj.fat+'</p>' : '') +
    '<p class="sub">Registrado: '+macTxt(rd.cons)+'</p><p class="sub">Previsto del día: '+macTxt(rd.proj)+'</p>' +
    (obj ? barra(rd.proj.kcal/obj.kcal, estado(rd.proj.kcal/obj.kcal, PAL_APP)) : '');
  if (ad && ad.alerta) {
    const sg = sugerencias(ad);
    r += '<div class="notice" style="margin-top:10px"><b>⚠ Día desajustado</b><br>'+ad.msgs.map(esc).join('<br>') +
      (sg.length ? '<p style="margin:8px 0 4px;font-weight:700">Puedes añadir un complemento:</p>' + sg.map(x => '<button class="row" style="margin-bottom:6px" data-act="addCompl" data-d="'+i+'" data-n="'+esc(x.key)+'" data-g="'+x.g+'"><div class="grow"><b>＋ '+x.g+' g de '+esc(NOMBRE_COMPL[x.key] || x.key)+'</b><p class="sub">'+Math.round(x.kcal)+' kcal · P '+Math.round(x.prot)+' · C '+Math.round(x.carb)+' · G '+Math.round(x.fat)+'</p></div></button>').join('') : '') +
      '<button class="btn secondary" style="margin-top:8px" data-act="eqDlg" data-d="'+i+'">⚖ Equilibrar la semana</button></div>';
  }
  r += '</div>';
  h += '<div class="mlist">' + dia.meals.map((m, j) => tarjetaComida(i, j, m)).join('') + '</div>' +
    '<div class="btn-row" style="margin-top:12px"><button class="btn secondary" data-act="postreDia" data-d="'+i+'">🍎 Postres</button><button class="btn secondary" data-act="addExtra" data-d="'+i+'">＋ Plato adicional</button></div>' + r;
  return h;
}
function semanaEstado(p){
  const out = {dias:[], T:CERO0, cons:CERO0, pend:CERO0, proj:CERO0};
  for (let i = 0; i < 7; i++) {
    const obj = objetivoDia(p, i), dia = S.menu && S.menu[i];
    if (!obj || !dia || !dia.meals || !dia.meals.some(m => m.rid)) continue;
    const rd = resumenDia(dia), o = {kcal:obj.kcal, prot:obj.prot, carb:obj.carb, fat:obj.fat};
    out.dias.push({i, obj:o, rd}); out.T = sumaV(out.T, o); out.cons = sumaV(out.cons, rd.cons); out.pend = sumaV(out.pend, rd.pend); out.proj = sumaV(out.proj, rd.proj);
  }
  return out;
}
const difSem = E => ({kcal:E.T.kcal-E.proj.kcal, prot:E.T.prot-E.proj.prot, carb:E.T.carb-E.proj.carb, fat:E.T.fat-E.proj.fat});
const semanaOk = (E, D) => Math.abs(D.kcal) < Math.max(150, 0.015*E.T.kcal) && D.prot < Math.max(25, 0.06*E.T.prot) && Math.abs(D.carb) < Math.max(60, 0.08*E.T.carb) && D.fat > -Math.max(25, 0.1*E.T.fat);
function eqCard(p){
  const E = semanaEstado(p); if (!E.dias.length) return '';
  const D = difSem(E), ok = semanaOk(E, D);
  return '<div class="card'+(ok ? '' : ' accent')+'"><h3>Equilibrio de la semana</h3><p class="sub" style="margin-bottom:10px">'+(ok ? 'La semana va equilibrada: el cierre previsto está dentro del objetivo.' : (Math.abs(D.kcal) < Math.max(150, 0.015*E.T.kcal) ? 'Las calorías de la semana cuadran, pero los macros no: '+txtVariacion(E.T, E.proj)+'.' : D.kcal < 0 ? 'A este ritmo cierras la semana unas <b>'+fmtN(-D.kcal)+' kcal por encima</b> del objetivo.' : 'A este ritmo cierras la semana unas <b>'+fmtN(D.kcal)+' kcal por debajo</b> del objetivo.'))+'</p>' +
    '<button class="btn" data-act="eqDlg">⚖ Equilibrar la semana</button>' +
    '<button class="btn secondary" style="margin-top:10px" data-act="claudeSemana">💬 Preguntar a Claude</button></div>';
}
function vSemanaMenu(p){
  const E = semanaEstado(p), D = difSem(E);
  let h = '<div class="card"><h3>Semana completa</h3>' +
    '<p class="sub">Objetivo de la semana</p><p style="font-weight:800;font-size:19px;margin-bottom:8px">'+macTxt(E.T)+'</p>' +
    '<p class="sub">Registrado hasta ahora</p><p style="font-weight:800;font-size:19px;margin-bottom:8px">'+macTxt(E.cons)+'</p>' +
    '<p class="sub">Todavía pendiente (según el menú)</p><p style="font-weight:800;font-size:19px;margin-bottom:8px">'+macTxt(E.pend)+'</p>' +
    '<p class="sub">Cierre previsto de la semana</p><p style="font-weight:800;font-size:19px">'+macTxt(E.proj)+'</p>' +
    barra(E.proj.kcal/Math.max(E.T.kcal, 1), estado(E.proj.kcal/Math.max(E.T.kcal, 1), PAL_APP)) +
    '<p class="sub">Diferencia con el objetivo: <b>'+txtVariacion(E.T, E.proj)+'</b></p></div>' + eqCard(p);
  h += '<h3 style="margin:14px 0 8px">Día a día</h3><div class="list">' + E.dias.map(x =>
    '<button class="row" data-act="diaMenu" data-d="'+x.i+'"><div class="grow"><b>'+esc(DIAS[x.i])+'</b><p class="sub">Registrado '+fmtN(x.rd.cons.kcal)+' kcal ('+x.rd.nc+'/'+x.rd.n+' comidas)</p><p class="sub">Previsto '+fmtN(x.rd.proj.kcal)+' de '+x.obj.kcal+' kcal · P '+Math.round(x.rd.proj.prot)+'/'+x.obj.prot+' · C '+Math.round(x.rd.proj.carb)+'/'+x.obj.carb+' · G '+Math.round(x.rd.proj.fat)+'/'+x.obj.fat+'</p></div><span class="chev">›</span></button>').join('') + '</div>';
  return h;
}
/* ---------- equilibrar la semana ---------- */
const valsDe = (r, s) => ({kcal:r.kcal*s, prot:r.prot*s, carb:r.carb*s, fat:r.fat*s});
const errRel = (v, t) => 0.15*Math.abs(v.kcal-t.kcal)/Math.max(t.kcal, 50) + 0.35*Math.abs(v.prot-t.prot)/Math.max(t.prot, 8) + 0.3*Math.abs(v.carb-t.carb)/Math.max(t.carb, 12) + 0.2*Math.abs(v.fat-t.fat)/Math.max(t.fat, 6);
/* Días de carga (Media/Alta) y de competición (el día y el anterior): nunca se recorta la comida. */
const diaProtegido = (p, i) => !!(S.levels && S.levels[i] >= 3) || !!diasCompeticion(p.id)[sumaDias(S.weekStart, i)];
function propuestaEquilibrio(p, ids, conPlatos){
  const E = semanaEstado(p), D = difSem(E);
  const tgt = E.dias.filter(x => ids.indexOf(x.i) >= 0 && x.rd.pend.kcal > 0 && !(D.kcal < 0 && diaProtegido(p, x.i)));
  const sumObj = tgt.reduce((a, x) => a + x.obj.kcal, 0), cambios = [];
  tgt.forEach(x => {
    const w = x.obj.kcal/sumObj, share = {kcal:D.kcal*w, prot:D.prot*w, carb:D.carb*w, fat:D.fat*w};
    const dia = S.menu[x.i];
    const aj = dia.meals.map((m, j) => ({m, j})).filter(o => estMeal(o.m) === 'pend' && !o.m.alimento && !o.m.fija);
    const tot = aj.reduce((a, o) => sumaV(a, valsComida(o.m)), CERO0); if (!(tot.kcal > 0)) return;
    aj.forEach(o => {
      const r = recetaPorId(o.m.rid); if (!r || !(r.kcal > 0)) return;
      const pv = valsComida(o.m), wj = pv.kcal/tot.kcal;
      const t = {kcal:Math.max(pv.kcal + share.kcal*wj, 0.3*pv.kcal), prot:Math.max(pv.prot + share.prot*wj, 0), carb:Math.max(pv.carb + share.carb*wj, 0), fat:Math.max(pv.fat + share.fat*wj, 0)};
      let s2 = escalaPara(r, t), cand = {r, s:s2}, err0 = errRel(valsDe(r, s2), t);
      if (conPlatos) {
        const usados = {}; dia.meals.forEach(mm => { if (mm.rid) usados[mm.rid] = true; });
        let best = {err:err0, r, s:s2};
        candidatas(o.m.slot).forEach(c => {
          if (usados[c.id] && c.id !== r.id) return;
          const sc = escalaPara(c, t), e = errRel(valsDe(c, sc), t) + (sc <= 0.5 || sc >= 2.5 ? 0.15 : 0);
          if (e < best.err - 0.08) best = {err:e, r:c, s:sc};
        });
        cand = {r:best.r, s:best.s};
      }
      const cambioPlato = cand.r.id !== r.id;
      if (!cambioPlato && Math.abs(cand.s - o.m.s) < 0.05) return;
      const nv = valsDe(cand.r, cand.s);
      cambios.push({d:x.i, j:o.j, slot:o.m.slot, cambioPlato, de:{name:o.m.name, s:o.m.s, v:pv}, a:{rid:cand.r.id, name:cand.r.name, s:cand.s, v:nv}});
    });
  });
  let cierre = E.proj; cambios.forEach(c => { cierre = sumaV(cierre, {kcal:c.a.v.kcal-c.de.v.kcal, prot:c.a.v.prot-c.de.v.prot, carb:c.a.v.carb-c.de.v.carb, fat:c.a.v.fat-c.de.v.fat}); });
  return {D, cambios, cierre, T:E.T, ids:tgt.map(x => x.i)};
}
function dlgEquilibrio(){
  const p = pacienteActual(); if (!p) return;
  const E = semanaEstado(p); if (!E.dias.length) { abrirDlg('<h2>Equilibrar la semana</h2><div class="empty">Esta semana aún no tiene menú.</div><button class="btn ghost" data-act="cerrar">Cerrar</button>'); return; }
  const D = difSem(E), conPend = E.dias.filter(x => x.rd.pend.kcal > 0);
  let ultimo = -1; E.dias.forEach(x => { if (x.rd.nc > 0) ultimo = Math.max(ultimo, x.i); });
  const recorta = D.kcal < 0;
  if (!S.eqSel) { const fut = conPend.filter(x => x.i > ultimo && !(recorta && diaProtegido(p, x.i))).map(x => x.i); S.eqSel = fut.length ? fut : conPend.filter(x => !(recorta && diaProtegido(p, x.i))).map(x => x.i); }
  if (S.eqPlatos === undefined) S.eqPlatos = true;
  let h = '<h2>⚖ Equilibrar la semana</h2><p class="sub" style="margin-bottom:6px">Objetivo: '+macTxt(E.T)+'</p><p class="sub" style="margin-bottom:6px">Cierre previsto: '+macTxt(E.proj)+'</p>' +
    '<p style="font-weight:800;font-size:18px;margin-bottom:12px">Diferencia: '+txtVariacion(E.T, E.proj)+'</p>';
  if (!conPend.length) { abrirDlg(h + '<div class="notice">Ya no quedan comidas pendientes que se puedan ajustar. Si quieres, añade un complemento en el día o cambia las comidas que ya registraste.</div><button class="btn ghost" style="margin-top:12px" data-act="cerrar">Cerrar</button>'); return; }
  h += '<p class="sub" style="margin-bottom:6px">Elige los días que pueden absorber el ajuste:</p><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
    conPend.map(x => '<label style="display:flex;gap:8px;align-items:center;font-size:18px;min-height:44px"><input type="checkbox" class="eq-d" value="'+x.i+'" style="width:26px;min-height:26px"'+(S.eqSel.indexOf(x.i) >= 0 ? ' checked' : '')+(recorta && diaProtegido(p, x.i) ? ' disabled' : '')+'> '+esc(DIAS[x.i])+(recorta && diaProtegido(p, x.i) ? ' <span class="sub">(día de carga: no se recorta)</span>' : '')+'</label>').join('') + '</div>' +
    '<label style="display:flex;gap:10px;align-items:center;font-size:18px;min-height:44px;margin-bottom:12px"><input type="checkbox" id="eq_platos" style="width:26px;min-height:26px"'+(S.eqPlatos ? ' checked' : '')+'> Puede cambiar también platos (no solo raciones)</label>' +
    '<button class="btn" data-act="eqCalc">Calcular propuesta</button>';
  const pr = S.eqProp;
  if (pr) {
    h += '<h3 style="margin:16px 0 8px">Propuesta</h3>';
    if (!pr.cambios.length) h += '<div class="notice">No hay cambios que mejoren la semana con esos días. Prueba a marcar más días o a permitir cambiar platos.</div>';
    else {
      h += '<div class="list">' + pr.cambios.map(c => '<div class="row" style="cursor:default"><div class="grow"><b>'+esc(DIAS[c.d])+' · '+esc(c.slot)+'</b><p class="sub">'+(c.cambioPlato ? esc(c.de.name)+' ×'+kgTxt(Math.round(c.de.s*100)/100)+' → <b>'+esc(c.a.name)+'</b> ×'+kgTxt(Math.round(c.a.s*100)/100) : esc(c.de.name)+': ×'+kgTxt(Math.round(c.de.s*100)/100)+' → <b>×'+kgTxt(Math.round(c.a.s*100)/100)+'</b>')+'</p><p class="sub">'+Math.round(c.de.v.kcal)+' → '+Math.round(c.a.v.kcal)+' kcal ('+delta(c.a.v.kcal-c.de.v.kcal, 0)+')</p></div></div>').join('') + '</div>';
      const rest = {kcal:pr.T.kcal-pr.cierre.kcal, prot:pr.T.prot-pr.cierre.prot, carb:pr.T.carb-pr.cierre.carb, fat:pr.T.fat-pr.cierre.fat};
      h += '<p class="sub" style="margin:10px 0">Con estos cambios la semana cerraría en <b>'+macTxt(pr.cierre)+'</b>'+(semanaOk({T:pr.T}, rest) ? ': dentro del objetivo.' : '. Aún quedaría una diferencia de '+txtVariacion(pr.T, pr.cierre)+': marca más días o añade un complemento.')+'</p>' +
        '<button class="btn" data-act="eqAplicar">✔ Aplicar todos los cambios</button>';
    }
  }
  h += '<button class="btn secondary" style="margin-top:10px" data-act="claudeSemana">💬 Preguntar a Claude</button><button class="btn ghost" style="margin-top:10px" data-act="cerrar">Cerrar</button>';
  abrirDlg(h);
}
function eqCalc(){
  const p = pacienteActual(); if (!p) return;
  S.eqSel = $$('.eq-d').filter(c => c.checked).map(c => parseInt(c.value, 10)); S.eqPlatos = !!($('#eq_platos') && $('#eq_platos').checked);
  S.eqProp = propuestaEquilibrio(p, S.eqSel, S.eqPlatos); dlgEquilibrio();
}
async function eqAplicar(){
  const p = pacienteActual(), pr = S.eqProp; if (!p || !pr) return;
  pr.cambios.forEach(c => {
    const r = recetaPorId(c.a.rid), m = S.menu[c.d].meals[c.j]; if (!r || !m) return;
    Object.assign(m, comidaDe(r, m.slot, c.a.s), {fija:false, ajustada:true}); if (esCopia(p)) m.manual = true;
  });
  S.eqProp = null; S.eqSel = null; cerrarDlg(); setMsg('Semana equilibrada: se han ajustado '+pr.cambios.length+' comidas pendientes (marcadas con ⚖).', true); render(); await guardarMenu();
}
function textoClaude(p){
  const E = semanaEstado(p), kg = kgDe();
  let t = 'Soy nutricionista deportivo y necesito equilibrar la semana de comidas de '+p.name+(kg ? ' ('+kgTxt(kg)+' kg)' : '')+(p.goal ? ', objetivo: '+p.goal : '')+'. Los días de entreno Medio o Alto no se recorta energía (nunca quitar fuerza a un halterófilo).\n\n';
  t += 'OBJETIVO SEMANAL: '+macTxt(E.T)+'\nREGISTRADO: '+macTxt(E.cons)+'\nPENDIENTE SEGÚN MENÚ: '+macTxt(E.pend)+'\nDIFERENCIA: '+txtVariacion(E.T, E.proj)+'\n\nDÍAS:\n';
  E.dias.forEach(x => {
    const dia = S.menu[x.i];
    t += '- '+DIAS[x.i]+' (obj. '+x.obj.kcal+' kcal, P'+x.obj.prot+' C'+x.obj.carb+' G'+x.obj.fat+'): '+dia.meals.filter(m => m.rid).map(m => { const e = estMeal(m), v = e === 'cambio' ? valsComida(m.real) : valsComida(m); return m.slot+': '+(e === 'cambio' ? m.real.name : m.name)+' '+Math.round(v.kcal)+' kcal P'+Math.round(v.prot)+' C'+Math.round(v.carb)+' G'+Math.round(v.fat)+' ['+(e === 'hecho' ? 'hecho' : e === 'no' ? 'NO hecho' : e === 'cambio' ? 'cambiado' : 'pendiente')+']'; }).join('; ')+'\n';
  });
  t += '\nPropón, de forma concreta, cómo equilibrar los días que quedan: qué comidas pendientes ajustar (ración o plato), cuánto, y qué complemento añadir si hace falta. Sé breve y práctico.';
  return t;
}
async function claudeSemana(){
  const p = pacienteActual(); if (!p) return;
  const t = textoClaude(p);
  try { if (navigator.clipboard) await navigator.clipboard.writeText(t); } catch(e){}
  window.open('https://claude.ai/new?q='+encodeURIComponent(t), '_blank');
  setMsg('Texto copiado. Se abre Claude con la pregunta; si no aparece, pégalo allí.', true); render();
}
function dlgComida(){
  const sl = S.slot, p = pacienteActual(); if (!sl || !p) return;
  const meals = S.menu[sl.d].meals, m = meals[sl.m]; if (!m) return;
  if (!m.rid) { dlgSlot(); return; }
  const v = valsComida(m), e = estMeal(m), n = meals.length;
  const ing = (m.ing && m.ing.length) ? m.ing : null;
  let h = '<div class="pgr"><div class="pgr-h"><div class="grow"><b class="pgr-t">'+esc(m.slot)+'</b><p class="sub">'+esc(DIAS[sl.d])+' · '+(sl.m+1)+' / '+n+'</p></div>' +
    '<button class="pgr-x" data-act="cerrar" aria-label="Cerrar">×</button></div><div class="pgr-b">' +
    (e === 'cambio' ? (() => { const rv = valsComida(m.real); return '<p class="pgr-plato">'+esc(m.real.name)+'</p>' +
      '<div class="pgr-kcal">'+Math.round(rv.kcal)+'<small> kcal</small></div>' +
      '<p class="pgr-mac">P '+r1(rv.prot)+' · C '+r1(rv.carb)+' · G '+r1(rv.fat)+'</p>' +
      (m.real.rid !== 'libre' ? '<div class="btn-row" style="margin:8px 0"><button class="btn secondary" data-act="escalaReal" data-n="-0.1">− Ración</button><b style="align-self:center;text-align:center;min-width:64px;font-size:18px">×'+kgTxt(Math.round(m.real.s*100)/100)+'</b><button class="btn secondary" data-act="escalaReal" data-n="0.1">＋ Ración</button></div>' : '') +
      '<div class="pgr-prev"><p class="sub">Previsto (no comido)</p><b>'+esc(m.name)+'</b><p class="sub">'+Math.round(v.kcal)+' kcal · P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+'</p><p class="sub">Variación: '+txtVariacion(v, rv)+'</p></div>'; })()
    : '<p class="pgr-plato'+(e === 'no' ? ' mtach' : '')+'">'+esc(m.name)+'</p>' +
      '<div class="pgr-kcal">'+Math.round(v.kcal)+'<small> kcal</small></div>' +
      '<p class="pgr-mac">P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+'</p>' +
      '<p class="sub" style="text-align:center">Ración ×'+kgTxt(Math.round(m.s*100)/100)+(m.bw ? ' · '+Math.round(v.g)+' g' : '')+'</p>') +
    '<p style="text-align:center;margin:10px 0">'+chip(e)+'</p>' +
    (e === 'no' ? '<div class="card accent" style="margin-bottom:10px"><p class="sub">Variación sobre el plan: '+txtVariacion(v, CERO0)+'</p></div>' : '') +
    '<button class="btn" style="margin-bottom:10px" data-act="marcaHecho">✅ Lo he hecho</button>' +
    '<button class="btn secondary" style="margin-bottom:10px" data-act="realDlg">🔁 He comido otra cosa</button>' +
    '<button class="btn secondary" style="margin-bottom:10px" data-act="marcaNo">✖ No lo he hecho</button>' +
    '<button class="btn secondary" style="margin-bottom:10px" data-act="slotMenu" data-d="'+sl.d+'" data-m="'+sl.m+'">🔄 Cambiar el plato del menú</button>' +
    (e !== 'pend' ? '<button class="btn ghost" style="margin-bottom:10px" data-act="marcaPend">↩ Volver a pendiente</button>' : '') +
    '</div><div class="pgr-f"><button class="pgr-n" data-act="comidaNav" data-n="-1"'+(sl.m === 0 ? ' disabled' : '')+' aria-label="Anterior">‹</button><div class="pgr-dots">' +
    meals.map((x, k) => '<i class="'+(k === sl.m ? 'on' : '')+'"></i>').join('') +
    '</div><button class="pgr-n" data-act="comidaNav" data-n="1"'+(sl.m >= n-1 ? ' disabled' : '')+' aria-label="Siguiente">›</button></div></div>';
  abrirDlg(h); $('#dlgBody').classList.add('pager');
}
async function marcarComida(fn, texto){
  const sl = S.slot; if (!sl) return;
  const m = S.menu[sl.d].meals[sl.m]; fn(m);
  const ad = ajusteDia(pacienteActual(), sl.d);
  setMsg((texto || '') + (ad && ad.alerta ? ' ⚠ '+ad.msgs.join(' · ')+'.' : ''), !(ad && ad.alerta)); render(); dlgComida(); await guardarMenu();
}
function vMenu(p){
  if (!S.levels || !S.levels.some(x => x)) return '';
  if (!datosOk(p)) return '';
  const hay = S.menu && S.menu.some(d => d.meals && d.meals.length);
  let panel = '';
  if (hay) {
    if (S.mdia === null || S.mdia === undefined) S.mdia = diaDefecto();
    panel = pildoras(p) + (S.mdia === 'semana' ? vSemanaMenu(p) : (S.menu[S.mdia] && S.menu[S.mdia].meals && S.menu[S.mdia].meals.length ? vDiaMenu(p, S.mdia) : '<div class="card"><h3>'+esc(DIAS[S.mdia])+'</h3><p class="sub">Sin menú este día.</p></div>'));
  }
  let html = '<div class="card"><h3>Menú de la semana</h3>' +
    '<p class="sub" style="margin-bottom:10px">'+(hay ? 'Toca un día para ver sus comidas.' : 'La app propone una receta para cada comida, con la ración ajustada a las kcal y macros del día.')+'</p>' +
    '<div class="btn-row"><button class="btn secondary" data-act="repartoDlg">Reparto</button><button class="btn secondary" data-act="copiarSemana">📋 Copiar de otra semana</button></div>' +
    '<button class="btn secondary" style="margin-top:10px" data-act="fijasDlg">📌 Comidas fijas'+(() => { const f = fijasDe(p), n = Object.keys(f).filter(k => f[k] && f[k].rid).length; return n ? ' ('+n+(fijasPropias(p) ? '' : ', por defecto')+')' : ''; })()+'</button></div>';
  const fte = fuenteDe(p), enl = S.patients.some(x => x.id !== p.id);
  const btnGen = '<div class="card">' + (esCopia(p) && fte
    ? '<button class="btn" data-act="proponerMenu">'+(hay ? '🔄 Actualizar desde el menú de '+esc(fte.name) : '🔗 Copiar el menú de '+esc(fte.name)+' y adaptarlo')+'</button><p class="sub" style="margin-top:8px">Copia los platos de '+esc(fte.name)+' con las raciones de '+esc(p.name)+'. Lo que hayas cambiado a mano (✎) se conserva.</p>'
    : '<button class="btn" data-act="proponerMenu">'+(hay ? '🔄 Generar menú de nuevo y ver la tabla' : '✨ Generar menú y ver la tabla')+'</button><p class="sub" style="margin-top:8px">Propone los platos de toda la semana y te lleva a Informe, donde ves el menú en tabla y puedes cambiar cualquier plato.</p>') +
    (enl ? '<button class="btn ghost" style="margin-top:10px" data-act="modoMenuDlg">🔗 Enlace del menú: '+(esCopia(p) && fte ? 'copia de '+esc(fte.name) : 'propio')+'</button>' : '') +
    (hay ? '<button class="btn secondary" style="margin-top:10px" data-act="ptab" data-v="informe">Ver la tabla</button>' : '') + '</div>';
  if (!hay) return html + vMacros(p) + btnGen;
  return panel + '<h3 style="margin:18px 0 8px">Opciones del menú</h3>' + html + btnGen + vObjetivo(p);
}
function dlgSlot(){
  const p = pacienteActual(), sl = S.slot; if (!p || !sl) return;
  const dia = S.menu[sl.d], m = dia.meals[sl.m], obj = objetivoDia(p, sl.d);
  const pct = (repartoDe(p).find(x => x[0] === m.slot) || [0,0])[1];
  const t = obj && !m.extra ? {kcal:obj.kcal*pct/100, prot:obj.prot*pct/100, carb:obj.carb*pct/100, fat:obj.fat*pct/100} : null;
  const usos = {}; S.menu.forEach(d => (d.meals||[]).forEach(x => { if (x.rid) usos[x.rid] = (usos[x.rid]||0) + 1; }));
  const delDia = {}; dia.meals.forEach(x => { if (x.rid && x !== m) delDia[x.rid] = true; });
  const q = norm(S.slotQ || '');
  const base = q ? S.recipes.filter(r => (r.kcal||0) > 0 && norm([r.name, r.useIn, (r.ingredients||[]).join(' ')].join(' ')).indexOf(q) >= 0) : candidatas(m.slot);
  const vAct = m.rid ? valsComida(m) : null, refA = vAct ? refDe(m) : null, simDe = r => vAct ? simPlato(r, vAct, refA) : null;
  const libre = !!(vAct && (q || S.slotModo === 'libre'));
  const cands = (vAct ? (libre ? (q ? base : S.recipes.filter(r => (r.kcal||0) > 0).sort((a, b) => a.name.localeCompare(b.name, 'es')))
      : base.filter(r => r.id !== m.rid).map(r => ({r, sim:simDe(r)})).sort((a, b) => b.sim - a.sim).map(x => x.r))
    : (t ? base.map(r => ({r, sc:puntua(r, t, usos, null, delDia)})).sort((a,b) => a.sc - b.sc).map(x => x.r) : base)).slice(0, q ? 30 : (libre || S.slotAll ? 999 : 8));
  let cabecera = '<h2>'+DIAS[sl.d]+' · '+esc(m.slot)+'</h2>';
  if (t) cabecera += '<p class="sub" style="margin-bottom:12px">Objetivo de esta comida: '+Math.round(t.kcal)+' kcal · P '+Math.round(t.prot)+' · C '+Math.round(t.carb)+' · G '+Math.round(t.fat)+'</p>';
  let actual = '';
  if (m.rid) {
    const v = valsComida(m);
    actual = '<div class="card accent" style="margin-bottom:12px"><b>'+esc(m.name)+'</b><p class="sub" style="margin:4px 0 10px">'+Math.round(v.kcal)+' kcal · P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+(m.bw ? ' · '+Math.round(v.g)+' g' : '')+'</p>' +
      '<div class="btn-row"><button class="btn secondary" data-act="escalaSlot" data-n="-0.1" aria-label="Menos ración">− Ración</button><b style="align-self:center;text-align:center;min-width:64px">×'+kgTxt(Math.round(m.s*100)/100)+'</b><button class="btn secondary" data-act="escalaSlot" data-n="0.1" aria-label="Más ración">＋ Ración</button></div>' +
      '<button class="btn danger" style="margin-top:10px" data-act="quitarSlot">'+(m.extra ? 'Eliminar este plato adicional' : 'Quitar esta comida')+'</button></div>';
  } else if (m.extra) actual = '<button class="btn danger" style="margin-bottom:12px" data-act="quitarSlot">Eliminar este plato adicional</button>';
  const buscador = (vAct && !libre) ? '' : '<div class="field"><label class="f" for="sq">Buscar receta</label><input id="sq" type="search" value="'+esc(S.slotQ||'')+'" placeholder="Nombre o ingrediente…" autocomplete="off"></div>';
  const sinKcal = S.recipes.filter(r => !(r.kcal > 0)).length;
  const lista = (vAct ? modoBotones(libre, 'slotModo') : '') + buscador + (vAct && !libre ? '' : '<button class="btn secondary" style="margin-bottom:10px" data-act="recetaDesdeSlot">＋ Añadir receta a mano</button>') +
    (sinKcal ? '<p class="sub" style="margin-bottom:10px">⚠ '+sinKcal+' receta'+(sinKcal>1?'s':'')+' sin calorías no sale'+(sinKcal>1?'n':'')+' aquí. Ábrela'+(sinKcal>1?'s':'')+' en el Recetario y pulsa «Calcular macros».</p>' : '') + (cands.length ? '<h3 style="margin:6px 0">'+(q ? 'Resultados' : vAct ? (libre ? 'Todas las recetas' : 'Platos parecidos a «'+esc(m.name)+'»') : 'Recetas que encajan')+'</h3><div class="list">' + cands.filter(r => r.id !== m.rid).map(r => {
    const s = t ? escalaPara(r, t) : 1;
    return '<button class="row" data-act="elegirReceta" data-id="'+esc(r.id)+'"><div class="grow"><b>'+esc(r.name)+'</b>'+(vAct && !libre ? ' <span style="font-weight:800;color:var(--t-accent)">'+simDe(r)+' % similar</span>' : '')+'<p class="sub">ración ×'+kgTxt(s)+' · '+Math.round(r.kcal*s)+' kcal · P '+r1(r.prot*s)+' · C '+r1(r.carb*s)+' · G '+r1(r.fat*s)+'</p></div><span class="chev">›</span></button>';
  }).join('') + '</div>' : '<div class="empty">'+(q ? 'Ninguna receta coincide.' : /^Postre/.test(m.slot) ? 'No hay recetas de postre. Crea una en el Recetario y marca «Postre» en «Utilizar en».' : 'No hay recetas para esta comida. Añade recetas en el Recetario.')+'</div>');
  const hayMas = !q && !libre && !S.slotAll && base.filter(r => r.id !== m.rid).length > 8;
  const verTodas = hayMas ? '<button class="btn secondary" style="margin-top:10px" data-act="slotTodas">Ver todas las recetas ('+base.filter(r => r.id !== m.rid).length+')</button>' : '';
  const botonReal = m.rid ? '<button class="btn secondary" style="margin-bottom:12px" data-act="realDlg">🔁 Cambio sobre la marcha'+(m.real ? ' (registrado)' : '')+'</button>' : '';
  abrirDlg(cabecera + actual + botonReal + lista + verTodas + '<button class="btn ghost" style="margin-top:12px" data-act="cerrar">Cerrar</button>');
}
async function addExtra(d){
  const dia = S.menu[d]; if (!dia) return;
  dia.meals = dia.meals || [];
  const usados = dia.meals.map(m => m.slot);
  let n = 1, nombre = 'Adicional'; while (usados.indexOf(nombre) >= 0) { n++; nombre = 'Adicional '+n; }
  dia.meals.push({slot:nombre, rid:null, extra:true, manual:true});
  S.slotQ = ''; S.slot = {d, m:dia.meals.length - 1};
  render(); dlgSlot();
  await guardarMenu();
}
async function addPostres(d){
  const dia = S.menu[d]; if (!dia) return;
  dia.meals = dia.meals || [];
  let primero = null;
  [['Almuerzo','Postre almuerzo'], ['Cena','Postre cena']].forEach(([base, sl]) => {
    if (dia.meals.some(m => m.slot === sl)) return;
    const k = dia.meals.findIndex(m => m.slot === base);
    if (k < 0) return;
    dia.meals.splice(k+1, 0, {slot:sl, rid:null, manual:true});
    if (!primero) primero = sl;
  });
  if (!primero) { setMsg('Este día ya tiene postre en el almuerzo y en la cena.', true); render(); return; }
  const j = dia.meals.findIndex(m => m.slot === primero);
  S.slotQ = ''; S.slot = {d, m:j};
  render(); dlgSlot();
  await guardarMenu();
}
async function quitarExtra(){
  const sl = S.slot; if (!sl) return;
  const dia = S.menu[sl.d], m = dia.meals[sl.m], antes = totalDia(dia);
  dia.meals.splice(sl.m, 1);
  const des = totalDia(dia);
  cerrarDlg(); S.slotQ = '';
  setMsg('Plato adicional eliminado. '+DIAS[sl.d]+' queda en '+fmtN(des.kcal)+' kcal.', true);
  render(); await guardarMenu();
}
async function cambiarSlot(fn, cerrar, aviso, reabrir){
  const sl = S.slot; if (!sl) return;
  const antes = totalDia(S.menu[sl.d]);
  fn(S.menu[sl.d].meals[sl.m]);
  if (esCopia(pacienteActual()) && reabrir !== dlgReal && reabrir !== dlgComida) S.menu[sl.d].meals[sl.m].manual = true;
  { const des = totalDia(S.menu[sl.d]); if (Math.abs(des.kcal - antes.kcal) + Math.abs(des.prot - antes.prot) + Math.abs(des.carb - antes.carb) + Math.abs(des.fat - antes.fat) > 0.5) {
    const pp = pacienteActual(), ob = pp && objetivoDia(pp, sl.d);
    aviso = (aviso || DIAS[sl.d]+' · '+S.menu[sl.d].meals[sl.m].slot+':') + ' Variación del día: '+txtVariacion(antes, des)+'. El día queda en '+fmtN(des.kcal)+(ob ? ' de '+ob.kcal : '')+' kcal · P '+Math.round(des.prot)+(ob ? '/'+ob.prot : '')+' · C '+Math.round(des.carb)+(ob ? '/'+ob.carb : '')+' · G '+Math.round(des.fat)+(ob ? '/'+ob.fat : '')+'.'; } }
  if (cerrar) { cerrarDlg(); S.slotQ = ''; S.realQ = ''; } else (reabrir || dlgSlot)();
  if (aviso) setMsg(aviso, true);
  render();
  const ok = await guardarMenu();
  if (ok && aviso) { render(); }
}
const DIA_CORTO = ['L','M','X','J','V','S','D'];
function dlgFijas(){
  const p = pacienteActual(); if (!p) return;
  const recs = S.recipes.slice().sort(porNombre);
  const bloques = repartoDe(p).map(([slot], i) => {
    const f = fijasDe(p)[slot] || {};
    const dias = Array.isArray(f.days) ? f.days : [0,1,2,3,4];
    return '<div class="card" style="margin-bottom:12px"><h3>'+esc(slot)+'</h3>' +
      selBuscable('fx'+i, 'Receta fija', '— ninguna (la app elige) —', recs.map(r => [r.id, r.name]), f.rid) +
      '<p class="sub" style="margin-bottom:6px">Días en que se repite</p><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
      DIA_CORTO.map((d, k) => '<label style="display:flex;flex-direction:column;align-items:center;gap:2px;font-weight:800;font-size:17px"><input type="checkbox" id="fd'+i+'_'+k+'" style="width:28px;min-height:28px"'+(dias.indexOf(k) >= 0 ? ' checked' : '')+'>'+d+'</label>').join('') + '</div>' +
      '<div class="field"><label class="f" for="fs'+i+'">Ración (1 = la receta entera)</label><input id="fs'+i+'" inputmode="decimal" value="'+esc(kgTxt(f.s || 1))+'"></div></div>';
  }).join('');
  abrirDlg('<h2>Comidas fijas</h2><p class="sub" style="margin-bottom:12px">Comidas que se repiten (por ejemplo, el desayuno de lunes a viernes). El resto del día se reparte contando con ellas. Después puedes cambiar una en un día concreto tocándola.</p>' +
    bloques + '<div class="msg err" id="fx_msg"></div>' +
    '<button class="btn" data-act="guardarFijas" data-todos="1">Guardar para todos mis usuarios</button>' +
    '<p class="sub" style="margin:4px 0 10px">Se usará con los usuarios que no tengan ajuste propio.</p>' +
    '<button class="btn secondary" data-act="guardarFijas" data-todos="0">Guardar solo para este usuario</button>' +
    '<button class="btn ghost" style="margin-top:10px" data-act="cerrar">Cancelar</button>');
}
async function guardarFijas(todos){
  const p = pacienteActual(); if (!p) return;
  const fijas = {};
  repartoDe(p).forEach(([slot], i) => {
    const rid = $('#fx'+i).value; if (!rid) return;
    const days = DIA_CORTO.map((d, k) => $('#fd'+i+'_'+k).checked ? k : -1).filter(k => k >= 0);
    const sc = parseFloat(String($('#fs'+i).value).replace(',', '.'));
    fijas[slot] = {rid, days, s:isFinite(sc) && sc > 0 ? Math.round(sc*20)/20 : 1};
  });
  try {
    if (todos) {
      await db.collection('users').doc(wsUid()).update({nuPrefs:Object.assign({}, S.prefs, {fijas})});
      S.prefs = Object.assign({}, S.prefs, {fijas});
      await refPac(p.id).update({fijas:firebase.firestore.FieldValue.delete()}); delete p.fijas;
    } else { await refPac(p.id).update({fijas}); p.fijas = fijas; }
    cerrarDlg(); setMsg(todos ? 'Comidas fijas guardadas para todos tus usuarios. Pulsa «Proponer menú» para aplicarlas.' : 'Comidas fijas guardadas para este usuario. Pulsa «Proponer menú» para aplicarlas.', true);
  } catch(e){ $('#fx_msg').textContent = 'No se pudo guardar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  render();
}
function dlgReparto(){
  const p = pacienteActual(); if (!p) return;
  abrirDlg('<h2>Reparto de comidas</h2><p class="sub" style="margin-bottom:12px">Porcentaje de las kcal y macros del día para cada comida. Debe sumar 100.</p>' +
    repartoDe(p).map((x, i) => '<div class="field"><label class="f" for="rp'+i+'">'+esc(x[0])+' (%)</label><input id="rp'+i+'" inputmode="numeric" value="'+x[1]+'"></div>').join('') +
    '<div class="msg err" id="rp_msg"></div><div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn" data-act="guardarReparto">Guardar</button></div>');
}
async function guardarReparto(){
  const p = pacienteActual(); if (!p) return;
  const v = repartoDe(p).map((x, i) => parseInt($('#rp'+i).value, 10) || 0);
  if (v.some(x => x < 0 || x > 100) || v.reduce((a,b) => a+b, 0) !== 100) { $('#rp_msg').textContent = 'Los porcentajes deben sumar 100 (ahora suman '+v.reduce((a,b) => a+b, 0)+').'; return; }
  try { await refPac(p.id).update({reparto:v}); p.reparto = v; cerrarDlg(); setMsg('Reparto guardado. Vuelve a proponer el menú para aplicarlo.', true); }
  catch(e){ $('#rp_msg').textContent = 'No se pudo guardar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  render();
}
function cabSemana(){
  const fin = sumaDias(S.weekStart, 6);
  return '<div class="weekhead"><button class="btn secondary" data-act="semana" data-n="-7" aria-label="Semana anterior">‹</button>' +
    '<div class="t">'+fechaCorta(S.weekStart).slice(0,5)+' – '+fechaCorta(fin).slice(0,5)+'</div>' +
    '<button class="btn secondary" data-act="semana" data-n="7" aria-label="Semana siguiente">›</button></div>';
}

/* ---------- datos y gráficos de la semana ---------- */
const PAL_APP = {txt:'#e8eef4', muted:'#b2bfcc', line:'#263242', track:'#263242', obj:'#5fe0d5', menu:'#34d1c4', real:'#ff8a65', gasto:'#b2bfcc', ok:'#3fb26f', warn:'#f2b84b', bad:'#ef5f4a', fondo:'#3a4a5e', P:'#4f8cff', C:'#f2b84b', G:'#b07cf2'};
const PAL_PDF = {txt:'#1b2430', muted:'#5b6b7e', line:'#d5dce4', track:'#e6ebf0', obj:'#9a7420', menu:'#c99a2e', real:'#e0623f', gasto:'#5b6b7e', ok:'#1f9d55', warn:'#d99a1c', bad:'#d6452f', fondo:'#cfd8e1', P:'#2f6fe0', C:'#d99a1c', G:'#8a52d6'};
const LVL_COL = ['#6fa8dc','#3fb26f','#f2b84b','#e0614f'];
const fmtN = n => Math.round(n).toLocaleString('es-ES');
function datosSemana(p){
  const out = [];
  for (let i = 0; i < 7; i++) {
    const nivel = S.levels && S.levels[i];
    const base = {i, lbl:DIAS[i], fecha:sumaDias(S.weekStart, i), nivel:nivel || 0, gasto:0, obj:null, menu:null, real:null, nota:''};
    if (nivel && datosOk(p)) {
      const r = calcDia(p, nivel, base.fecha, kgDe(), diasCompeticion(p.id));
      base.gasto = r.gasto; base.nota = r.nota; base.obj = {kcal:r.kcal, prot:r.prot, carb:r.carb, fat:r.grasa};
    }
    const dia = S.menu && S.menu[i];
    if (dia && dia.meals && dia.meals.some(m => m.rid)) { base.menu = totalDia(dia); if (hayReal(dia)) base.real = totalReal(dia); }
    out.push(base);
  }
  return out;
}
function resumenSemana(ds){
  const conObj = ds.filter(d => d.obj), conMenu = ds.filter(d => d.obj && d.menu);
  const sum = (arr, f) => arr.reduce((a, d) => a + f(d), 0);
  const final = d => d.real || d.menu;
  return {
    nObj:conObj.length, nMenu:conMenu.length,
    objMedio: conObj.length ? sum(conObj, d => d.obj.kcal)/conObj.length : 0,
    menuMedio: conMenu.length ? sum(conMenu, d => final(d).kcal)/conMenu.length : 0,
    cobertura: conMenu.length ? sum(conMenu, d => final(d).kcal) / sum(conMenu, d => d.obj.kcal) : 0,
    balance: conMenu.length ? sum(conMenu, d => final(d).kcal) - sum(conMenu, d => d.gasto) : 0,
    gastoMedio: conMenu.length ? sum(conMenu, d => d.gasto)/conMenu.length : 0,
    previsto: (() => { const pp = pacienteActual(), pl = pp && planSemana(pp); return pl && conMenu.length ? sum(conMenu, d => pl.adj[d.i] || 0) : null; })()
  };
}
const estado = (pct, pal) => pct >= 0.95 && pct <= 1.05 ? pal.ok : (pct >= 0.9 && pct <= 1.1 ? pal.warn : pal.bad);
const ABR_NIV = ['Desc.','Baja','Media','Alta'];
function chartKcal(ds, pal){
  const W = 360, H = 330, ml = 40, mr = 4, mt = 22, mb = 74;
  const real = ds.some(d => d.real);
  const vals = []; ds.forEach(d => { vals.push(d.gasto, d.obj ? d.obj.kcal : 0, d.menu ? d.menu.kcal : 0, d.real ? d.real.kcal : 0); });
  const max = Math.max(500, Math.ceil(Math.max.apply(null, vals)/500)*500 + 250);
  const gw = (W-ml-mr)/7, y = v => mt + (H-mt-mb) * (1 - v/max);
  let g = '<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" aria-label="Energía por día: objetivo, menú y gasto estimado" style="display:block;font-family:Archivo,system-ui,sans-serif">';
  for (let v = 0; v <= max; v += 500) g += '<line x1="'+ml+'" x2="'+(W-mr)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="'+pal.line+'"/><text x="'+(ml-5)+'" y="'+(y(v)+4)+'" font-size="11" text-anchor="end" fill="'+pal.muted+'">'+v+'</text>';
  const pts = [];
  ds.forEach((d, k) => {
    const cx = ml + k*gw + gw/2, bw = gw*0.62;
    if (d.nivel) g += '<rect x="'+(ml+k*gw+1)+'" y="'+mt+'" width="'+(gw-2)+'" height="'+(H-mt-mb)+'" fill="'+LVL_COL[d.nivel-1]+'" opacity="0.10" rx="4"/>';
    if (d.obj) g += '<rect x="'+(cx-bw/2)+'" y="'+y(d.obj.kcal)+'" width="'+bw+'" height="'+(y(0)-y(d.obj.kcal))+'" fill="'+pal.fondo+'" opacity="0.55" rx="3"/>';
    if (d.menu) {
      const fin = d.real || d.menu, pct = d.obj ? fin.kcal/d.obj.kcal : 1, w2 = bw*0.62;
      g += '<rect x="'+(cx-w2/2)+'" y="'+y(d.menu.kcal)+'" width="'+w2+'" height="'+(y(0)-y(d.menu.kcal))+'" fill="'+estado(pct, pal)+'" rx="3"/>';
      g += '<text x="'+cx+'" y="'+(Math.min(y(d.menu.kcal), d.obj ? y(d.obj.kcal) : 999)-5)+'" font-size="11" font-weight="800" text-anchor="middle" fill="'+pal.txt+'">'+d.menu.kcal.toFixed(0)+'</text>';
      if (d.real) g += '<path d="M'+(cx-9)+' '+y(d.real.kcal)+' l9 -8 l9 8 l-9 8 z" fill="'+pal.real+'" stroke="'+pal.txt+'" stroke-width="1"/>';
    }
    if (d.gasto) pts.push([cx, y(d.gasto)]);
    g += '<text x="'+cx+'" y="'+(H-mb+16)+'" font-size="14" font-weight="800" text-anchor="middle" fill="'+pal.txt+'">'+d.lbl.slice(0,3)+'</text>';
    if (d.nivel) g += '<rect x="'+(cx-17)+'" y="'+(H-mb+22)+'" width="34" height="15" rx="7.5" fill="'+LVL_COL[d.nivel-1]+'"/><text x="'+cx+'" y="'+(H-mb+33)+'" font-size="10" font-weight="800" text-anchor="middle" fill="#10161d">'+ABR_NIV[d.nivel-1]+'</text>';
    if (d.menu && d.obj) { const pct = Math.round((d.real || d.menu).kcal/d.obj.kcal*100); g += '<text x="'+cx+'" y="'+(H-mb+55)+'" font-size="13" font-weight="800" text-anchor="middle" fill="'+estado(pct/100, pal)+'">'+pct+'%</text>'; }
  });
  if (pts.length > 1) g += '<polyline fill="none" stroke="'+pal.gasto+'" stroke-width="2.5" stroke-dasharray="5 4" points="'+pts.map(p => p.join(',')).join(' ')+'"/>';
  pts.forEach(p => g += '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="4" fill="'+pal.gasto+'" stroke="'+pal.txt+'" stroke-width="1"/>');
  return g + '<text x="'+ml+'" y="'+(H-2)+'" font-size="10" fill="'+pal.muted+'">% = lo que cubre el menú del objetivo del día</text></svg>';
}
function leyendaKcal(pal, real){
  return leyenda([['Objetivo del día', pal.fondo], ['Menú: ✓ 95–105 %', pal.ok], ['±10 %', pal.warn], ['Fuera', pal.bad], ['Gasto estimado', pal.gasto, 'linea']].concat(real ? [['◆ Lo realmente comido', pal.real]] : []), pal);
}
function leyenda(items, pal){
  return '<div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin:6px 0 2px;font-size:14px;color:'+pal.muted+'">' + items.map(([t, c, tipo]) =>
    '<span style="display:inline-flex;align-items:center;gap:6px"><i style="display:inline-block;width:16px;height:'+(tipo==='linea'?'0':'10px')+';'+(tipo==='hueco' ? 'border:2px solid '+c : tipo==='linea' ? 'border-top:3px dashed '+c : 'background:'+c)+';border-radius:3px"></i>'+t+'</span>').join('') + '</div>';
}
function barrasMacros(ds, pal, kg){
  const c = ds.filter(d => d.obj && d.menu); if (!c.length) return '<p class="sub">Prepara el menú para ver los macros.</p>';
  const med = (f, k) => c.reduce((a, d) => a + f(d)[k], 0) / c.length;
  const filas = [['Proteína','prot','P'],['Carbohidratos','carb','C'],['Grasa','fat','G']].map(([n, k, col]) => {
    const o = med(d => d.obj, k), m = med(d => d.menu, k), r = c.some(d => d.real) ? med(d => d.real || d.menu, k) : null;
    const pct = o ? m/o*100 : 0, ok = pct >= 90 && pct <= 110;
    const bar = (v, color) => '<div style="height:12px;border-radius:6px;background:'+pal.track+';position:relative;margin:3px 0"><div style="height:12px;border-radius:6px;background:'+color+';width:'+Math.min(v/(o*1.3||1)*100, 100)+'%"></div><div style="position:absolute;left:'+(100/1.3)+'%;top:-3px;bottom:-3px;border-left:2px solid '+pal.txt+'"></div></div>';
    return '<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:16px;color:'+pal.txt+'"><b style="color:'+pal[col]+'">'+n+'</b><span>'+Math.round(m)+' de '+Math.round(o)+' g/día · <b>'+Math.round(pct)+'%</b>'+(ok ? ' ✓' : '')+'</span></div>' +
      bar(m, pal[col]) + (r !== null ? '<div style="font-size:14px;color:'+pal.muted+'">Real: '+Math.round(r)+' g/día ('+Math.round(o ? r/o*100 : 0)+'%)</div>' : '') +
      '<div style="font-size:14px;color:'+pal.muted+'">'+(kg ? kgTxt(Math.round(o/kg*10)/10)+' g/kg necesarios · '+kgTxt(Math.round(m/kg*10)/10)+' g/kg en el menú' : '')+'</div></div>';
  }).join('');
  return filas + '<p style="font-size:14px;color:'+pal.muted+';margin:0">La raya vertical marca el 100% del objetivo. Medias de los días con menú.</p>';
}
function chartMacrosDia(ds, pal){
  const W = 360, ml = 80, mr = 4, mt = 4, rh = 54, gw = (W-ml-mr)/7, H = mt + rh*3 + 34;
  let g = '<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" aria-label="Cobertura de proteína, carbohidratos y grasa por día" style="display:block;font-family:Archivo,system-ui,sans-serif">';
  [['Proteína','prot','P'],['Hidratos','carb','C'],['Grasa','fat','G']].forEach(([n, k, col], r) => {
    const y0 = mt + r*rh;
    g += '<text x="'+(ml-8)+'" y="'+(y0+rh/2+4)+'" font-size="13" font-weight="800" text-anchor="end" fill="'+pal[col]+'">'+n+'</text>';
    ds.forEach((d, i) => {
      const x = ml + i*gw;
      if (!(d.obj && d.menu)) { g += '<rect x="'+(x+2)+'" y="'+(y0+2)+'" width="'+(gw-4)+'" height="'+(rh-4)+'" rx="6" fill="none" stroke="'+pal.line+'"/>'; return; }
      const v = (d.real || d.menu)[k], o = d.obj[k], pct = o ? v/o : 0, dif = Math.round(v - o);
      const c = estado(pct, pal);
      g += '<rect x="'+(x+2)+'" y="'+(y0+2)+'" width="'+(gw-4)+'" height="'+(rh-4)+'" rx="6" fill="'+c+'" opacity="0.9"/>';
      g += '<text x="'+(x+gw/2)+'" y="'+(y0+rh/2-1)+'" font-size="14" font-weight="800" text-anchor="middle" fill="#10161d">'+Math.round(pct*100)+'%</text>';
      g += '<text x="'+(x+gw/2)+'" y="'+(y0+rh/2+15)+'" font-size="11" font-weight="700" text-anchor="middle" fill="#10161d">'+(dif > 0 ? '+' : dif < 0 ? '−' : '')+Math.abs(dif)+' g</text>';
    });
  });
  ds.forEach((d, i) => g += '<text x="'+(ml+i*gw+gw/2)+'" y="'+(mt+rh*3+20)+'" font-size="13" font-weight="800" text-anchor="middle" fill="'+pal.txt+'">'+d.lbl.slice(0,3)+'</text>');
  return g + '</svg>';
}
function leyendaMacros(pal){ return leyenda([['Cubre 95–105 %', pal.ok], ['±10 %', pal.warn], ['Fuera de rango', pal.bad]], pal) + '<p style="font-size:13px;color:'+pal.muted+';margin:2px 0 0">Cada casilla: % del objetivo del día y gramos de más (+) o de menos (−).</p>'; }
function lecturaRapida(ds, rs, kg, pal){
  const c = ds.filter(d => d.obj && d.menu); if (!c.length) return '';
  const fin = d => d.real || d.menu, out = [];
  const med = (k, f) => c.reduce((a, d) => a + f(d)[k], 0)/c.length;
  [['prot','Proteína','proteína'],['carb','Carbohidratos','hidratos'],['fat','Grasa','grasa']].forEach(([k, N, n]) => {
    const o = med(k, d => d.obj), m = med(k, fin), dif = m - o, pct = o ? m/o : 1;
    const ico = pct >= 0.95 && pct <= 1.05 ? '✅' : (pct >= 0.9 && pct <= 1.1 ? '🟡' : '🔴');
    out.push(ico+' <b>'+N+'</b>: '+(Math.abs(pct-1) <= 0.05 ? 'bien cubierta' : dif < 0 ? 'faltan unos '+Math.abs(Math.round(dif))+' g al día ('+Math.round(pct*100)+' %)' : 'sobran unos '+Math.round(dif)+' g al día ('+Math.round(pct*100)+' %)')+'.');
  });
  if (med('prot', fin) < 0.9*med('prot', d => d.obj)) out.push('💡 Para llegar a la proteína con las kcal del día hacen falta recetas más ricas en proteína (pescado, pollo, pavo, claras, yogur o queso fresco proteico) o un complemento. Añádelas al Recetario y vuelve a proponer el menú.');
  { const pp = pacienteActual(), pl = pp && planSemana(pp), rs2 = resumenSemana(ds);
    if (pl && pl.obj !== 'mantener' && rs2.previsto !== null && Math.abs(rs2.previsto) > 1) {
      const dif = rs2.balance - rs2.previsto, ok = Math.abs(dif) <= Math.max(300, 0.15*Math.abs(rs2.previsto));
      out.push((ok ? '✅' : '🟡')+' Balance de la semana: <b>'+(rs2.balance >= 0 ? '+' : '−')+fmtN(Math.abs(rs2.balance))+' kcal</b> frente a <b>'+(rs2.previsto >= 0 ? '+' : '−')+fmtN(Math.abs(rs2.previsto))+' kcal previstos</b> para llevar el ritmo de '+(Math.round(pl.ritmo*100)/100).toLocaleString('es-ES')+' kg/semana'+(ok ? '.' : (dif > 0 ? ': el menú aporta de más y se avanzará más despacio.' : ': el menú se queda corto de energía.')));
    } }
  const cortos = c.filter(d => d.nivel >= 3 && fin(d).kcal < d.obj.kcal*0.97);
  if (cortos.length) out.push('🔴 Sin energía suficiente en día de carga: '+cortos.map(d => d.lbl.slice(0,3)+' (faltan '+fmtN(d.obj.kcal - fin(d).kcal)+' kcal)').join(', ')+'. Sube raciones o añade comidas antes de entrenar.');
  const malos = c.filter(d => { const p = fin(d).kcal/d.obj.kcal; return p < 0.9 || p > 1.1; });
  out.push((malos.length ? '🔴 Energía: '+malos.map(d => d.lbl.slice(0,3)+' '+Math.round(fin(d).kcal/d.obj.kcal*100)+' %').join(', ')+' se salen del ±10 %.' : '✅ Energía: todos los días con menú están dentro del ±10 % del objetivo.'));
  const cargas = c.filter(d => d.nivel >= 3 && fin(d).kcal < d.obj.kcal*0.95);
  if (cargas.length) out.push('⚠️ '+cargas.map(d => d.lbl.slice(0,3)).join(', ')+': día de carga con menos energía de la necesaria; sube raciones antes de entrenar.');
  const deficit = c.filter(d => d.nivel >= 3 && d.obj.kcal < d.gasto - 1);
  if (deficit.length) out.push('⚠️ Hay déficit en un día de entreno Medio/Alto; no debería.');
  return '<ul style="margin:0 0 4px 0;padding:0;list-style:none;font-size:'+(pal === PAL_PDF ? 13 : 16)+'px;line-height:1.5">'+out.map(x => '<li style="margin-bottom:4px">'+x+'</li>').join('')+'</ul>';
}
function tablaCifras(ds, pal){
  const f = (v) => v ? fmtN(v.kcal) : '–';
  const hayR = ds.some(d => d.real);
  return '<table class="cifras" style="width:100%;border-collapse:collapse;font-size:15px;color:'+pal.txt+'"><thead><tr style="text-align:right"><th style="text-align:left;padding:4px 6px">Día</th><th>Gasto</th><th>Objetivo</th><th>Menú</th>'+(hayR ? '<th>Real</th>' : '')+'</tr></thead><tbody>' +
    ds.map(d => '<tr style="border-top:1px solid '+pal.line+';text-align:right"><td style="text-align:left;padding:5px 0"><b>'+d.lbl.slice(0,3)+'</b> <span style="color:'+(d.nivel ? LVL_COL[d.nivel-1] : pal.muted)+'">'+(d.nivel ? NIVELES[d.nivel-1] : '—')+'</span></td><td>'+(d.gasto ? fmtN(d.gasto) : '–')+'</td><td>'+f(d.obj)+'</td><td>'+f(d.menu)+'</td>'+(hayR ? '<td>'+f(d.real)+'</td>' : '')+'</tr>').join('') + '</tbody></table>';
}
function kpi(t, v, sub, color){
  return '<div style="flex:1 1 140px;background:var(--t-bg2);border:1px solid var(--t-line);border-radius:14px;padding:10px 12px"><div style="font-size:14px;color:var(--t-muted)">'+t+'</div><div style="font:800 24px var(--font);color:'+(color||'var(--t-text)')+'">'+v+'</div>'+(sub ? '<div style="font-size:14px;color:var(--t-muted)">'+sub+'</div>' : '')+'</div>';
}
async function guardarNotas(){
  const v = ($('#notas') && $('#notas').value) || '';
  S.notas = v;
  try { await refPac(S.pid).collection('weeks').doc(S.weekStart).set({notes:v, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}, {merge:true}); setMsg('Notas guardadas.', true); }
  catch(e){ setMsg('No se pudieron guardar las notas ('+((e && (e.code||e.message)) || 'error')+').', false); }
  render();
}
/* ---------- lista de la compra ---------- */
const ORDEN_CAT = ['Verduras y hortalizas','Frutas','Carnes y pescados','Lácteos y huevos','Cereales, legumbres y pan','Aceites, frutos secos y despensa','Otros'];
function compraSemana(){
  const ing = {}, platos = {};
  (S.menu || []).forEach(dia => (dia && dia.meals || []).forEach(m => {
    if (!m.rid) return;
    const r = m.alimento ? {name:m.name, servings:1, ingredients:m.ing || []} : recetaPorId(m.rid); if (!r) return;
    platos[r.name] = (platos[r.name] || 0) + 1;
    const f = (m.s || 1) / Math.max(r.servings || 1, 1);
    // los ingredientes de la receta están escritos para TODAS las raciones; la comida usa m.s raciones
    (r.ingredients || []).forEach(l => {
      const x = window.RPT_RECETAS.ingredienteCompra(l); if (!x) return;
      const a = ing[x.clave] || (ing[x.clave] = {nombre:x.nombre, cat:x.cat, gramos:0, uds:0, veces:0, suelto:false});
      a.veces++; if (x.gramos !== null) a.gramos += x.gramos * f; if (x.uds !== null) a.uds += x.uds * f; if (x.suelto) a.suelto = true;
    });
  }));
  const grupos = {};
  Object.keys(ing).forEach(k => { const a = ing[k]; (grupos[a.cat] || (grupos[a.cat] = [])).push(Object.assign({k}, a)); });
  return ORDEN_CAT.filter(c => grupos[c]).map(c => ({cat:c, items:grupos[c].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))}));
}
function cantCompra(a){
  const parts = [];
  if (a.gramos > 0) parts.push(a.gramos >= 1000 ? (Math.round(a.gramos/100)/10).toLocaleString('es-ES')+' kg' : (Math.round(a.gramos/5)*5)+' g');
  if (a.uds > 0 && a.gramos > 0 && a.uds < 40) parts.push('≈ '+(Math.round(a.uds*2)/2).toLocaleString('es-ES')+' uds');
  else if (a.uds > 0 && !(a.gramos > 0)) parts.push((Math.round(a.uds*2)/2).toLocaleString('es-ES')+' uds');
  return parts.join(' · ') || 'al gusto';
}
function compraOk(){ try { return JSON.parse(localStorage.getItem('nu_compra_'+S.pid+'_'+S.weekStart) || '{}'); } catch(e){ return {}; } }
function toggleCompra(k){ const o = compraOk(); if (o[k]) delete o[k]; else o[k] = 1; try { localStorage.setItem('nu_compra_'+S.pid+'_'+S.weekStart, JSON.stringify(o)); } catch(e){} render(); }
function vCompra(pdf){
  const gr = compraSemana(); if (!gr.length) return '';
  const ok = pdf ? {} : compraOk();
  const nTot = gr.reduce((a, g) => a + g.items.length, 0), nOk = Object.keys(ok).filter(k => gr.some(g => g.items.some(i => i.k === k))).length;
  return '<div class="card"><h3>Lista de la compra</h3>' + (pdf ? '' : '<p class="sub" style="margin-bottom:8px">Calculada con las recetas del menú de esta semana y las raciones de cada comida. Toca un producto para tacharlo ('+nOk+' de '+nTot+').</p>') +
    gr.map(g => '<h4 style="margin:12px 0 4px;font-size:'+(pdf ? 14 : 17)+'px;color:'+(pdf ? '#9a7420' : 'var(--t-accent)')+'">'+g.cat+'</h4><div'+(pdf ? '' : ' class="list"')+'>' + g.items.map(i =>
      pdf ? '<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px solid #e6ebf0;font-size:13px"><span>☐ '+esc(i.nombre)+'</span><b>'+cantCompra(i)+'</b></div>'
          : '<button class="row" data-act="chkCompra" data-k="'+esc(i.k)+'" style="'+(ok[i.k] ? 'opacity:.5;text-decoration:line-through' : '')+'"><span style="font-size:22px;margin-right:10px">'+(ok[i.k] ? '☑' : '☐')+'</span><div class="grow"><b style="font-size:17px">'+esc(i.nombre)+'</b></div><b style="font-size:17px;white-space:nowrap">'+cantCompra(i)+'</b></button>').join('') + '</div>').join('') + '</div>';
}
/* ---------- informe de la semana (PDF) ---------- */
const EXTRA_HIDRA = {1:200, 2:500, 3:600, 4:900};
function pautasAuto(p, ds, rs){
  const kg = kgDe(), obj = tipoObjetivo(p), out = [];
  const niv = [...new Set(ds.filter(d => d.nivel).map(d => d.nivel))].sort();
  out.push('<b>Hidratación:</b> '+niv.map(n => NIVELES[n-1]+' '+((kg*35 + EXTRA_HIDRA[n])/1000).toFixed(1).replace('.', ',')+' L').join(' · ')+' (35 ml por kg de peso más un extra según la intensidad del día). Orientativo: el color de la orina y la sed ayudan a ajustar.');
  out.push('<b>Reparto de la proteína:</b> objetivo de 2 g por kg ('+Math.round(2*kg)+' g al día), repartida entre todas las comidas del día para mantener masa muscular.');
  if (ds.some(d => d.nivel >= 3)) out.push('<b>Días de carga (Media y Alta):</b> se come al nivel del gasto, sin déficit. Concentra los hidratos en la comida previa al entreno (2–3 h antes) y en la posterior; evita las grasas y la fibra en exceso justo antes de entrenar.');
  if (obj === 'bajar') out.push('<b>Pérdida de peso:</b> el déficit (−15 %) solo se aplica en los días de Descanso y Baja. Nunca se recorta la comida de los días de entreno Medio o Alto ni los de competición: bajar de peso no puede restar fuerza ni energía al entreno.');
  if (obj === 'subir') out.push('<b>Aumento de peso:</b> se suma un superávit del 10 % sobre el gasto estimado. Si el peso no sube tras 2–3 semanas, sube las raciones de los hidratos.');
  const fin = sumaDias(S.weekStart, 6), cs = compsDe(p).filter(c => c.date >= S.weekStart && c.date <= fin);
  cs.forEach(c => out.push('<b>Competición — '+esc(c.name)+' ('+fechaCorta(c.date)+(c.weighIn ? ', pesaje '+esc(c.weighIn) : '')+(c.start ? ', inicio '+esc(c.start) : '')+'):</b> sin déficit el día anterior ni el de la competición, nada de alimentos nuevos, comidas de fácil digestión y un buen aporte de hidratos y líquidos.'));
  if (ds.some(d => d.nota && d.nota.indexOf('carbohidratos bajos') >= 0)) out.push('<b>Atención:</b> algún día queda con carbohidratos por debajo de 3 g/kg; revisa las raciones o el objetivo.');
  out.push('<b>Seguimiento:</b> pésate en ayunas, a la misma hora, y valora la tendencia semanal, no el dato de un día. Si se sube o baja demasiado rápido, hay que reajustar las raciones.');
  return out;
}
function explicacionSemana(p, ds, rs){
  const kg = kgDe(), obj = tipoObjetivo(p), n = k => ds.filter(d => d.nivel === k).length;
  const ent = n(3) + n(4), trozos = [];
  trozos.push('Esta semana tiene <b>'+ent+' día'+(ent === 1 ? '' : 's')+' de entreno exigente</b> ('+n(4)+' Alto y '+n(3)+' Medio), '+n(2)+' de intensidad Baja y '+n(1)+' de Descanso.');
  const reposo = ds.find(d => d.nivel) ? calcDia(p, ds.find(d => d.nivel).nivel, ds.find(d => d.nivel).fecha, kg, diasCompeticion(p.id)).reposo : 0;
  trozos.push('El gasto estimado parte del metabolismo en reposo ('+fmtN(reposo)+' kcal, fórmula de Mifflin-St Jeor con '+kgTxt(kg)+' kg) multiplicado por un factor según el nivel del día: 1,2 · 1,375 · 1,55 · 1,725 (Descanso, Baja, Media, Alta).');
  trozos.push(obj === 'bajar' ? 'Como el objetivo es bajar peso, el déficit solo se aplica en los días de Descanso y Baja; en los días Medio, Alto y de competición se come lo que se gasta, de modo que el entreno no pierde energía.' : obj === 'subir' ? 'Como el objetivo es ganar peso, se añade un superávit del 10 % a todos los días.' : 'Como el objetivo es mantener, el objetivo diario coincide con el gasto estimado.');
  trozos.push('Los macros se calculan así: proteína 2 g/kg, grasa 1 g/kg (hasta 0,7 g/kg si hace falta) y el resto en carbohidratos, protegiendo un mínimo de 3 g/kg para el entreno.');
  { const pl = planSemana(p); if (pl && pl.obj !== 'mantener') trozos.push('<b>Objetivo:</b> '+(pl.obj === "bajar" ? 'bajar' : 'subir')+(fechaObjetivo(p).date ? ' (fecha objetivo '+fechaCorta(fechaObjetivo(p).date)+') ' : '')+' a '+(Math.round(pl.ritmoPedido*100)/100).toLocaleString('es-ES')+' kg por semana'+(p.targetKg ? ' hasta '+kgTxt(parseFloat(p.targetKg))+' kg' : '')+'. Esta semana cabe '+(Math.round(pl.ritmo*100)/100).toLocaleString('es-ES')+' kg ('+fmtN(pl.aplicado)+' kcal repartidas en '+pl.diasConDeficit+' días de Descanso/Baja)'+(pl.limitado ? ': el ritmo pedido no cabe sin quitar energía a los días de entreno.' : '.')); }
  if (rs.nMenu) trozos.push('El menú planificado aporta de media <b>'+fmtN(rs.menuMedio)+' kcal/día frente a un objetivo de '+fmtN(rs.objMedio)+'</b> (<b>'+Math.round(rs.cobertura*100)+' %</b> cubierto). Frente al gasto estimado, el balance semanal es de <b>'+(rs.balance >= 0 ? '+' : '−')+fmtN(Math.abs(rs.balance))+' kcal</b> (≈ '+(rs.balance >= 0 ? '+' : '−')+Math.round(Math.abs(rs.balance)/7.7)+' g de grasa).');
  return trozos.map(t => '<p>'+t+'</p>').join('');
}
function tablaMenuPdf(p){
  const slots = []; (S.menu || []).forEach(d => (d && d.meals || []).forEach(m => { if (slots.indexOf(m.slot) < 0) slots.push(m.slot); }));
  const celda = (i, sl) => { const d = S.menu[i]; const m = d && d.meals && d.meals.find(x => x.slot === sl); if (!m || !m.rid) return '<td style="color:#8b98a8">–</td>';
    const v = valsComida(m);
    return '<td><b>'+esc(m.name)+'</b>'+(m.fija ? ' 📌' : '')+'<br><span class="mut">×'+kgTxt(Math.round(m.s*100)/100)+(m.bw ? ' · '+Math.round(v.g)+' g' : '')+' · '+Math.round(v.kcal)+' kcal</span></td>'; };
  const cab = DIAS.map((d, i) => '<th>'+d.slice(0,3)+'<br><span style="font-weight:600;color:'+(S.levels && S.levels[i] ? LVL_COL[S.levels[i]-1] : '#5b6b7e')+'">'+(S.levels && S.levels[i] ? NIVELES[S.levels[i]-1] : '—')+'</span></th>').join('');
  const filas = slots.map(sl => '<tr><th class="sl">'+esc(sl)+'</th>'+DIAS.map((d, i) => celda(i, sl)).join('')+'</tr>').join('');
  const tot = '<tr class="tot"><th class="sl">Total</th>'+DIAS.map((d, i) => { const dia = S.menu[i], o = objetivoDia(p, i); if (!dia || !dia.meals || !dia.meals.some(m => m.rid)) return '<td>–</td>'; const t = totalDia(dia);
    return '<td><b>'+Math.round(t.kcal)+' kcal</b><br><span class="mut">P '+Math.round(t.prot)+' · C '+Math.round(t.carb)+' · G '+Math.round(t.fat)+'</span>'+(o ? '<br><span class="mut">obj. '+o.kcal+'</span>' : '')+'</td>'; }).join('')+'</tr>';
  return '<div style="overflow-x:auto"><table class="mtab"><thead><tr><th class="sl"></th>'+cab+'</tr></thead><tbody>'+filas+tot+'</tbody></table></div>';
}
function cambiosPdf(){
  const filas = [];
  (S.menu || []).forEach((dia, i) => (dia && dia.meals || []).forEach(m => { if (!m.rid || !m.real) return;
    const a = valsComida(m), b = valsReal(m);
    filas.push('<tr><td><b>'+DIAS[i].slice(0,3)+'</b> · '+esc(m.slot)+'</td><td>'+esc(m.name)+'<br><span class="mut">'+Math.round(a.kcal)+' kcal · P '+r1(a.prot)+' · C '+r1(a.carb)+' · G '+r1(a.fat)+'</span></td><td>'+(m.real.none ? '<i>No comió nada</i>' : esc(m.real.name))+'<br><span class="mut">'+Math.round(b.kcal)+' kcal · P '+r1(b.prot)+' · C '+r1(b.carb)+' · G '+r1(b.fat)+'</span></td><td>'+txtVariacion(a, b)+'</td></tr>'); }));
  if (!filas.length) return '';
  return '<section><h2>Cambios sobre la marcha</h2><table class="ctab"><thead><tr><th>Comida</th><th>Planificado</th><th>Comido</th><th>Variación</th></tr></thead><tbody>'+filas.join('')+'</tbody></table></section>';
}
function seguimientoPdf(p){
  const w = S.weights.slice(0, 5), m = S.measures.slice(0, 2);
  if (!w.length && !m.length) return '';
  let h = '<section><h2>Seguimiento: peso y medidas</h2>';
  if (w.length) h += '<p><b>Peso:</b> '+w.map(x => fechaCorta(x.id).slice(0,5)+' · '+kgTxt(x.kg)+' kg').join('  |  ')+(w.length > 1 ? '  →  cambio '+((w[0].kg - w[w.length-1].kg) >= 0 ? '+' : '−')+kgTxt(Math.round(Math.abs(w[0].kg - w[w.length-1].kg)*10)/10)+' kg' : '')+'</p>';
  if (m.length) h += '<table class="ctab"><thead><tr><th>Medida</th><th>'+fechaCorta(m[0].id).slice(0,5)+'</th>'+(m[1] ? '<th>'+fechaCorta(m[1].id).slice(0,5)+'</th><th>Cambio</th>' : '')+'</tr></thead><tbody>'+
    MEDIDAS.filter(([k]) => m[0][k] != null).map(([k, n]) => { const a = m[1] && m[1][k] != null ? m[1][k] : null, d = a !== null ? Math.round((m[0][k] - a)*10)/10 : null;
      return '<tr><td><b>'+esc(medidaNombre(p, k, n))+'</b></td><td>'+kgTxt(m[0][k])+' cm</td>'+(m[1] ? '<td>'+(a !== null ? kgTxt(a)+' cm' : '–')+'</td><td>'+(d !== null ? (d > 0 ? '+' : d < 0 ? '−' : '')+kgTxt(Math.abs(d))+' cm' : '–')+'</td>' : '')+'</tr>'; }).join('')+'</tbody></table>';
  return h + '</section>';
}
function vPdf(p){
  if (!datosOk(p) || !S.levels || !S.levels.some(x => x)) return '';
  const ds = datosSemana(p), rs = resumenSemana(ds), kg = kgDe(), fin = sumaDias(S.weekStart, 6), hayR = ds.some(d => d.real);
  const edad = new Date().getFullYear() - p.birthYear;
  let h = '<div class="pdfdoc"><div class="pdfbar"><button class="btn secondary" data-act="pdfCerrar">‹ Cerrar</button><button class="btn" data-act="pdfImprimir">🖨️ Imprimir / Guardar PDF</button></div><div class="pdfpage">';
  const hd = '<header class="wo2head"><img src="static/icon-192.png" alt="NutriForce" width="64" height="64"><div><div class="ttl">INFORME SEMANAL DE NUTRICIÓN</div>' +
    '<div class="l2">Semana  ·  '+fechaCorta(S.weekStart)+' – '+fechaCorta(fin)+'</div>' +
    '<div class="l2">Usuario: '+esc(p.name)+'  ·  '+esc(p.sex || '')+' · '+edad+' años · '+p.heightCm+' cm · '+kgTxt(kg)+' kg'+(p.goal ? '  ·  Objetivo: '+esc(p.goal) : '')+'</div></div></header>';
  h += '<div class="pgrp">'+hd;
  h += '<section><h2>Cómo cuadra el menú con la semana de entreno</h2>'+explicacionSemana(p, ds, rs)+'</section>';
  if (rs.nMenu) {
    h += '<section><h2>Resumen</h2><div class="kpis"><div><span>Objetivo medio</span><b>'+fmtN(rs.objMedio)+' kcal</b></div><div><span>Menú medio</span><b>'+fmtN(rs.menuMedio)+' kcal</b></div><div><span>Cubierto</span><b>'+Math.round(rs.cobertura*100)+' %</b></div><div><span>Balance semanal</span><b>'+(rs.balance >= 0 ? '+' : '−')+fmtN(Math.abs(rs.balance))+' kcal</b></div></div>' +
      '<h3>Lectura rápida</h3>'+lecturaRapida(ds, rs, kg, PAL_PDF)+'</section></div><div class="pgrp">'+hd+'<section><div class="g2"><div><h3>Energía por día (kcal)</h3>'+chartKcal(ds, PAL_PDF)+leyendaKcal(PAL_PDF, hayR)+'</div>' +
      '<div><h3>Macros: necesarios y en el menú</h3>'+barrasMacros(ds, PAL_PDF, kg)+'</div></div>' +
      '<div class="g2"><div><h3>Macros día a día</h3>'+chartMacrosDia(ds, PAL_PDF)+leyendaMacros(PAL_PDF)+'</div><div><h3>Cifras por día</h3>'+tablaCifras(ds, PAL_PDF)+'</div></div></section>';
    h += '</div><div class="pgrp">'+hd+'<section><h2>Pautas a seguir</h2><ul>'+pautasAuto(p, ds, rs).map(x => '<li>'+x+'</li>').join('')+'</ul>' +
    (S.notas && S.notas.trim() ? '<h3>Notas del nutricionista</h3><p style="white-space:pre-wrap">'+esc(S.notas.trim())+'</p>' : '')+'</section>';

    h += seguimientoPdf(p);
    h += cambiosPdf();
    h += '</div><div class="pgrp menug">'+hd+'<section><h2>Menú de la semana</h2>'+tablaMenuPdf(p)+'</section>';
  } else h += '<section><p class="mut">Esta semana aún no tiene menú.</p></section>';
  if (!rs.nMenu) { h += '<section><h2>Pautas a seguir</h2><ul>'+pautasAuto(p, ds, rs).map(x => '<li>'+x+'</li>').join('')+'</ul>' +
    (S.notas && S.notas.trim() ? '<h3>Notas del nutricionista</h3><p style="white-space:pre-wrap">'+esc(S.notas.trim())+'</p>' : '')+'</section>'; }
  h += '<footer'+(rs.nMenu ? ' style="page:menu"' : '')+'>Generado el '+fechaCorta(iso(new Date()))+' con NutriForce · RPT · Las cifras son estimaciones orientativas.</footer></div></div></div>';
  return h;
}
function tablaMenuApp(p){
  const slots = []; (S.menu || []).forEach(d => (d && d.meals || []).forEach(m => { if (slots.indexOf(m.slot) < 0) slots.push(m.slot); }));
  const cab = DIAS.map((d, i) => '<th>'+d.slice(0,3)+'<br><span style="font-weight:700;color:'+(S.levels && S.levels[i] ? LVL_COL[S.levels[i]-1] : 'var(--t-muted)')+'">'+(S.levels && S.levels[i] ? NIVELES[S.levels[i]-1] : '—')+'</span></th>').join('');
  const celda = (i, sl) => { const d = S.menu[i], j = d && d.meals ? d.meals.findIndex(x => x.slot === sl) : -1; if (j < 0) return '<td></td>'; const m = d.meals[j];
    if (!m.rid) return '<td class="cel" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'" tabindex="0" role="button"><span class="mut">＋ elegir</span></td>';
    const v = valsComida(m);
    return '<td class="cel" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'" tabindex="0" role="button"><b>'+esc(m.name)+'</b>'+(m.fija ? ' 📌' : '')+(m.manual ? ' ✎' : '')+(m.real ? ' 🔁' : '')+'<br><span class="mut">×'+kgTxt(Math.round(m.s*100)/100)+' · '+Math.round(v.kcal)+' kcal</span><br><span class="mut">P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+'</span></td>'; };
  const filas = slots.map(sl => '<tr><th class="sl">'+esc(sl)+'</th>'+DIAS.map((d, i) => celda(i, sl)).join('')+'</tr>').join('');
  const filaExtra = '<tr><th class="sl">Plato adicional</th>'+DIAS.map((d, i) => S.menu[i] && S.menu[i].meals && S.menu[i].meals.length ? '<td class="cel" data-act="addExtra" data-d="'+i+'" tabindex="0" role="button"><span class="mut">＋ añadir</span></td>' : '<td></td>').join('')+'</tr>';
  const tot = '<tr class="tot"><th class="sl">Total del día</th>'+DIAS.map((d, i) => {
    const dia = S.menu[i], o = objetivoDia(p, i); if (!dia || !dia.meals || !dia.meals.some(m => m.rid)) return '<td class="mut">–</td>';
    const t = totalDia(dia), b = S.menuBase && S.menuBase[i];
    const pct = o ? t.kcal/o.kcal : 1, col = estado(pct, PAL_APP);
    const dif = b ? Math.abs(t.kcal - b.kcal) + Math.abs(t.prot - b.prot) + Math.abs(t.carb - b.carb) + Math.abs(t.fat - b.fat) : 0;
    return '<td><b style="color:'+col+'">'+fmtN(t.kcal)+' kcal</b>'+(o ? ' <span class="mut">('+Math.round(pct*100)+'%)</span>' : '')+'<br><span class="mut">obj. '+(o ? o.kcal : '?')+'</span><br><span class="mut">P '+Math.round(t.prot)+(o ? '/'+o.prot : '')+'<br>C '+Math.round(t.carb)+(o ? '/'+o.carb : '')+'<br>G '+Math.round(t.fat)+(o ? '/'+o.fat : '')+'</span>' +
      (dif > 4 ? '<br><span class="chg">Desde el menú generado:<br>'+txtVariacion(b, t)+'</span>' : '') + '</td>'; }).join('')+'</tr>';
  return '<div class="tscroll"><table class="mtabapp"><thead><tr><th class="sl"></th>'+cab+'</tr></thead><tbody>'+filas+filaExtra+tot+'</tbody></table></div>';
}
function vCompraTab(p){
  const c = vCompra(false);
  return cabSemana() + msgHtml() + (c || '<div class="card"><p class="sub">Esta semana aún no hay menú, así que no hay nada que comprar.</p></div>') +
    '<button class="btn secondary" data-act="compraCerrar">Ocultar la lista de la compra</button>';
}
function vResumenSem(p){
  let h = cabSemana() + msgHtml();
  if (!datosOk(p)) return h + '<div class="card"><p class="sub">Para calcular hace falta sexo, año de nacimiento, altura y un peso. Complétalo en Datos.</p></div>';
  if (!S.levels || !S.levels.some(x => x)) return h + '<div class="card"><p class="sub">Esta semana aún no tiene niveles de entreno. Ponlos en la pestaña Entreno.</p></div>';
  const ds = datosSemana(p), rs = resumenSemana(ds), kg = kgDe(), hayR = ds.some(d => d.real);
  if (!rs.nMenu) return h + '<div class="card"><p class="sub" style="margin-bottom:10px">Esta semana aún no tiene menú. Genéralo en la pestaña Menú y aquí verás el resumen y los gráficos.</p><button class="btn" data-act="ptab" data-v="menu">Ir a Menú</button></div>';
  h += eqCard(p);
  const bal = rs.balance, grasa = Math.abs(bal)/7.7;
  const colBal = Math.abs(bal) < 700 ? 'var(--t-good-fg)' : 'var(--t-chg-fg)';
  h += '<div class="card"><h3>Resumen de la semana</h3><div style="display:flex;flex-wrap:wrap;gap:8px">' +
    kpi('Objetivo medio', fmtN(rs.objMedio)+' kcal', 'por día') + kpi('Menú medio', fmtN(rs.menuMedio)+' kcal', (hayR ? 'con lo realmente comido' : 'por día')) +
    kpi('Cubierto', Math.round(rs.cobertura*100)+'%', 'del objetivo', rs.cobertura >= 0.95 && rs.cobertura <= 1.05 ? 'var(--t-good-fg)' : 'var(--t-chg-fg)') +
    kpi('Balance semanal', (bal >= 0 ? '+' : '−')+fmtN(Math.abs(bal))+' kcal', 'frente al gasto estimado (≈ '+(bal >= 0 ? '+' : '−')+Math.round(grasa)+' g de grasa)'+(rs.previsto !== null && Math.abs(rs.previsto) > 1 ? ' · previsto '+(rs.previsto >= 0 ? '+' : '−')+fmtN(Math.abs(rs.previsto)) : ''), colBal) + '</div></div>';
  h += '<div class="card"><h3>Lectura rápida</h3>'+lecturaRapida(ds, rs, kg, PAL_APP)+'</div>';
  h += '<div class="card"><h3 style="margin-bottom:0">Energía por día (kcal)</h3><p class="sub" style="margin-bottom:6px">La barra gris es lo que necesitas ese día; la de color, lo que aporta el menú. La línea discontinua es lo que gastas.</p>' +
    chartKcal(ds, PAL_APP) + leyendaKcal(PAL_APP, hayR) +
    '<div style="margin-top:10px">'+tablaCifras(ds, PAL_APP)+'</div></div>';
  h += '<div class="card"><h3>Macros: necesarios y en el menú</h3>' + barrasMacros(ds, PAL_APP, kg) + '</div>';
  h += '<div class="card"><h3>Macros día a día</h3>' + chartMacrosDia(ds, PAL_APP) + leyendaMacros(PAL_APP) + '</div>';
  return h;
}
function vInforme(p){
  let h = cabSemana() + msgHtml();
  const hayMenu = S.menu && S.menu.some(d => d && d.meals && d.meals.some(m => m.rid));
  if (!hayMenu) return h + '<div class="card"><p class="sub" style="margin-bottom:10px">Esta semana aún no tiene menú. Genéralo en la pestaña Menú.</p><button class="btn" data-act="ptab" data-v="menu">Ir a Menú</button></div>';
  h += '<div class="card"><h3>Lista de la compra</h3><p class="sub" style="margin-bottom:10px">Con las recetas y raciones del menú de esta semana.</p><button class="btn secondary" data-act="compraAbrir">🛒 Abrir la lista de la compra</button></div>';
  h += '<div class="card"><h3>Informe en PDF</h3><p class="sub" style="margin-bottom:8px">Notas para el usuario: aparecerán en el informe, junto a las pautas automáticas.</p>' +
    '<div class="field"><label class="f" for="notas">Notas del nutricionista (esta semana)</label><textarea id="notas" rows="5" style="padding:12px 14px;line-height:1.4">'+esc(S.notas || '')+'</textarea></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="guardarNotas">Guardar notas</button><button class="btn" data-act="pdfAbrir">📄 Ver informe</button></div></div>';
  return h;
}
function vEntreno(p){
  const lv = S.levels || [0,0,0,0,0,0,0];
  const filas = DIAS.map((d,i) =>
    '<div class="weekrow"><div class="day">'+d+'<span class="sub">'+fechaCorta(sumaDias(S.weekStart,i)).slice(0,5)+'</span></div><div class="levels">' +
    [1,2,3,4].map(l => '<button data-l="'+l+'" data-act="nivel" data-d="'+i+'" aria-pressed="'+(lv[i]===l)+'"><span class="bars"><i></i><i></i><i></i><i></i></span>'+NIVELES[l-1]+'</button>').join('') +
    '</div></div>').join('');
  return cabSemana() + msgHtml() + vWorkOutSemana(p) +
    '<div class="card"><h3 style="margin-bottom:0">Intensidad de entreno</h3><p class="sub">Elige un nivel para cada día. Se guarda al tocar. Es el punto de partida del menú.</p>'+filas+'</div>' +
    '<button class="btn" data-act="ptab" data-v="menu">Seguir con el menú ›</button>';
}
function vMenuTab(p){
  const hayNiv = S.levels && S.levels.some(x => x);
  if (!hayNiv) return cabSemana() + msgHtml() + '<div class="card"><h3>Menú de la semana</h3><p class="sub" style="margin-bottom:12px">Para preparar el menú necesito saber la intensidad de entreno de cada día de esta semana.</p><button class="btn" data-act="ptab" data-v="entreno">Ir a Entreno</button></div>';
  const enDia = S.menu && S.menu.some(d => d && d.meals && d.meals.length);
  return cabSemana() + msgHtml() + (enDia ? '' : vObjetivo(p)) + vMenu(p);
}
function norm(t){ return String(t||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
const macrosTxt = r => (r.kcal||0)+' kcal · P '+kgTxt(r.prot||0)+' · C '+kgTxt(r.carb||0)+' · G '+kgTxt(r.fat||0);
function vRecetario(){
  const lista = S.rtab === 'compartidas' ? S.sharedRecipes : S.recipes;
  const q = norm(S.rq);
  const f = lista.filter(r => (S.rtab === 'compartidas' || !S.rgrp || grupoDe(r) === S.rgrp) && (!q || norm([r.name, r.category, r.useIn, (r.ingredients||[]).join(' ')].join(' ')).indexOf(q) >= 0));
  const filas = f.length ? '<div class="list">' + f.map(r =>
    '<button class="row" data-act="verReceta" data-id="'+esc(r.id)+'"><div class="avatar">🍽</div><div class="grow"><b>'+esc(r.name)+'</b>' +
    '<p class="sub">'+esc(macrosTxt(r))+' por ración'+(S.rtab !== 'compartidas' ? ' · '+(grupoDe(r) === 'importada' ? '📄 Word' : grupoDe(r) === 'manual' ? '✍ A mano' : 'anterior') : '')+'</p>' +
    (recetaIncoherente(r) ? '<p class="sub" style="color:var(--t-bad-fg);font-weight:700">⚠ Las kcal no cuadran con los macros (los macros dan unas '+Math.round(kcalMacros(r))+' kcal). Corrígela.</p>' : '') + (r.sinContar && r.sinContar.length ? '<p class="sub" style="color:var(--t-bad-fg);font-weight:700">⚠ Macros incompletos: sin contar '+esc(r.sinContar.join(', '))+'</p>' : '') + '<p class="sub">'+esc([r.category, r.useIn].filter(Boolean).join(' · '))+(S.rtab==='mias' && r.shared ? ' · 🔗 compartida' : '')+(S.rtab==='compartidas' ? ' · de '+esc(r.ownerName||'otro nutricionista') : '')+'</p></div><span class="chev">›</span></button>').join('') + '</div>'
    : '<div class="empty">'+(lista.length ? 'Ninguna receta coincide con la búsqueda.' : (S.rtab==='compartidas' ? 'Todavía nadie ha compartido recetas.' : 'Todavía no tienes recetas.<br>Crea una o importa fichas de Word.'))+'</div>';
  return '<div class="crumbs"><b>Recetario</b></div><div class="content"><h1>Recetario</h1>' +
    '<div class="tabs" role="tablist"><button role="tab" data-act="rtab" data-v="mias" aria-selected="'+(S.rtab==='mias')+'">Mis recetas ('+S.recipes.length+')</button>' +
    '<button role="tab" data-act="rtab" data-v="compartidas" aria-selected="'+(S.rtab==='compartidas')+'">Compartidas ('+S.sharedRecipes.length+')</button></div>' +
    '<div class="field" style="margin-top:14px"><label class="f" for="rq">Buscar</label><input id="rq" type="search" value="'+esc(S.rq)+'" placeholder="Nombre, ingrediente, categoría…" autocomplete="off"></div>' +
    (S.rtab !== 'compartidas' && ['importada','manual','antigua'].filter(g => recetasDeGrupo(g).length).length > 1 ? '<div class="btn-row" style="margin-bottom:10px">' + [['','Todas'],['importada','📄 Word'],['manual','✍ A mano'],['antigua','Anteriores']].filter(x => !x[0] || recetasDeGrupo(x[0]).length).map(x => '<button class="btn '+((S.rgrp||'') === x[0] ? '' : 'secondary')+' small" data-act="rgrp" data-v="'+x[0]+'">'+x[1]+'</button>').join('') + '</div>' : '') +
    (S.rmsg ? '<div class="msg '+(S.rmsgOk?'ok':'err')+'">'+esc(S.rmsg)+'</div>' : '') + filas +
    '<div class="btn-row"><button class="btn" data-act="nuevaReceta">＋ Nueva receta</button><button class="btn secondary" data-act="importarWord">📄 Importar de Word</button></div>' +
    '<button class="btn secondary" style="margin-top:10px" data-act="revisarRec">🔎 Revisar recetas con la base de ingredientes</button>' +
    '<button class="btn secondary" style="margin-top:10px" data-act="fotoAlim">📷 Añadir un alimento con foto'+((S.foods||[]).length ? ' ('+S.foods.length+' propios)' : '')+'</button>' +
    ((S.foods||[]).length ? '<button class="btn ghost" style="margin-top:6px" data-act="misAlim">Ver mis alimentos</button>' : '') +
    '<button class="btn ghost" style="margin-top:10px" data-act="platosFuera">🍔 Añadir platos preparados (fajitas, wraps, Burger King…)</button>' +
    '<button class="btn ghost" style="margin-top:10px" data-act="postresBase">🍎 Añadir postres básicos (fruta, yogur…)</button>' +
    (S.recipes.length ? '<button class="btn danger" style="margin-top:14px" data-act="borrarTodasDlg">🗑 Eliminar recetas… ('+S.recipes.length+')</button>' : '') +
    '<input id="docxIn" type="file" accept=".docx" multiple style="display:none"></div>';
}
async function equipoCambiar(email, alta){
  email = (email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { S.tmsg = 'Escribe un correo válido.'; S.tmsgOk = false; render(); return; }
  if (email === miEmail()) { S.tmsg = 'Ese es tu propio correo.'; S.tmsgOk = false; render(); return; }
  if (alta && (S.team || []).indexOf(email) >= 0) { S.tmsg = 'Ese correo ya tiene acceso.'; S.tmsgOk = false; render(); return; }
  const fv = firebase.firestore.FieldValue, lista = alta ? (S.team || []).concat([email]) : (S.team || []).filter(x => x !== email);
  S.tmsg = alta ? 'Dando acceso…' : 'Quitando acceso…'; S.tmsgOk = true; render();
  try {
    await db.collection('users').doc(S.user.uid).set({nuTeam:lista}, {merge:true});
    for (const col of ['nu_patients', 'nu_recipes']) {
      const snap = await db.collection(col).where('ownerUid','==',S.user.uid).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const b = db.batch(); snap.docs.slice(i, i+400).forEach(d => b.update(d.ref, {teamEmails: alta ? fv.arrayUnion(email) : fv.arrayRemove(email)})); await b.commit();
      }
    }
    S.team = lista;
    S.tmsg = alta ? email+' ya tiene acceso completo. Debe entrar con ese correo y pulsar «Activar modo nutricionista».' : 'Acceso retirado a '+email+'.'; S.tmsgOk = true;
  } catch(e){ S.tmsg = 'No se pudo cambiar ('+((e && (e.code||e.message)) || 'error')+'). Comprueba que has publicado las reglas nuevas de Firebase.'; S.tmsgOk = false; }
  render();
}
function equipoHtml(){
  if (S.view !== 'app') return '';
  if (esMiembro()) return '<div class="card"><h3>Acceso compartido</h3><p class="sub">Trabajas con los usuarios, recetas y menús de <b>'+esc(S.wsOwnerName||'el titular')+'</b>, con todos los permisos.</p></div>';
  return '<div class="card"><h3>Acceso completo para otras personas</h3><p class="sub" style="margin-bottom:10px">Quien añadas aquí verá y podrá cambiar tus usuarios, recetas y menús entrando con su propio correo. Tendrá que pulsar «Activar modo nutricionista» la primera vez.</p>' +
    (S.team || []).map(e => '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px"><b style="flex:1;word-break:break-all">'+esc(e)+'</b><button class="btn secondary small" data-act="equipoQuitar" data-e="'+esc(e)+'">Quitar</button></div>').join('') +
    '<div class="field"><label class="f" for="eq_mail">Correo de la persona</label><input id="eq_mail" type="email" inputmode="email" autocomplete="off" placeholder="nombre@correo.com"></div>' +
    (S.tmsg ? '<div class="msg '+(S.tmsgOk ? 'ok' : 'err')+'">'+esc(S.tmsg)+'</div>' : '') +
    '<button class="btn secondary" data-act="equipoAnadir">＋ Dar acceso completo</button></div>';
}
function vCuenta(){
  return '<div class="crumbs"><b>Cuenta</b></div><div class="content"><h1>Cuenta</h1>' +
    '<div class="card"><p class="sub">Sesión iniciada como</p><b>'+esc(S.user.email)+'</b></div>' +
    S.requests.filter(l => l.status === 'accepted').map(l =>
      '<div class="card"><p class="sub">'+esc(l.nutriName||'Un nutricionista')+' puede leer tus datos de WorkOut y anotarte pesos.</p>' +
      '<button class="btn danger" style="margin-top:10px" data-act="retirar" data-id="'+esc(l.id)+'">Retirar permiso</button></div>').join('') +
    solicitudesHtml() + buscaSolicHtml() + equipoHtml() +
    '<div class="card"><p class="sub">Versión '+esc(versionTexto())+'</p><button class="btn secondary" style="margin-top:10px" data-act="recargar">🔄 Recargar app</button></div>' +
    '<button class="btn danger" data-act="salir">Salir</button></div>';
}
function render(){
  let html;
  if (S.view === 'boot') html = '<div class="app">'+topBar()+'<div class="content"><div class="empty">Cargando…</div></div></div>';
  else if (S.view === 'login') html = vLogin();
  else if (S.view === 'activar') html = vActivar();
  else {
    const cuerpo = S.tab==='recetario' ? vRecetario() : S.tab==='cuenta' ? vCuenta() : (S.pid ? vPaciente() : vPacientes());
    html = '<div class="app'+(S.side ? ' sideopen' : '')+'">'+topBar()+cuerpo+'</div>' + sideHtml();
    if (S.pdf && S.pid) { const pp = pacienteActual(); if (pp) html += vPdf(pp); }
  }
  const ae = document.activeElement, enRoot = ae && $('#root').contains(ae);
  const antes = enRoot && ae.id, val = antes && ae.value;
  const ini = antes && ae.selectionStart, fin = antes && ae.selectionEnd;
  $('#root').innerHTML = html;
  const nuevo = antes && $('#'+antes);
  if (nuevo && val != null) {
    nuevo.value = val; nuevo.focus();
    try { if (ini != null) nuevo.setSelectionRange(ini, fin); } catch(e){}
  }
}
function setMsg(t, ok){ S.msg = t; S.msgOk = !!ok; }

/* ---------- ventana emergente ---------- */
function abrirDlg(html){ $('#dlgBody').classList.remove('pager'); $('#dlgBody').innerHTML = html; $('#dlg').classList.add('open'); }
function cerrarDlg(){ S.slotAll = false; $('#dlg').classList.remove('open'); $('#dlgBody').classList.remove('pager'); S.slotPend = null; }
function selFechaObj(v){
  const cs = v.id ? compsProximas(v).sort((a, b) => a.date < b.date ? -1 : 1) : [], td = v.targetDate || '';
  const hay = cs.some(c => c.date === td);
  let o = '<option value=""'+(!td ? ' selected' : '')+'>'+(cs.length ? 'Competición más próxima ('+fechaCorta(cs[0].date)+')' : 'Sin fecha (ritmo estándar)')+'</option>';
  cs.forEach(c => { o += '<option value="'+c.date+'"'+(td === c.date ? ' selected' : '')+'>'+esc(c.name)+' · '+fechaCorta(c.date)+'</option>'; });
  o += '<option value="otra"'+(td && !hay ? ' selected' : '')+'>Otra fecha…</option>';
  return o;
}
function dlgPaciente(p){
  const v = p || {};
  abrirDlg('<h2>'+(p?'Editar usuario':'Nuevo usuario')+'</h2>' +
    '<div class="field"><label class="f" for="d_name">Nombre</label><input id="d_name" value="'+esc(v.name||'')+'" autocomplete="off"></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="d_sex">Sexo</label><select id="d_sex">'+['','Mujer','Hombre'].map(o=>'<option'+(o===(v.sex||'')?' selected':'')+' value="'+o+'">'+(o||'—')+'</option>').join('')+'</select></div>' +
    '<div class="field"><label class="f" for="d_year">Año de nacimiento</label><input id="d_year" inputmode="numeric" value="'+esc(v.birthYear||'')+'"></div></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="d_h">Altura (cm)</label><input id="d_h" inputmode="numeric" value="'+esc(v.heightCm||'')+'"></div>' +
    '<div class="field"><label class="f" for="d_gt">Objetivo de peso</label><select id="d_gt">'+[['mantener','Mantener'],['bajar','Bajar'],['subir','Subir']].map(o=>'<option value="'+o[0]+'"'+(o[0]===tipoObjetivo(v)?' selected':'')+'>'+o[1]+'</option>').join('')+'</select></div></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="d_tkg">Peso objetivo (kg)</label><input id="d_tkg" inputmode="decimal" value="'+esc(v.targetKg||'')+'" placeholder="Opcional"></div>' +
    '<div class="field"><label class="f" for="d_tsel">Fecha objetivo</label><select id="d_tsel">'+selFechaObj(v)+'</select></div></div><div class="field" id="d_tdwrap" style="'+(selFechaObj(v).indexOf('value="otra" selected') >= 0 ? '' : 'display:none')+'"><label class="f" for="d_tdate">Otra fecha</label><input id="d_tdate" type="date" value="'+esc(v.targetDate||'')+'"></div><p class="sub" style="margin:-4px 0 10px">Por defecto es la competición más próxima. Con el peso y la fecha, la app calcula sola el ritmo semanal y lo ajusta cada semana con tu último peso.</p>' +
    '<div class="field"><label class="f" for="d_dom">Lado dominante</label><select id="d_dom">'+['','Derecho','Izquierdo'].map(o=>'<option'+(o===(v.dominant||'')?' selected':'')+' value="'+o+'">'+(o||'—')+'</option>').join('')+'</select></div>' +
    '<div class="field"><label class="f" for="d_goal">Objetivo (texto libre)</label><input id="d_goal" value="'+esc(v.goal||'')+'" placeholder="Opcional"></div>' +
    '<div class="field"><label class="f" for="d_notes">Notas</label><input id="d_notes" value="'+esc(v.notes||'')+'"></div>' +
    '<div class="msg err" id="d_msg"></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn" data-act="guardarPaciente" data-id="'+esc(v.id||'')+'">Guardar</button></div>');
}

/* ---------- medidas (perímetros) y avisos ---------- */
const MEDIDAS = [['abdomen','Abdomen','m_ab'],['chest','Pecho','m_ch'],['arm','Brazo','m_arm'],['thigh','Muslo','m_th']];
const diasEntre = (a, b) => Math.round((new Date(b+'T00:00') - new Date(a+'T00:00'))/864e5);
const medidaNombre = (p, k, n) => (k === 'arm' || k === 'thigh') ? n+(p.dominant ? ' '+(k === 'arm' ? (p.dominant === 'Derecho' ? 'derecho' : 'izquierdo') : (p.dominant === 'Derecho' ? 'derecho' : 'izquierdo')) : ' dominante') : n;
async function cargarMedidas(){
  const snap = await refPac(S.pid).collection('measures').get();
  S.measures = snap.docs.map(d => Object.assign({id:d.id}, d.data())).sort((a,b) => a.id < b.id ? 1 : -1);
}
function avisosHtml(p){
  const hoy = iso(new Date()), out = [];
  const w = S.weights[0], dw = w ? diasEntre(w.id, hoy) : null;
  if (dw === null || dw >= 7) out.push('<button class="chip aviso" data-act="pesoDlg">⚖️ Toca pesarse'+(dw === null ? ' (sin pesos)' : ' · hace '+dw+' días')+'</button>');
  const m = S.measures[0], dm = m ? diasEntre(m.id, hoy) : null;
  if (dm === null || dm >= 30) out.push('<button class="chip aviso" data-act="medidasDlg">📏 Toca medirse'+(dm === null ? ' (sin medidas)' : ' · hace '+dm+' días')+'</button>');
  return out.length ? '<div class="avisos">'+out.join('')+'</div>' : '';
}
function dlgMedidas(){
  const p = pacienteActual(), u = S.measures[0] || {};
  abrirDlg('<h2>Anotar medidas</h2><p class="sub" style="margin-bottom:12px">Perímetros en centímetros, con cinta métrica, por la mañana y en el mismo punto cada vez. Al menos una vez al mes.'+(p && !p.dominant ? ' <b>Indica el lado dominante en «Editar datos».</b>' : '')+'</p>' +
    '<div class="grid2">'+MEDIDAS.map(([k, n, id]) => '<div class="field"><label class="f" for="'+id+'">'+esc(medidaNombre(p || {}, k, n))+' (cm)</label><input id="'+id+'" inputmode="decimal" placeholder="'+(u[k] ? 'antes '+kgTxt(u[k]) : 'cm')+'"></div>').join('')+'</div>' +
    '<div class="msg err" id="m_msg"></div><div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn" data-act="guardarMedidas">Guardar</button></div>');
}
async function guardarMedidas(){
  const datos = {}; let alguna = false;
  for (const [k, n, id] of MEDIDAS) {
    const t = ($('#'+id).value || '').trim().replace(',', '.'); if (!t) continue;
    const v = parseFloat(t); if (!(v >= 10 && v <= 250)) { $('#m_msg').textContent = n+': escribe un valor entre 10 y 250 cm.'; return; }
    datos[k] = Math.round(v*10)/10; alguna = true;
  }
  if (!alguna) { $('#m_msg').textContent = 'Escribe al menos una medida.'; return; }
  try {
    await refPac(S.pid).collection('measures').doc(iso(new Date())).set(Object.assign(datos, {by:'nutricion', byUid:S.user.uid, at:firebase.firestore.FieldValue.serverTimestamp()}), {merge:true});
    cerrarDlg(); setMsg('Medidas guardadas.', true); await cargarMedidas();
  } catch(e){ $('#m_msg').textContent = 'No se pudo guardar ('+((e && (e.code || e.message)) || 'error')+'). Si es la primera vez, falta publicar las reglas nuevas de Firebase.'; console.error('medidas', e); return; }
  render();
}
function vMedidasCard(p){
  const m = S.measures, u = m[0], a = m[1];
  const filas = !u ? '<p class="sub" style="margin-bottom:10px">Todavía no hay medidas. Anota la primera.</p>' :
    '<p class="sub" style="margin-bottom:6px">Última toma: '+fechaCorta(u.id)+(a ? ' (cambio frente al '+fechaCorta(a.id)+')' : '')+'</p><div class="list">' +
    MEDIDAS.filter(([k]) => u[k] != null).map(([k, n]) => { const d = a && a[k] != null ? Math.round((u[k] - a[k])*10)/10 : null;
      return '<div class="row"><div class="grow"><b>'+esc(medidaNombre(p, k, n))+'</b></div><b>'+kgTxt(u[k])+' cm</b>'+(d !== null ? '<span class="sub" style="margin-left:10px;color:'+(d === 0 ? 'var(--t-muted)' : (k === 'abdomen' ? (d < 0 ? 'var(--t-good-fg)' : 'var(--t-chg-fg)') : 'var(--t-text)'))+'">'+(d > 0 ? '+' : d < 0 ? '−' : '')+kgTxt(Math.abs(d))+'</span>' : '')+'</div>'; }).join('') + '</div>';
  return '<div class="card"><h3>Medidas</h3>'+filas+'<button class="btn" style="margin-top:10px" data-act="medidasDlg">📏 Anotar medidas</button>' +
    (m.length > 2 ? '<p class="hist" style="margin-top:10px">Anteriores: '+m.slice(2, 6).map(x => fechaCorta(x.id)+' · abd '+(x.abdomen != null ? kgTxt(x.abdomen) : '–')).join(' · ')+'</p>' : '') + '</div>';
}
/* Recordatorios para el calendario del atleta: enlace de Google Calendar y archivo .ics, repetidos solos. */
function proximoDia(f){ let d = new Date(); d.setHours(0,0,0,0); for (let i = 0; i < 40; i++) { if (f(d)) return d; d.setDate(d.getDate() + 1); } return d; }
const ymd = d => d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
function recordatorio(tipo, p){
  const peso = tipo === 'peso';
  const d = peso ? proximoDia(x => x.getDay() === 1) : proximoDia(x => x.getDate() === 1 && x.getTime() > Date.now() - 864e5 + 864e5);
  const ini = ymd(d)+'T080000', fin = ymd(d)+'T081500';
  const titulo = peso ? '⚖️ Pesarse en ayunas (NutriForce)' : '📏 Medidas: abdomen, pecho, brazo y muslo (NutriForce)';
  const det = peso ? 'Pésate en ayunas, tras ir al baño y sin ropa. Avisa a tu nutricionista del peso.' : 'Mide con cinta métrica, por la mañana: abdomen (a la altura del ombligo), pecho, brazo dominante (relajado) y muslo dominante. Anótalas o envíaselas a tu nutricionista.';
  const rrule = peso ? 'FREQ=WEEKLY;BYDAY=MO' : 'FREQ=MONTHLY;BYMONTHDAY=1';
  return {titulo, det, ini, fin, rrule};
}
function urlCalendar(tipo, p){
  const r = recordatorio(tipo, p);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text='+encodeURIComponent(r.titulo)+'&details='+encodeURIComponent(r.det)+'&dates='+r.ini+'/'+r.fin+'&ctz=Europe%2FMadrid&recur='+encodeURIComponent('RRULE:'+r.rrule);
}
function descargarIcs(tipo, p){
  const r = recordatorio(tipo, p), esc2 = t => t.replace(/[\\,;]/g, m => '\\'+m).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//NutriForce//ES','CALSCALE:GREGORIAN','BEGIN:VEVENT','UID:nutriforce-'+tipo+'-'+(p.id || 'x')+'@rafaparri.github.io','DTSTAMP:'+new Date().toISOString().replace(/[-:]/g, '').slice(0,15)+'Z','DTSTART;TZID=Europe/Madrid:'+r.ini,'DTEND;TZID=Europe/Madrid:'+r.fin,'RRULE:'+r.rrule,'SUMMARY:'+esc2(r.titulo),'DESCRIPTION:'+esc2(r.det),'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:'+esc2(r.titulo),'TRIGGER:-PT0M','END:VALARM','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([ics], {type:'text/calendar'})); a.download = 'nutriforce-'+tipo+'.ics'; document.body.appendChild(a); a.click(); a.remove();
}
function vCalCard(p){
  const bloque = (tipo, ico, txt) => '<div style="padding:10px 0;border-top:1px solid var(--t-line)"><b>'+ico+' '+txt+'</b><div class="btn-row" style="margin-top:8px"><button class="btn" data-act="calAbrir" data-t="'+tipo+'">Añadir a Google Calendar</button></div>' +
    '<div class="btn-row" style="margin-top:8px"><button class="btn secondary" data-act="calCopiar" data-t="'+tipo+'">Copiar enlace</button><button class="btn secondary" data-act="calIcs" data-t="'+tipo+'">Descargar .ics</button></div></div>';
  return '<div class="card"><h3>Avisos en el calendario del atleta</h3><p class="sub" style="margin-bottom:6px">Crea un evento que se repite solo. Ábrelo desde el calendario del atleta (o copia el enlace y envíaselo): al guardarlo, le avisará cada semana o cada mes.</p>' +
    bloque('peso', '⚖️', 'Pesarse: cada lunes a las 8:00') + bloque('medidas', '📏', 'Medidas: el día 1 de cada mes a las 8:00') + '</div>';
}
/* ---------- datos ---------- */
async function cargarPacientes(){
  const qEquipo = db.collection('nu_patients').where('teamEmails','array-contains',miEmail()).get().catch(e => { console.error('equipo', e); return {docs:[]}; });
  const propios = await db.collection('nu_patients').where('ownerUid','==',S.user.uid).get();
  const compart = await qEquipo;
  const mapa = {}; propios.docs.concat(compart.docs).forEach(d => { mapa[d.id] = Object.assign({id:d.id}, d.data()); });
  const ajeno = compart.docs.find(d => d.data().ownerUid && d.data().ownerUid !== S.user.uid);
  S.wsOwner = ajeno ? ajeno.data().ownerUid : S.user.uid;
  S.patients = Object.keys(mapa).map(k => mapa[k]).sort((a,b) => String(a.name||'').localeCompare(String(b.name||''),'es'));
  if (esMiembro()) {
    try { const od = await db.collection('users').doc(S.wsOwner).get(); const o = od.exists ? od.data() : {}; S.prefs = o.nuPrefs || {}; S.wsTeamList = Array.isArray(o.nuTeam) ? o.nuTeam : []; S.wsOwnerName = o.name || o.email || 'el titular'; }
    catch(e){ console.error('titular', e); S.wsTeamList = [miEmail()]; S.wsOwnerName = 'el titular'; }
  }
}
async function cargarLinks(){
  const snap = await db.collection('nu_links').where('ownerUid','==',S.user.uid).get();
  S.links = snap.docs.map(d => Object.assign({id:d.id}, d.data()));
}
async function cargarSolicitudes(){
  S.reqErr = null;
  try {
    const snap = await db.collection('nu_links').where('email','==',(S.user.email||'').toLowerCase()).get();
    S.requests = snap.docs.map(d => Object.assign({id:d.id}, d.data()));
  } catch(e){ S.requests = []; S.reqErr = (e && (e.code||e.message)) || 'error'; }
}
async function leerWorkOut(pid){
  const l = linkDe(pid);
  S.woMsg = null;
  if (!l || l.status !== 'accepted' || !l.clubId || !l.patientUid) { render(); return; }
  try {
    const base = db.collection('clubs').doc(l.clubId).collection('athletes').doc(l.patientUid);
    const r = await Promise.all([base.collection('plans').get(), base.collection('competitions').get(), base.collection('progress').doc('profile').get()]);
    S.wo[pid] = {
      plans: r[0].docs.map(d => Object.assign({id:d.id}, d.data())).sort((a,b) => (b.uploadedAt||0)-(a.uploadedAt||0)),
      comps: r[1].docs.map(d => Object.assign({id:d.id}, d.data())),
      metrics: r[2].exists && Array.isArray(r[2].data().metrics) ? r[2].data().metrics : [],
      moves: r[2].exists && r[2].data().moves && typeof r[2].data().moves === 'object' ? r[2].data().moves : {}
    };
  } catch(e){ S.woMsg = 'No se pudo leer WorkOut ('+((e && (e.code||e.message)) || 'error')+').'; console.error('wo', e); }
}
async function cargarPesos(){
  // Sin orderBy: se leen todos (pocos) y se ordenan aquí, por si falla el orden en el servidor.
  const snap = await refPac(S.pid).collection('weights').get();
  S.weights = snap.docs.map(d => Object.assign({id:d.id}, d.data()))
    .sort((a,b) => a.id < b.id ? 1 : -1);
  const w = S.wo[S.pid];
  if (w) {
    const propios = {}; S.weights.forEach(x => propios[x.id] = true);
    w.metrics.filter(m => m && m.peso != null && m.date).forEach(m => {
      const id = new Date(m.date).toISOString().slice(0,10);
      if (!propios[id]) S.weights.push({id, kg:m.peso, by:'workout'});
    });
    S.weights.sort((a,b) => a.id < b.id ? 1 : -1);
  }
  S.weights = S.weights.slice(0, 8);
}
async function cargarSemana(){
  const d = await refPac(S.pid).collection('weeks').doc(S.weekStart).get();
  S.levels = d.exists && Array.isArray(d.data().levels) ? d.data().levels : null;
  S.menu = d.exists && Array.isArray(d.data().menu) ? d.data().menu : null;
  S.menuBase = d.exists && Array.isArray(d.data().menuBase) ? d.data().menuBase : null;
  S.notas = d.exists && typeof d.data().notes === 'string' ? d.data().notes : '';
}
async function abrirPaciente(id){
  S.mdia = null; S.pid = id; S.tab = 'pacientes'; S.ptab = 'menu'; S.compraOn = false; S.menuBase = null; S.weights = []; S.measures = []; S.levels = null; S.menu = null; S.weekStart = lunesISO(new Date()); setMsg(null);
  render();
  const l0 = linkDe(id); if (l0 && l0.status === 'accepted') await leerWorkOut(id);
  try { await cargarPesos(); } catch(e){ setMsg('No se pudo leer el peso (' + ((e && (e.code || e.message)) || 'error') + ').', false); console.error('pesos', e); }
  try { await cargarMedidas(); } catch(e){ S.measures = []; console.error('medidas', e); }
  render();
  if (S.pid === id) await cambiarSemana(0);
  const pa = pacienteActual(); if (pa && S.pid === id) preguntarHoras(pa);
}
async function guardarPaciente(id){
  const g = x => ($('#'+x).value || '').trim();
  const name = g('d_name');
  if (!name){ $('#d_msg').textContent = 'Escribe el nombre.'; return; }
  const num = x => { const n = parseInt(g(x),10); return isFinite(n) ? n : null; };
  const h = num('d_h'), y = num('d_year');
  if (h !== null && (h < 80 || h > 250)){ $('#d_msg').textContent = 'La altura debe estar entre 80 y 250 cm.'; return; }
  if (y !== null && (y < 1900 || y > new Date().getFullYear())){ $('#d_msg').textContent = 'Año de nacimiento no válido.'; return; }
  const dec = x => { const n = parseFloat(g(x).replace(',', '.')); return isFinite(n) && n > 0 ? n : null; };
  const tk = dec('d_tkg'), sel = g('d_tsel'), td = sel === 'otra' ? (g('d_tdate') || null) : (sel || null), rt = null;
  if (tk !== null && (tk < 30 || tk > 250)){ $('#d_msg').textContent = 'El peso objetivo debe estar entre 30 y 250 kg.'; return; }
  if (td && !tk){ $('#d_msg').textContent = 'Para usar una fecha objetivo escribe también el peso objetivo.'; return; }
  const datos = { name, sex:g('d_sex'), birthYear:y, heightCm:h, goal:g('d_goal'), goalType:g('d_gt'), notes:g('d_notes'), targetKg:tk, targetDate:td, rateKg:rt, dominant:g('d_dom') };
  try {
    if (id) await refPac(id).update(datos);
    else await db.collection('nu_patients').add(Object.assign({ownerUid:wsUid(), teamEmails:wsTeam(), linkedUid:null, createdAt:firebase.firestore.FieldValue.serverTimestamp()}, datos));
    cerrarDlg(); await cargarPacientes(); render();
  } catch(e){ $('#d_msg').textContent = 'No se pudo guardar. Inténtalo de nuevo.'; }
}
function dlgPeso(){
  const kg = kgDe();
  abrirDlg('<h2>Anotar peso</h2><p class="sub" style="margin-bottom:12px">'+(kg ? 'Último: '+kgTxt(kg)+' kg ('+fechaCorta(S.weights[0].id)+')' : 'Todavía no hay ningún peso.')+'</p>' +
    '<div class="field"><label class="f" for="kg2">Peso en kg</label><input id="kg2" inputmode="decimal" placeholder="por ejemplo 72,5"></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn" data-act="guardarPeso">Guardar</button></div>');
}
async function guardarPeso(){
  const campo = $('#dlg.open #kg2') || $('#kg');
  const kg = parseFloat(String((campo && campo.value || '')).replace(',','.'));
  if (!(kg >= 20 && kg <= 300)){ setMsg('Escribe un peso entre 20 y 300 kg.', false); render(); return; }
  try {
    await refPac(S.pid).collection('weights').doc(iso(new Date())).set({kg:Math.round(kg*10)/10, by:'nutricion', byUid:S.user.uid, at:firebase.firestore.FieldValue.serverTimestamp()});
    const l = linkDe(S.pid);
    if (l && l.status === 'accepted' && l.patientUid) {
      try { await db.collection('users').doc(l.patientUid).collection('bodyLog').doc(iso(new Date())).set({kg:Math.round(kg*10)/10, by:'nutricion', byUid:S.user.uid, at:firebase.firestore.FieldValue.serverTimestamp()}); }
      catch(e){ console.error('bodyLog', e); }
    }
    setMsg('Peso guardado.', true); cerrarDlg(); await cargarPesos();
  } catch(e){ setMsg('No se pudo guardar (' + ((e && (e.code || e.message)) || 'error') + ').', false); console.error('peso', e); }
  render();
}
async function ponerNivel(dia, nivel){
  const lv = (S.levels || [0,0,0,0,0,0,0]).slice(); lv[dia] = nivel; S.levels = lv; setMsg(null); render();
  try { await refPac(S.pid).collection('weeks').doc(S.weekStart).set({levels:lv, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}, {merge:true}); }
  catch(e){ setMsg('No se pudo guardar la semana. Inténtalo de nuevo.', false); render(); }
}
async function cambiarSemana(n){
  S.mdia = null; S.weekStart = sumaDias(S.weekStart, n); S.levels = null; S.menu = null; S.menuBase = null; setMsg(null); render();
  try { await cargarSemana(); } catch(e){ setMsg('No se pudo leer la semana (' + ((e && (e.code || e.message)) || 'error') + ').', false); console.error('semana', e); }
  render();
}
async function borrarPaciente(){
  const p = pacienteActual(); if (!p) return;
  abrirDlg('<h2>Eliminar usuario</h2><p class="sub" style="margin-bottom:14px">Se borrará a <b>'+esc(p.name)+'</b> con sus pesos y semanas. No se puede deshacer.</p>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn danger" data-act="borrarSeguro">Eliminar</button></div>');
}
async function borrarSeguro(){
  const id = S.pid;
  try {
    for (const sub of ['weights','weeks']) {
      const snap = await refPac(id).collection(sub).get();
      const batch = db.batch(); snap.docs.forEach(d => batch.delete(d.ref)); await batch.commit();
    }
    await refPac(id).delete();
    cerrarDlg(); S.pid = null; await cargarPacientes();
  } catch(e){ cerrarDlg(); setMsg('No se pudo eliminar.', false); }
  render();
}

/* ---------- recetas ---------- */
const porNombre = (a,b) => String(a.name||'').localeCompare(String(b.name||''),'es');
async function cargarRecetas(){
  const qEq = db.collection('nu_recipes').where('teamEmails','array-contains',miEmail()).get().catch(e => { console.error('equipo recetas', e); return {docs:[]}; });
  const qSh = db.collection('nu_recipes').where('shared','==',true).get().catch(e => { console.error('compartidas', e); return null; });
  const m = await db.collection('nu_recipes').where('ownerUid','==',S.user.uid).get();
  const mt = await qEq;
  const mapa = {}; m.docs.concat(mt.docs).forEach(d => { mapa[d.id] = Object.assign({id:d.id}, d.data()); });
  const todos = Object.keys(mapa).map(k => mapa[k]).sort(porNombre);
  S.foods = todos.filter(r => r.tipoAlim);
  S.recipes = todos.filter(r => !r.tipoAlim);
  S.foods.forEach(f => { try { RPT_RECETAS.registrarAlimento(f.name, {kcal:f.kcal, prot:f.prot, carb:f.carb, fat:f.fat, peso:f.weight}); } catch(e){} });
  const c = await qSh;
  S._shRaw = c ? c.docs.map(d => Object.assign({id:d.id}, d.data())) : [];
  filtraCompartidas();
}
function filtraCompartidas(){
  S.sharedRecipes = (S._shRaw || []).filter(r => r.ownerUid !== S.user.uid && r.ownerUid !== wsUid() && !S.recipes.some(x => x.id === r.id)).sort(porNombre);
}
function setRmsg(t, ok){ S.rmsg = t; S.rmsgOk = !!ok; }
const recetaPorId = id => S.recipes.concat(S.sharedRecipes).find(r => r.id === id);
function dlgVerReceta(id){
  const r = recetaPorId(id); if (!r) return;
  const mia = r.ownerUid === S.user.uid || r.ownerUid === wsUid();
  abrirDlg('<h2>'+esc(r.name)+'</h2>' +
    '<p class="sub" style="margin-bottom:6px">'+esc(macrosTxt(r))+' por ración</p>' +
    '<p class="sub" style="margin-bottom:12px">'+(r.servings ? r.servings+' raciones · ' : '')+(r.weight ? 'ración de '+r.weight+' g · ' : '')+esc([r.category, r.useIn].filter(Boolean).join(' · '))+(mia ? '' : ' · de '+esc(r.ownerName||'otro nutricionista'))+'</p>' +
    '<h3>Ingredientes</h3><ul style="margin:6px 0 14px 20px;font-size:17px;line-height:1.5">'+(r.ingredients||[]).map(i => '<li>'+esc(i)+'</li>').join('')+'</ul>' +
    (r.prep ? '<h3>Preparación</h3><p style="white-space:pre-wrap;font-size:17px;line-height:1.5;margin:6px 0 14px">'+esc(r.prep)+'</p>' : '') +
    '<div class="msg err" id="r_msg"></div>' +
    (mia
      ? '<button class="btn secondary" data-act="editarReceta" data-id="'+esc(r.id)+'">Editar</button>' +
        '<button class="btn secondary" style="margin-top:10px" data-act="compartirReceta" data-id="'+esc(r.id)+'">'+(r.shared ? '🔒 Dejar de compartir' : '🔗 Compartir con otros nutricionistas')+'</button>' +
        '<button class="btn danger" style="margin-top:10px" data-act="borrarReceta" data-id="'+esc(r.id)+'">Eliminar</button>'
      : '<button class="btn" data-act="copiarReceta" data-id="'+esc(r.id)+'">Copiar a mis recetas</button>') +
    '<button class="btn ghost" style="margin-top:10px" data-act="cerrar">Cerrar</button>');
}
function selBuscable(id, etiqueta, vacio, items, sel){
  const ops = (arr) => '<option value="">'+esc(vacio)+'</option>' + arr.map(x => '<option value="'+esc(x[0])+'"'+(x[0] === sel ? ' selected' : '')+'>'+esc(x[1])+'</option>').join('');
  return '<div class="field"><label class="f" for="'+id+'">'+etiqueta+'</label>' +
    '<input type="search" id="'+id+'_q" data-filtra="'+id+'" data-vacio="'+esc(vacio)+'" data-items="'+esc(JSON.stringify(items))+'" placeholder="Buscar por nombre…" autocomplete="off" aria-label="Buscar en la lista" style="margin-bottom:8px">' +
    '<select id="'+id+'">'+ops(items)+'</select></div>';
}
function filtraSelect(inp){
  const sel = $('#'+inp.dataset.filtra); if (!sel) return;
  const todos = JSON.parse(inp.dataset.items || '[]'), q = norm(inp.value), actual = sel.value;
  const lista = todos.filter(x => !q || norm(x[1]).indexOf(q) >= 0 || x[0] === actual);
  sel.innerHTML = '<option value="">'+esc(q && !lista.length ? 'Ninguna receta coincide' : inp.dataset.vacio)+'</option>' + lista.map(x => '<option value="'+esc(x[0])+'"'+(x[0] === actual ? ' selected' : '')+'>'+esc(x[1])+'</option>').join('');
  sel.value = actual;
}
const USOS = [['Postre','postre'],['Desayuno','desayun'],['Media mañana','media|snack'],['Almuerzo','almuerz|comida'],['Merienda','merienda'],['Cena','cena']];
const usosDe = txt => { const u = norm(txt || ''); return USOS.filter(x => new RegExp(x[1]).test(u)).map(x => x[0]); };
function usoResumen(){ const v = $$('.uso-ck').filter(c => c.checked).map(c => c.value); return v.length ? v.join(', ') : 'Elige una o varias comidas'; }
function usoHtml(valor){
  const sel = usosDe(valor);
  return '<details class="uso" id="r_usoBox"><summary id="r_usoRes" style="min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border:1px solid var(--t-line);border-radius:12px;font-size:17px;cursor:pointer">'+esc(sel.length ? sel.join(', ') : 'Elige una o varias comidas')+'<span aria-hidden="true">▾</span></summary>' +
    '<div style="padding:8px 4px">' + USOS.map(x => '<label style="display:flex;gap:12px;align-items:center;min-height:48px;font-size:18px"><input type="checkbox" class="uso-ck" value="'+x[0]+'" style="width:26px;min-height:26px"'+(sel.indexOf(x[0]) >= 0 ? ' checked' : '')+'> '+x[0]+'</label>').join('') + '</div></details>';
}
const usoLeer = () => $$('.uso-ck').filter(c => c.checked).map(c => c.value).join(', ');
function usoPoner(valor){ const sel = usosDe(valor); $$('.uso-ck').forEach(c => { c.checked = sel.indexOf(c.value) >= 0; }); const r = $('#r_usoRes'); if (r) r.firstChild.textContent = usoResumen(); }
function dlgFormReceta(r, pendientes){
  S.rIncOk = false;
  r = r || {};
  const falta = pendientes > 0 ? '<div class="notice" style="margin-bottom:12px">📄 Receta leída del Word. Revísala. Quedan '+pendientes+' más después de esta.</div>' : '';
  const no = (r.unrecognized && r.unrecognized.length) ? '<div class="notice" style="margin-bottom:12px">No se han reconocido para el cálculo: '+esc(r.unrecognized.join(', '))+'. Corrige los macros a mano si hace falta.</div>' : '';
  let decl = '';
  if (r.declarado) decl = '<div class="notice ok" style="margin-bottom:12px">Los macros vienen declarados en el propio documento (la ficha no tiene ingredientes que calcular).</div>';
  else if (r.declaradoWord && r.declaradoWord.kcal && Math.abs(r.declaradoWord.kcal - (r.kcal||0)) > Math.max(40, 0.1*r.declaradoWord.kcal))
    decl = '<div class="notice" style="margin-bottom:12px">El Word decía <b>'+Math.round(r.declaradoWord.kcal)+' kcal</b> (P '+esc(String(r.declaradoWord.prot).replace('.',','))+' · C '+esc(String(r.declaradoWord.carb).replace('.',','))+' · G '+esc(String(r.declaradoWord.grasa).replace('.',','))+'). La app ha calculado <b>'+Math.round(r.kcal||0)+' kcal</b> con los ingredientes. Revisa las cantidades.</div>';
  const base = (!r.id && !r.name && !pendientes && S.recipes.length)
    ? selBuscable('r_base', 'Partir de una receta ya existente (opcional)', '— empezar en blanco —', S.recipes.slice().sort((x, y) => (x.name||'').localeCompare(y.name||'', 'es')).map(x => [x.id, x.name]), '') : '';
  abrirDlg('<h2>'+(r.id ? 'Editar receta' : 'Receta')+'</h2>' + falta + decl + no + base +
    '<div class="field"><label class="f" for="r_name">Nombre</label><input id="r_name" value="'+esc(r.name||'')+'" autocomplete="off"></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="r_serv">Raciones</label><input id="r_serv" inputmode="numeric" value="'+esc(r.servings||4)+'"></div>' +
    '<div class="field"><label class="f" id="r_uselbl">Utilizar en</label>'+usoHtml(r.useIn || 'Almuerzo, Cena')+'</div></div>' +
    '<div class="field"><label class="f" for="r_ing">Ingredientes (uno por línea)</label><textarea id="r_ing" rows="8" style="padding:12px 14px;line-height:1.4">'+esc((r.ingredients||[]).join('\n'))+'</textarea></div>' +
    '<div class="field"><label class="f" for="r_prep">Preparación</label><textarea id="r_prep" rows="6" style="padding:12px 14px;line-height:1.4">'+esc(r.prep||'')+'</textarea></div>' +
    '<button class="btn secondary" data-act="calcReceta" style="margin-bottom:6px">🧮 Calcular macros desde los ingredientes</button>' +
    '<p class="sub" style="margin-bottom:10px">Por ración. Puedes corregirlos a mano.</p>' +
    '<div class="grid2"><div class="field"><label class="f" for="r_kcal">Kcal</label><input id="r_kcal" inputmode="decimal" value="'+esc(r.kcal||0)+'"></div>' +
    '<div class="field"><label class="f" for="r_w">Peso ración (g)</label><input id="r_w" inputmode="decimal" value="'+esc(r.weight||0)+'"></div></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="r_p">Proteína (g)</label><input id="r_p" inputmode="decimal" value="'+esc(kgTxt(r.prot||0))+'"></div>' +
    '<div class="field"><label class="f" for="r_c">Carbohidratos (g)</label><input id="r_c" inputmode="decimal" value="'+esc(kgTxt(r.carb||0))+'"></div></div>' +
    '<div class="field"><label class="f" for="r_g">Grasa (g)</label><input id="r_g" inputmode="decimal" value="'+esc(kgTxt(r.fat||0))+'"></div>' +
    '<label style="display:flex;gap:10px;align-items:center;margin:6px 0 12px;font-size:17px"><input id="r_sh" type="checkbox" style="width:24px;min-height:24px"'+(r.shared ? ' checked' : '')+'> Compartir con otros nutricionistas</label>' +
    '<div class="msg err" id="r_msg"></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrarReceta">'+(pendientes > 0 ? 'Saltar esta' : 'Cancelar')+'</button><button class="btn" data-act="guardarReceta" data-id="'+esc(r.id||'')+'">'+(pendientes > 0 ? 'Guardar y siguiente' : 'Guardar')+'</button></div>');
  S.formReceta = r;
}
function leerNum(id){ const n = parseFloat(String($('#'+id).value).replace(',', '.')); return isFinite(n) ? n : 0; }
function calcReceta(){
  const lineas = $('#r_ing').value.split('\n').map(x => x.trim()).filter(Boolean);
  const serv = Math.max(parseInt($('#r_serv').value, 10) || 4, 1);
  const e = RPT_RECETAS.estimarMacros(lineas, serv);
  $('#r_kcal').value = e.kcal; $('#r_p').value = kgTxt(e.prot); $('#r_c').value = kgTxt(e.carb); $('#r_g').value = kgTxt(e.grasa); $('#r_w').value = e.peso;
  $('#r_msg').className = 'msg ' + (e.noReconocidos.length ? 'err' : 'ok');
  $('#r_msg').textContent = e.noReconocidos.length ? '⚠ OJO: estos ingredientes NO se han contado, así que los macros están incompletos: '+e.noReconocidos.join(', ')+'. Escribe sus valores de la etiqueta por 100 g al final de la línea, así: «250 g secreto de cerdo [146/19,1/0,5/7,5]» (kcal / proteína / hidratos / grasa) y vuelve a calcular.' : 'Calculado.';
}
async function guardarReceta(id){
  const name = ($('#r_name').value || '').trim();
  const ing = $('#r_ing').value.split('\n').map(x => x.trim()).filter(Boolean);
  if (!name) { $('#r_msg').textContent = 'Escribe el nombre.'; return; }
  if (!ing.length) { $('#r_msg').textContent = 'Escribe al menos un ingrediente.'; return; }
  if (!usoLeer()) { $('#r_usoBox').open = true; $('#r_msg').textContent = 'Elige en qué comidas se puede usar (Desayuno, Almuerzo…).'; return; }
  let kcal = Math.round(leerNum('r_kcal')), prot = leerNum('r_p'), carb = leerNum('r_c'), fat = leerNum('r_g'), peso = Math.round(leerNum('r_w'));
  if (!kcal && !prot && !carb && !fat) { // sin macros: se estiman desde los ingredientes
    const e = RPT_RECETAS.estimarMacros(ing, Math.max(parseInt($('#r_serv').value, 10) || 1, 1));
    kcal = e.kcal; prot = e.prot; carb = e.carb; fat = e.grasa; peso = peso || e.peso;
  }
  if (recetaIncoherente({kcal, prot, carb, fat}) && !S.rIncOk) { S.rIncOk = true; $('#r_msg').className = 'msg err'; $('#r_msg').textContent = '⚠ Las kcal ('+kcal+') no cuadran con los macros: P '+prot+' · C '+carb+' · G '+fat+' dan unas '+Math.round(kcalMacros({prot, carb, fat}))+' kcal. Corrige los valores o pulsa «Calcular desde los ingredientes». Si estás seguro, pulsa Guardar otra vez.'; return; }
  S.rIncOk = false;
  const datos = { name, servings:Math.max(parseInt($('#r_serv').value, 10) || 1, 1), useIn:usoLeer(), ingredients:ing,
    prep:($('#r_prep').value || '').trim(), kcal, prot, carb, fat, weight:peso,
    category:RPT_RECETAS.categorizar(kcal, prot, carb, fat), shared:$('#r_sh').checked, updatedMs:Date.now(),
    sinContar:RPT_RECETAS.estimarMacros(ing, Math.max(parseInt($('#r_serv').value, 10) || 1, 1)).noReconocidos };
  try {
    let nuevoId = null;
    if (id) await db.collection('nu_recipes').doc(id).update(datos);
    else nuevoId = (await db.collection('nu_recipes').add(Object.assign({ownerUid:wsUid(), teamEmails:wsTeam(), ownerName:S.user.displayName || (S.user.email||'').split('@')[0], createdMs:Date.now(), origen:(S.formReceta && S.formReceta.origen) === 'importada' ? 'importada' : 'manual'}, datos))).id;
    await cargarRecetas();
    if (nuevoId && S.slotPend) { const sp = S.slotPend; S.slotPend = null; S.slot = sp; asignarASlot(nuevoId); return; }
  } catch(e){ $('#r_msg').textContent = 'No se pudo guardar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  siguienteDeCola();
}
function asignarASlot(rid){
  const r = recetaPorId(rid), p = pacienteActual(), sl = S.slot; if (!r || !p || !sl) { cerrarDlg(); render(); return; }
  const m0 = S.menu[sl.d].meals[sl.m];
  const pct = (repartoDe(p).find(x => x[0] === m0.slot) || [0,0])[1], obj = objetivoDia(p, sl.d);
  const s = obj && r.kcal > 0 && !m0.extra ? escalaPara(r, {kcal:obj.kcal*pct/100}) : 1;
  cambiarSlot(m => Object.assign(m, comidaDe(r, m.slot, s), {fija:false}), true, DIAS[sl.d]+' · '+m0.slot+': añadida y puesta «'+r.name+'». Ya está también en tu Recetario.');
}
function siguienteDeCola(){
  if (S.cola.length) { const r = S.cola.shift(); dlgFormReceta(r, S.cola.length); }
  else { cerrarDlg(); setRmsg('Receta guardada.', true); render(); }
}
async function importarDocx(files){
  const ok = [], mal = [];
  for (const f of Array.from(files)) {
    try { ok.push(await RPT_RECETAS.leerDocx(await f.arrayBuffer())); }
    catch(e){ mal.push(f.name+' ('+((e && e.message) || 'error')+')'); }
  }
  setRmsg(mal.length ? 'No se pudieron leer: '+mal.join('; ') : null, false);
  if (!ok.length) { render(); return; }
  ok.forEach(r => { r.origen = 'importada'; });
  S.cola = ok; siguienteDeCola(); render();
}
const POSTRES_BASE = [
  ['Pieza de fruta fresca', ['150 g manzana'], 'Una pieza de fruta de temporada (manzana, pera, naranja…). Cambia el nombre de la fruta si prefieres otra.'],
  ['Plátano', ['150 g plátano'], 'Un plátano mediano. Muy bueno en días de más energía.'],
  ['Yogur natural con nueces', ['125 g yogur natural', '20 g nueces'], 'Yogur natural con las nueces troceadas por encima.'],
  ['Yogur con fresas', ['125 g yogur natural', '150 g fresas'], 'Yogur natural con las fresas troceadas.'],
  ['Yogur proteico', ['200 g yogur proteico'], 'Yogur alto en proteínas, solo o con canela.'],
  ['Requesón con fresas', ['150 g requesón', '100 g fresas'], 'Requesón con fresas troceadas.'],
  ['Naranja', ['150 g naranja'], 'Una naranja pelada y en gajos.'],
  ['Chocolate negro 85 %', ['30 g chocolate negro 85%'], 'Unas onzas de chocolate negro de alto porcentaje.']
];
/* Platos de comida rápida: valores ESTIMADOS (el producto salió el 3-nov-2026 y Burger King no publica aún la ficha en abierto). Sustituir por la ficha oficial. */
const PLATOS_FUERA = [
  ['Fajitas de pollo con pimientos y cebolla', 'Almuerzo, Cena', ['150 g pechuga de pollo', '2 tortillas de trigo', '80 g pimiento', '60 g cebolla', '8 g aceite de oliva', '20 g queso rallado'],
   'Corta el pollo en tiras y saltéalo con el pimiento y la cebolla en juliana, con pimentón, comino y ajo. Rellena las tortillas calientes y añade el queso.'],
  ['Wrap de pollo, lechuga y yogur', 'Almuerzo, Cena', ['150 g pechuga de pollo', '1 tortilla de trigo', '40 g lechuga', '50 g tomate', '40 g yogur natural', '20 g queso rallado'],
   'Pollo a la plancha en tiras, con lechuga, tomate y una salsa de yogur natural con limón y especias. Enrolla en la tortilla.'],
  ['Tacos de pollo con pimiento y aguacate', 'Almuerzo, Cena', ['150 g pechuga de pollo', '3 tortillas de maíz', '60 g pimiento', '50 g cebolla', '5 g aceite de oliva', '30 g aguacate'],
   'Pollo salteado con pimiento y cebolla, servido en tres tortillas de maíz con aguacate y limón.'],
  ['Quesadilla de pollo y verduras', 'Almuerzo, Cena', ['120 g pechuga de pollo', '2 tortillas de trigo', '40 g queso mozzarella', '60 g pimiento', '60 g cebolla', '5 g aceite de oliva'],
   'Rellena una tortilla con pollo salteado, verdura y queso, tápala con la otra y dórala por los dos lados en la sartén.'],
  ['Burrito de ternera con arroz y frijoles', 'Almuerzo, Cena', ['140 g ternera magra', '1 tortilla de trigo', '60 g frijoles cocidos [127/8.7/22.8/0.5]', '30 g arroz', '20 g queso rallado', '60 g tomate'],
   'Ternera picada magra salteada con especias, mezclada con arroz cocido, frijoles y tomate. Envuelve en la tortilla con el queso.'],
  ['Arroz con pollo y pimientos', 'Almuerzo, Cena', ['150 g pechuga de pollo', '60 g arroz', '100 g pimiento', '5 ml aceite de oliva'],
   'Dora el pollo en dados, añade el pimiento y el arroz, cubre con agua o caldo y cuece unos 18 minutos.'],
  ['Pasta salteada con pollo y verduras', 'Almuerzo, Cena', ['150 g pechuga de pollo', '70 g pasta', '100 g pimiento', '60 g cebolla', '8 g aceite de oliva'],
   'Pasta cocida y salteada con el pollo en tiras, el pimiento y la cebolla.'],
  ['Pavo con patata y calabacín', 'Almuerzo, Cena', ['160 g pechuga de pavo', '250 g patata', '100 g calabacín', '8 g aceite de oliva'],
   'Pavo a la plancha con patata cocida y calabacín salteado.'],
  ['Hamburguesa Bacon King Pop doble carne + patatas (Burger King, estimado)', 'Almuerzo, Cena', ['280 g Bacon King Pop doble carne [339/21/17/19.6]', '117 g patatas fritas Burger King mediana [207/2.4/28.6/9.2]'],
   'Burger King. Hamburguesa: pan con bacon, dos carnes tipo Whopper, queso fundido, bacon crujiente y salsa Bacon Pop con toque de mantequilla (las palomitas van aparte). Patatas: ración mediana de 117 g (207 kcal por 100 g, según Yazio). VALORES ESTIMADOS de la hamburguesa a partir de hamburguesas parecidas de la carta (The King Bacon 2 carnes ≈ 1005 kcal, Doble Cheese Bacon XXL ≈ 959 kcal). Cuando tengas la ficha oficial de la app de Burger King, edita esta receta y cambia los números.', ['Bacon King Pop doble carne (Burger King, estimado)', 'Bacon King Pop doble carne + patatas (Burger King, estimado)']],
  ['Salmorejo Hacendado con AOVE 8 % (envase 330 ml)', 'Almuerzo, Cena', ['330 g Salmorejo Hacendado AOVE [134/1.5/9.5/10]'],
   'Mercadona, Hacendado. Etiqueta por 100 ml: 134 kcal, grasas 10 g (saturadas 1,4), hidratos 9,5 g (azúcares 2,1), fibra 0,9 g, proteínas 1,5 g, sal 0,95 g. Envase de 330 ml = 1 ración: 442 kcal, 33 g de grasa, 31,4 g de hidratos, 5 g de proteína, 3,1 g de sal. Ingredientes: tomate, aceite de oliva virgen extra (8 %), pan (con gluten), aceite de girasol refinado, vinagre de vino, sal y ajo. Conservar entre 2 y 8 °C y consumir en 24 h una vez abierto.', []]
];
async function platosFuera(){
  const tengo = {}; S.recipes.forEach(r => { tengo[norm(r.name)] = true; });
  let n = 0;
  try {
    for (const [name, uso, ing, prep, viejosL] of PLATOS_FUERA) {
      const e = RPT_RECETAS.estimarMacros(ing, 1);
      const viejos = (viejosL || []).map(norm);
      const antes = S.recipes.find(r => viejos.indexOf(norm(r.name)) >= 0);
      if (antes && norm(name) !== norm(antes.name)) {   // la versión anterior (solo hamburguesa) se actualiza, no se duplica
        await db.collection('nu_recipes').doc(antes.id).update({name, useIn:antes.useIn || uso, ingredients:ing, prep, kcal:e.kcal, prot:e.prot, carb:e.carb, fat:e.grasa, weight:e.peso, category:RPT_RECETAS.categorizar(e.kcal, e.prot, e.carb, e.grasa), sinContar:e.noReconocidos, updatedMs:Date.now()});
        n++; continue;
      }
      if (tengo[norm(name)]) continue;
      await db.collection('nu_recipes').add({ownerUid:wsUid(), teamEmails:wsTeam(), ownerName:S.user.displayName || (S.user.email||'').split('@')[0], createdMs:Date.now(), updatedMs:Date.now(), origen:'manual', name, servings:1, useIn:uso, ingredients:ing, prep, kcal:e.kcal, prot:e.prot, carb:e.carb, fat:e.grasa, weight:e.peso, category:RPT_RECETAS.categorizar(e.kcal, e.prot, e.carb, e.grasa), shared:false, sinContar:e.noReconocidos});
      n++;
    }
    await cargarRecetas();
    setRmsg(n ? 'Listo: añadidos o actualizados '+n+' plato'+(n > 1 ? 's' : '')+' preparado'+(n > 1 ? 's' : '')+'. Los platos de Burger King son una estimación; el salmorejo lleva los datos de la etiqueta.' : 'Ya tienes todos estos platos.', true);
  } catch(e){ setRmsg('No se pudo añadir ('+((e && (e.code||e.message)) || 'error')+').', false); }
  render();
}
async function postresBase(){
  const tengo = {}; S.recipes.forEach(r => { tengo[norm(r.name)] = true; });
  let n = 0;
  try {
    for (const [name, ing, prep] of POSTRES_BASE) {
      if (tengo[norm(name)]) continue;
      const e = RPT_RECETAS.estimarMacros(ing, 1);
      await db.collection('nu_recipes').add({ownerUid:wsUid(), teamEmails:wsTeam(), ownerName:S.user.displayName || (S.user.email||'').split('@')[0], createdMs:Date.now(), updatedMs:Date.now(), origen:'manual', name, servings:1, useIn:'Postre', ingredients:ing, prep, kcal:e.kcal, prot:e.prot, carb:e.carb, fat:e.grasa, weight:e.peso, category:RPT_RECETAS.categorizar(e.kcal, e.prot, e.carb, e.grasa), shared:false, sinContar:e.noReconocidos});
      n++;
    }
    await cargarRecetas();
    setRmsg(n ? 'Añadidos '+n+' postres básicos. Puedes cambiarlos o borrarlos como cualquier receta.' : 'Ya tienes todos los postres básicos.', true);
  } catch(e){ setRmsg('No se pudieron añadir ('+((e && (e.code||e.message)) || 'error')+').', false); }
  render();
}
/* ---------- Alimentos propios: foto de la etiqueta ---------- */
let _tess = null;
function cargaTesseract(){
  if (!_tess) _tess = import('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js').then(m => (m.createWorker ? m : (m.default || m)));
  return _tess;
}
function lienzoDe(img, invertir){
  const max = 2200, k = Math.min(1, max/Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth*k); c.height = Math.round(img.naturalHeight*k);
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
  for (let i = 0; i < p.length; i += 4) { let g = 0.3*p[i] + 0.59*p[i+1] + 0.11*p[i+2]; g = Math.max(0, Math.min(255, (g-128)*1.4 + 128)); if (invertir) g = 255 - g; p[i] = p[i+1] = p[i+2] = g; }
  x.putImageData(d, 0, 0); return c;
}
function dlgFotoAlim(){
  S.alimVal = null;
  abrirDlg('<h2>Añadir un alimento</h2><p class="sub" style="margin-bottom:12px">Haz una foto a la tabla nutricional de la etiqueta (la que dice «por 100 g»). La app lee los números y tú los revisas antes de guardar.</p>' +
    '<label class="btn" for="alimFoto" style="display:block;text-align:center;cursor:pointer">📷 Hacer foto o elegir imagen</label>' +
    '<input id="alimFoto" type="file" accept="image/*" capture="environment" style="display:none">' +
    '<div id="alimVista" style="margin:12px 0"></div><div class="msg" id="alimEstado"></div>' +
    '<div class="field"><label class="f" for="a_name">Cómo lo escribirás en las recetas</label><input id="a_name" placeholder="Ej.: yogur griego" autocomplete="off"></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="a_kcal">kcal por 100 g</label><input id="a_kcal" inputmode="decimal"></div><div class="field"><label class="f" for="a_prot">Proteína (g)</label><input id="a_prot" inputmode="decimal"></div></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="a_carb">Hidratos (g)</label><input id="a_carb" inputmode="decimal"></div><div class="field"><label class="f" for="a_fat">Grasa (g)</label><input id="a_fat" inputmode="decimal"></div></div>' +
    '<div class="field"><label class="f" for="a_peso">Peso de una unidad en gramos (opcional)</label><input id="a_peso" inputmode="decimal" placeholder="Ej.: 125 para un yogur"></div>' +
    '<div class="msg err" id="a_msg"></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn" data-act="guardarAlim">Guardar</button></div>');
}
async function leerFotoAlim(file){
  const est = $('#alimEstado'), vista = $('#alimVista');
  const url = URL.createObjectURL(file);
  vista.innerHTML = '<img src="'+url+'" alt="Etiqueta" style="width:100%;max-height:260px;object-fit:contain;border-radius:12px;background:#000">';
  est.className = 'msg'; est.textContent = 'Preparando la lectura… la primera vez tarda un poco más (descarga el lector).';
  try {
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    const T = await cargaTesseract();
    const w = await T.createWorker('spa');
    let mejor = null;
    for (const inv of [false, true]) {
      est.textContent = 'Leyendo la etiqueta ('+(inv ? '2' : '1')+' de 2)…';
      const r = await w.recognize(lienzoDe(img, inv)), v = RPT_RECETAS.parseEtiqueta(r.data.text || '');
      const pts = (v.cuadra ? 10 : 0) + (v.completo ? 5 : 0) + [v.kcal, v.prot, v.carb, v.fat].filter(x => x != null).length;
      if (!mejor || pts > mejor.pts) mejor = {v, pts};
      if (v.cuadra) break;
    }
    try { await w.terminate(); } catch(e){}
    const v = mejor.v, set = (id, x) => { if (x != null) $('#'+id).value = String(x).replace('.', ','); };
    set('a_kcal', v.kcal); set('a_prot', v.prot); set('a_carb', v.carb); set('a_fat', v.fat);
    const hay = [v.kcal, v.prot, v.carb, v.fat].some(x => x != null);
    if (!hay) { est.className = 'msg err'; est.textContent = 'No he podido leer los números. Escríbelos mirando la foto.'; }
    else if (v.cuadra) { est.className = 'msg ok'; est.textContent = '✓ Leído y las kcal cuadran con los macros. Compruébalo con la foto y escribe el nombre.'; }
    else { est.className = 'msg err'; est.textContent = '⚠ Revisa los números con la foto: '+(v.estimado ? 'no he podido leer una línea y la he calculado' : 'no cuadran del todo con las kcal')+'.'; }
    if (!v.por100) est.textContent += ' Comprueba que la tabla es «por 100 g».';
  } catch(e){
    console.error('ocr', e);
    est.className = 'msg err'; est.textContent = 'No he podido leer la foto automáticamente ('+((e && (e.message||e.code)) || 'error')+'). Escribe los números mirando la imagen.';
  }
}
async function guardarAlim(){
  const g = x => ($('#'+x).value || '').trim(), n = x => { const v = parseFloat(g(x).replace(',', '.')); return isFinite(v) ? v : null; };
  const name = g('a_name'), kcal = n('a_kcal'), prot = n('a_prot'), carb = n('a_carb'), fat = n('a_fat'), peso = n('a_peso');
  const err = t => { $('#a_msg').textContent = t; };
  if (!name) return err('Escribe cómo lo vas a poner en las recetas (por ejemplo «yogur griego»).');
  if ([kcal, prot, carb, fat].some(x => x === null || x < 0)) return err('Rellena kcal, proteína, hidratos y grasa por 100 g.');
  if (kcal > 900 || prot > 100 || carb > 100 || fat > 100) return err('Hay algún número demasiado grande para 100 g. Revísalo.');
  const at = 4*prot + 4*carb + 9*fat;
  if (kcal > 0 && Math.abs(kcal - at)/kcal > 0.3 && !S.alimOk) { S.alimOk = true; return err('⚠ Las kcal ('+kcal+') no cuadran con los macros (P '+prot+' · C '+carb+' · G '+fat+' dan unas '+Math.round(at)+' kcal). Revisa los números o pulsa Guardar otra vez si son correctos.'); }
  S.alimOk = false;
  try {
    await db.collection('nu_recipes').add({ownerUid:wsUid(), teamEmails:wsTeam(), ownerName:S.user.displayName || (S.user.email||'').split('@')[0], createdMs:Date.now(), tipoAlim:true, origen:'alimento', name, kcal, prot, carb, fat, weight:peso || null, shared:false});
    await cargarRecetas();
    cerrarDlg(); setRmsg('Alimento «'+name+'» guardado. Ya puedes usarlo en las recetas: «100 g '+name+'».', true); render();
  } catch(e){ err('No se pudo guardar ('+((e && (e.code||e.message)) || 'error')+').'); }
}
function dlgMisAlim(){
  const l = S.foods || [];
  abrirDlg('<h2>Mis alimentos</h2><p class="sub" style="margin-bottom:10px">Los has añadido tú (por 100 g). Sustituyen a los de la base si se llaman igual.</p>' +
    (l.length ? '<div class="list">' + l.map(f => '<div class="row"><div class="grow"><b>'+esc(f.name)+'</b><p class="sub">'+Math.round(f.kcal)+' kcal · P '+kgTxt(f.prot)+' · C '+kgTxt(f.carb)+' · G '+kgTxt(f.fat)+(f.weight ? ' · unidad '+f.weight+' g' : '')+'</p></div><button class="btn danger small" data-act="borrarAlim" data-id="'+esc(f.id)+'">Borrar</button></div>').join('') + '</div>' : '<div class="empty">Todavía no has añadido ninguno.</div>') +
    '<button class="btn secondary" style="margin-top:12px" data-act="cerrar">Cerrar</button>');
}
async function borrarAlim(id){
  try { await db.collection('nu_recipes').doc(id).delete(); await cargarRecetas(); setRmsg('Alimento borrado. Hasta que recargues la app seguirá reconocido en los cálculos.', true); }
  catch(e){ setRmsg('No se pudo borrar ('+((e && (e.code||e.message)) || 'error')+').', false); }
  dlgMisAlim(); render();
}
/* ---------- Revisión de recetas contra la base de ingredientes ---------- */
function revisaReceta(r){
  const prob = [], ing = (r.ingredients || []).filter(x => String(x).trim());
  const serv = Math.max(parseInt(r.servings, 10) || 1, 1);
  let nuevo = null;
  if (!ing.length) prob.push('No tiene lista de ingredientes: no se puede comprobar.');
  else {
    const e = RPT_RECETAS.estimarMacros(ing, serv);
    if (e.noReconocidos.length) prob.push('Ingredientes que la base no reconoce y no cuentan: '+e.noReconocidos.join(', ')+'.');
    else {
      nuevo = e;
      const d = Math.abs((r.kcal||0) - e.kcal);
      if (d > Math.max(20, 0.05*e.kcal)) prob.push('Guardada con '+Math.round(r.kcal||0)+' kcal; con la base corregida salen '+Math.round(e.kcal)+' kcal por ración.');
    }
  }
  if (recetaIncoherente(r)) prob.push('Las kcal no cuadran con los macros (P '+r1(r.prot||0)+' · C '+r1(r.carb||0)+' · G '+r1(r.fat||0)+' dan unas '+Math.round(kcalMacros(r))+' kcal).');
  const kc = (nuevo ? nuevo.kcal : r.kcal) || 0;
  if (kc > 0 && kc < 30) prob.push('Solo '+Math.round(kc)+' kcal por ración: ¿falta algún ingrediente o están mal las raciones ('+serv+')?');
  if (kc > 1500) prob.push(Math.round(kc)+' kcal por ración es mucho: ¿están bien las raciones ('+serv+')?');
  return {r, prob, nuevo, cambia: !!(nuevo && Math.abs((r.kcal||0) - nuevo.kcal) > Math.max(20, 0.05*nuevo.kcal))};
}
function dlgRevision(){
  const res = S.recipes.map(revisaReceta), cuenta = {};
  S.recipes.forEach(r => { const k = norm(r.name); cuenta[k] = (cuenta[k] || 0) + 1; });
  res.forEach(x => { if (cuenta[norm(x.r.name)] > 1) x.prob.push('Está repetida ('+cuenta[norm(x.r.name)]+' recetas con este nombre). Borra las que sobren.'); });
  const malas = res.filter(x => x.prob.length), cambian = res.filter(x => x.cambia && x.nuevo);
  S.revCambian = cambian.map(x => x.r.id);
  abrirDlg('<h2>Revisar recetas</h2><p class="sub" style="margin-bottom:10px">Compara cada receta con la base de ingredientes (ya corregida). Revisadas: <b>'+res.length+'</b> · con avisos: <b>'+malas.length+'</b>.</p>' +
    (cambian.length ? '<button class="btn" style="margin-bottom:12px" data-act="recalcularTodas">🔄 Recalcular las '+cambian.length+' recetas que cambian</button>' : '<div class="msg ok">✓ Los macros guardados coinciden con la base.</div>') +
    (malas.length ? '<div class="list">' + malas.slice(0, 60).map(x => '<button class="row" data-act="editarReceta" data-id="'+esc(x.r.id)+'"><div class="grow"><b>'+esc(x.r.name)+'</b>' + x.prob.map(p => '<p class="sub" style="color:var(--t-chg-fg)">⚠ '+esc(p)+'</p>').join('') + '</div><span class="chev">›</span></button>').join('') + '</div>' + (malas.length > 60 ? '<p class="sub">…y '+(malas.length-60)+' más.</p>' : '') : '') +
    '<p class="sub" style="margin-top:10px">«Recalcular» sustituye los kcal y macros guardados por los calculados desde los ingredientes, y solo toca recetas con todos los ingredientes reconocidos. Las demás las corriges tú con el botón de cada una.</p>' +
    '<button class="btn secondary" style="margin-top:10px" data-act="cerrar">Cerrar</button>');
}
async function recalcularTodas(){
  const ids = S.revCambian || [], b = db.batch ? null : null; let n = 0;
  try {
    for (const id of ids) {
      const r = recetaPorId(id); if (!r) continue;
      const x = revisaReceta(r); if (!x.nuevo) continue;
      const e = x.nuevo;
      await db.collection('nu_recipes').doc(id).update({kcal:e.kcal, prot:e.prot, carb:e.carb, fat:e.grasa, weight:e.peso || r.weight || 0, category:RPT_RECETAS.categorizar(e.kcal, e.prot, e.carb, e.grasa), sinContar:[], updatedMs:Date.now()});
      n++;
    }
    await cargarRecetas();
    setRmsg('Recalculadas '+n+' recetas con la base de ingredientes corregida.', true);
    cerrarDlg(); render(); dlgRevision();
  } catch(e){ setRmsg('No se pudo recalcular ('+((e && (e.code||e.message)) || 'error')+').', false); render(); }
}
async function compartirReceta(id){
  const r = recetaPorId(id); if (!r) return;
  try { await db.collection('nu_recipes').doc(id).update({shared:!r.shared}); await cargarRecetas(); }
  catch(e){ $('#r_msg').textContent = 'No se pudo cambiar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  dlgVerReceta(id); render();
}
async function copiarReceta(id){
  const r = recetaPorId(id); if (!r) return;
  const c = Object.assign({}, r); delete c.id;
  Object.assign(c, {ownerUid:wsUid(), teamEmails:wsTeam(), ownerName:S.user.displayName || (S.user.email||'').split('@')[0], shared:false, origen:'manual', copiedFrom:r.ownerUid, createdMs:Date.now(), updatedMs:Date.now()});
  try { await db.collection('nu_recipes').add(c); await cargarRecetas(); }
  catch(e){ $('#r_msg').textContent = 'No se pudo copiar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  cerrarDlg(); S.rtab = 'mias'; setRmsg('Copiada a tus recetas.', true); render();
}
const grupoDe = r => r.origen === 'importada' ? 'importada' : r.origen === 'manual' ? 'manual' : 'antigua';
const GRUPOS = {importada:'importadas de Word', manual:'creadas a mano', antigua:'anteriores (sin clasificar)', todas:'todas'};
const recetasDeGrupo = g => g === 'todas' ? S.recipes : S.recipes.filter(r => grupoDe(r) === g);
function dlgBorrarTodas(){
  if (!S.recipes.length) return;
  const fila = g => { const n = recetasDeGrupo(g).length; return n ? '<button class="row" data-act="borrarGrupoDlg" data-g="'+g+'"><div class="grow"><b>Eliminar las '+GRUPOS[g]+'</b><p class="sub">'+n+' receta'+(n>1?'s':'')+'</p></div><span class="chev">›</span></button>' : ''; };
  abrirDlg('<h2>Eliminar recetas</h2><p class="sub" style="font-size:18px;margin-bottom:12px">Elige qué grupo quieres borrar. Cada grupo se borra por separado. Las recetas compartidas por otras personas no se tocan.</p>' +
    '<div class="list">'+fila('importada')+fila('manual')+fila('antigua')+'</div>' +
    '<p class="sub" style="margin:10px 0">«Anteriores» son las que se guardaron antes de existir esta distinción: no se sabe si vinieron de Word o se crearon a mano.</p>' +
    '<div class="list">'+fila('todas')+'</div><button class="btn ghost" style="margin-top:12px" data-act="cerrar">Cancelar</button>');
}
function dlgBorrarGrupo(g){
  const n = recetasDeGrupo(g).length; if (!n) return;
  abrirDlg('<h2>Eliminar las recetas '+GRUPOS[g]+'</h2>' +
    '<p class="sub" style="font-size:18px;margin-bottom:12px">Se eliminarán <b>'+n+'</b> receta'+(n>1?'s':'')+'. No se pueden recuperar.</p>' +
    '<p class="sub" style="font-size:18px;margin-bottom:12px">Los menús ya generados conservan sus platos tal como estaban. Para que cambien, hay que volver a generar el menú.</p>' +
    '<div class="msg err" id="bt_msg"></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn danger" data-act="borrarTodasOk" data-g="'+g+'">Sí, eliminar '+n+'</button></div>');
}
async function borrarTodasOk(btn){
  const g = btn.dataset.g || 'todas';
  btn.disabled = true; btn.textContent = 'Eliminando…';
  try {
    const ids = recetasDeGrupo(g).map(r => r.id);
    for (let i = 0; i < ids.length; i += 400) {
      const b = db.batch(); ids.slice(i, i+400).forEach(id => b.delete(db.collection('nu_recipes').doc(id))); await b.commit();
    }
    await cargarRecetas();
  } catch(e){ const m = $('#bt_msg'); if (m) m.textContent = 'No se pudo eliminar ('+((e && (e.code||e.message)) || 'error')+').'; btn.disabled = false; btn.textContent = 'Reintentar'; return; }
  cerrarDlg(); setRmsg('Recetas '+GRUPOS[g]+' eliminadas.', true); render();
}
async function borrarReceta(id, btn){
  if (!btn.dataset.seguro) { btn.dataset.seguro = '1'; btn.textContent = '¿Seguro? Pulsa otra vez para eliminar'; return; }
  try { await db.collection('nu_recipes').doc(id).delete(); await cargarRecetas(); }
  catch(e){ $('#r_msg').textContent = 'No se pudo eliminar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  cerrarDlg(); setRmsg('Receta eliminada.', true); render();
}

/* ---------- horas de competición ---------- */
function dlgComp(key, aviso){
  const p = pacienteActual(); if (!p) return;
  const c = key ? compsDe(p).find(x => x.key === key) : null;
  const nueva = !key;
  abrirDlg('<h2>'+(nueva ? 'Competición a mano' : esc(c.name))+'</h2>' +
    (aviso ? '<div class="notice" style="margin-bottom:12px">🏆 Hay una competición próxima. ¿Ya tienes las horas?</div>' : '') +
    (c ? '<p class="sub" style="margin-bottom:12px">'+fechaCorta(c.date)+(c.category ? ' · '+esc(c.category) : '')+'</p>' : '') +
    (nueva ? '<div class="field"><label class="f" for="c_name">Nombre</label><input id="c_name" autocomplete="off"></div><div class="field"><label class="f" for="c_date">Fecha</label><input id="c_date" type="date"></div>' : '') +
    '<div class="grid2"><div class="field"><label class="f" for="c_w">Hora del pesaje</label><input id="c_w" type="time" value="'+esc(c ? c.weighIn : '')+'"></div>' +
    '<div class="field"><label class="f" for="c_s">Hora de inicio</label><input id="c_s" type="time" value="'+esc(c ? c.start : '')+'"></div></div>' +
    '<div class="msg err" id="c_msg"></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrar">'+(aviso ? 'Más tarde' : 'Cancelar')+'</button><button class="btn" data-act="guardarComp" data-k="'+esc(key||'')+'">Guardar</button></div>' +
    (c && c.manual ? '<button class="btn danger" style="margin-top:10px" data-act="quitarComp" data-k="'+esc(key)+'">Quitar competición</button>' : ''));
}
async function guardarComp(key){
  const p = pacienteActual(); if (!p) return;
  const datos = Object.assign({}, p.compData || {});
  const w = $('#c_w').value || '', st = $('#c_s').value || '';
  if (!key) {
    const name = ($('#c_name').value || '').trim(), date = $('#c_date').value;
    if (!name || !date) { $('#c_msg').textContent = 'Escribe el nombre y la fecha.'; return; }
    key = 'm'+Date.now();
    datos[key] = {manual:true, name, date, weighIn:w, start:st};
  } else datos[key] = Object.assign({}, datos[key] || {}, {weighIn:w, start:st});
  try { await refPac(p.id).update({compData:datos}); p.compData = datos; cerrarDlg(); }
  catch(e){ $('#c_msg').textContent = 'No se pudo guardar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  render();
}
async function quitarComp(key){
  const p = pacienteActual(); if (!p) return;
  const datos = Object.assign({}, p.compData || {}); delete datos[key];
  try { await refPac(p.id).update({compData:datos}); p.compData = datos; cerrarDlg(); } catch(e){ $('#c_msg').textContent = 'No se pudo quitar.'; return; }
  render();
}
// Al abrir un usuario: si tiene una competición en los próximos 45 días sin horas, pregunta una vez.
function preguntarHoras(p){
  S.preguntadas = S.preguntadas || {};
  const limite = sumaDias(iso(new Date()), 45);
  const c = compsProximas(p).find(x => x.date <= limite && (!x.weighIn || !x.start) && !S.preguntadas[p.id+'|'+x.key]);
  if (!c) return;
  S.preguntadas[p.id+'|'+c.key] = true; dlgComp(c.key, true);
}

/* ---------- acciones de vínculo ---------- */
function dlgVinculo(){
  abrirDlg('<h2>Vincular con WorkOut</h2><p class="sub" style="margin-bottom:14px">Escribe el correo con el que el usuario entra en WorkOut. Recibirá una solicitud al entrar en esta app y decidirá si la acepta.</p>' +
    '<div class="field"><label class="f" for="v_email">Correo del usuario</label><input id="v_email" type="email" inputmode="email" autocomplete="off"></div>' +
    '<div class="msg err" id="v_msg"></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn" data-act="guardarVinculo">Enviar solicitud</button></div>');
}
async function guardarVinculo(){
  const email = ($('#v_email').value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $('#v_msg').textContent = 'Escribe un correo válido.'; return; }
  try {
    const viejos = S.links.filter(l => l.patientId === S.pid);
    for (const l of viejos) await db.collection('nu_links').doc(l.id).delete();
    await db.collection('nu_links').add({ownerUid:S.user.uid, patientId:S.pid, email, status:'pending',
      nutriName:S.user.displayName || (S.user.email||'').split('@')[0], createdMs:Date.now()});
    cerrarDlg(); await cargarLinks();
  } catch(e){ $('#v_msg').textContent = 'No se pudo enviar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  render();
}
async function quitarVinculo(id){
  try { await db.collection('nu_links').doc(id).delete(); delete S.wo[S.pid]; await cargarLinks(); await cargarPesos(); }
  catch(e){ setMsg('No se pudo quitar ('+((e && (e.code||e.message)) || 'error')+').', false); }
  render();
}
async function aceptar(id){
  const l = S.requests.find(x => x.id === id); if (!l) return;
  try {
    const g = await db.collection('users').doc(S.user.uid).collection('roleGrants').doc('athlete').get();
    const clubId = g.exists ? (g.data().clubId || null) : null;
    await db.collection('users').doc(S.user.uid).collection('shares').doc(l.ownerUid).set({active:true, canWriteWeight:true, clubId, at:firebase.firestore.FieldValue.serverTimestamp()});
    await db.collection('nu_links').doc(id).update({status:'accepted', patientUid:S.user.uid, clubId, acceptedAt:Date.now()});
    await cargarSolicitudes(); setMsg(null);
  } catch(e){ setMsg('No se pudo aceptar ('+((e && (e.code||e.message)) || 'error')+').', false); console.error('aceptar', e); }
  render();
}
async function rechazar(id){
  try { await db.collection('nu_links').doc(id).update({status:'rejected'}); await cargarSolicitudes(); }
  catch(e){ setMsg('No se pudo rechazar ('+((e && (e.code||e.message)) || 'error')+').', false); }
  render();
}
async function retirar(id){
  const l = S.requests.find(x => x.id === id); if (!l) return;
  try {
    await db.collection('users').doc(S.user.uid).collection('shares').doc(l.ownerUid).delete();
    await db.collection('nu_links').doc(id).update({status:'revoked'});
    await cargarSolicitudes();
  } catch(e){ setMsg('No se pudo retirar ('+((e && (e.code||e.message)) || 'error')+').', false); }
  render();
}
async function proponer(){
  const w = S.wo[S.pid]; if (!w) return;
  const sel = ($('#woplan') && $('#woplan').value) || S.woPlanId || (w.plans[0] && w.plans[0].id);
  S.woPlanId = sel;
  const plan = w.plans.find(x => x.id === sel); if (!plan) return;
  const lv = nivelesDePlan(planConMovimientos(plan, w.moves));
  compsDeLaSemana(S.pid).forEach(x => { const i = Math.round((new Date(x.d+'T00:00') - new Date(S.weekStart+'T00:00'))/86400000); if (i >= 0 && i < 7) lv[i] = 4; });
  S.levels = lv; setMsg('Niveles propuestos desde '+nombrePlan(plan)+'. Corrígelos si hace falta.', true); render();
  try { await refPac(S.pid).collection('weeks').doc(S.weekStart).set({levels:lv, source:'workout:'+sel, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}, {merge:true}); }
  catch(e){ setMsg('No se pudo guardar la semana ('+((e && (e.code||e.message)) || 'error')+').', false); render(); }
}

/* ---------- cuenta ---------- */
function traducirError(e){
  const c = (e && e.code) || '';
  if (c.includes('invalid-email')) return 'El correo no es válido.';
  if (c.includes('wrong-password') || c.includes('invalid-credential') || c.includes('user-not-found')) return 'Correo o contraseña incorrectos.';
  if (c.includes('email-already-in-use')) return 'Ese correo ya tiene cuenta. Pulsa "Entrar" (si ya usas WorkOut, es la misma cuenta).';
  if (c.includes('weak-password')) return 'La contraseña debe tener al menos 6 caracteres.';
  if (c.includes('too-many-requests')) return 'Demasiados intentos. Espera un momento.';
  if (c.includes('network')) return 'Sin conexión.';
  return 'No se pudo completar. Inténtalo de nuevo.';
}
async function entrar(crear){
  const em = ($('#em').value||'').trim(), pw = $('#pw').value||'';
  if (!em || !pw){ setMsg('Escribe correo y contraseña.', false); render(); return; }
  try { crear ? await auth.createUserWithEmailAndPassword(em, pw) : await auth.signInWithEmailAndPassword(em, pw); }
  catch(e){ setMsg(traducirError(e), false); render(); const a=$('#em'); if(a) a.value=em; }
}
async function olvido(){
  const em = ($('#em').value||'').trim();
  if (!em){ setMsg('Escribe tu correo arriba y vuelve a pulsar.', false); render(); return; }
  try { await auth.sendPasswordResetEmail(em); setMsg('Te hemos enviado un correo para cambiar la contraseña.', true); }
  catch(e){ setMsg(traducirError(e), false); }
  render(); const a=$('#em'); if(a) a.value=em;
}
async function activar(){
  try {
    await db.collection('users').doc(S.user.uid).collection('roleGrants').doc('nutritionist').set({createdAt:firebase.firestore.FieldValue.serverTimestamp()});
    S.isNutri = true; try { await cargarRecetas(); } catch(e){} await cargarPacientes(); S.links = []; S.view = 'app'; S.tab = 'pacientes'; setMsg(null);
  } catch(e){ setMsg('No se pudo activar. Puede faltar publicar las reglas nuevas en Firebase.', false); }
  render();
}
function recargar(){
  try { const u = new URL(location.href); u.searchParams.set('r', Date.now()); location.replace(u.toString()); }
  catch(e){ location.reload(); }
}

/* ---------- eventos ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) { if (e.target.id === 'dlg') cerrarDlg(); return; }
  const a = t.dataset.act;
  if (t.tagName === 'A') e.preventDefault();
  switch (a) {
    case 'entrar': entrar(false); break;
    case 'crear': entrar(true); break;
    case 'olvido': olvido(); break;
    case 'activar': activar(); break;
    case 'salir': auth.signOut(); break;
    case 'tab': S.tab = t.dataset.v; if (S.tab === 'pacientes') { S.pid = null; } setMsg(null); if (window.innerWidth < 900) S.side = false; render(); break;
    case 'side': S.side = !S.side; try { if (window.innerWidth >= 900) localStorage.setItem('nu_side', S.side ? '1' : '0'); } catch(e){} render(); break;
    case 'sideDatos': S.tab = 'pacientes'; S.ptab = 'datos'; setMsg(null); if (window.innerWidth < 900) S.side = false; render(); break;
    case 'pesoDlg': dlgPeso(); break;
    case 'medidasDlg': dlgMedidas(); break;
    case 'guardarMedidas': guardarMedidas(); break;
    case 'calAbrir': window.open(urlCalendar(t.dataset.t, pacienteActual() || {}), '_blank'); break;
    case 'calIcs': descargarIcs(t.dataset.t, pacienteActual() || {}); break;
    case 'calCopiar': { const u = urlCalendar(t.dataset.t, pacienteActual() || {}); (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(() => { setMsg('Enlace copiado. Envíaselo al atleta: al abrirlo, guarda el evento en su calendario.', true); render(); }).catch(() => { setMsg('No se pudo copiar. Usa «Añadir a Google Calendar» o «Descargar .ics».', false); render(); }); break; }
    case 'compraAbrir': S.compraOn = true; S.ptab = 'compra'; render(); window.scrollTo(0, 0); break;
    case 'compraCerrar': S.compraOn = false; S.ptab = 'informe'; render(); break;
    case 'abrir': abrirPaciente(t.dataset.id); break;
    case 'volver': S.pid = null; S.tab = 'pacientes'; setMsg(null); render(); break;
    case 'nuevo': dlgPaciente(null); break;
    case 'editar': dlgPaciente(pacienteActual()); break;
    case 'guardarPaciente': guardarPaciente(t.dataset.id); break;
    case 'cerrar': cerrarDlg(); break;
    case 'borrar': borrarPaciente(); break;
    case 'borrarSeguro': borrarSeguro(); break;
    case 'guardarNotas': guardarNotas(); break;
    case 'pdfAbrir': { const n = $('#notas'); if (n && n.value !== (S.notas || '')) { S.notas = n.value; guardarNotas(); } S.pdf = true; render(); window.scrollTo(0, 0); break; }
    case 'pdfCerrar': S.pdf = false; render(); break;
    case 'pdfImprimir': window.print(); break;
    case 'chkCompra': toggleCompra(t.dataset.k); break;
    case 'ptab': S.ptab = t.dataset.v; setMsg(null); S.tab = 'pacientes'; render(); window.scrollTo(0, 0); break;
    case 'guardarPeso': guardarPeso(); break;
    case 'nivel': ponerNivel(parseInt(t.dataset.d,10), parseInt(t.dataset.l,10)); break;
    case 'semana': cambiarSemana(parseInt(t.dataset.n,10)); break;
    case 'recargar': recargar(); break;
    case 'vincular': dlgVinculo(); break;
    case 'realDlg': S.realQ = ''; S.realModo = 'sim'; dlgReal(); break;
    case 'elegirReal': { const r = recetaPorId(t.dataset.id); if (r) { const m0 = S.menu[S.slot.d].meals[S.slot.m], plan = valsComida(m0);
        const sc = Math.round(clamp(plan.kcal/Math.max(r.kcal,1), 0.3, 3)*20)/20;
        cambiarSlot(m => { delete m.estado; m.real = comidaDe(r, m.slot, sc); }, false, null, dlgComida); } break; }
    case 'noComi': cambiarSlot(m => { m.real = {none:true}; }, false, null, dlgComida); break;
    case 'quitarReal': cambiarSlot(m => { delete m.real; }, false, null, dlgComida); break;
    case 'escalaReal': cambiarSlot(m => { if (m.real && !m.real.none) m.real.s = Math.round(clamp(m.real.s + parseFloat(t.dataset.n), 0.3, 3)*20)/20; }, false, null, dlgComida); break;
    case 'proponerMenu':
      if (S.menu && S.menu.some(d => d.meals && d.meals.some(m => m.rid)) && !t.dataset.seguro) { t.dataset.seguro = '1'; t.textContent = '⚠ Pulsa otra vez: se sustituye el menú'; break; }
      { const pp = pacienteActual();
        if (pp && !pp.menuMode && S.patients.some(x => x.id !== pp.id && x.menuMode !== 'copia')) { S.trasModo = true; dlgModoMenu(); break; }
        if (esCopia(pp)) { copiarDeUsuario(); break; }
        proponerMenu(); break; }
    case 'modoMenuDlg': S.trasModo = false; dlgModoMenu(); break;
    case 'modoMenuElegir': elegirModoMenu(t.dataset.v, t.dataset.id); break;
    case 'copiarSemana': dlgCopiarSemana(); break;
    case 'copiarDe': copiarDe(t.dataset.w); break;
    case 'repartoDlg': dlgReparto(); break;
    case 'fijasDlg': dlgFijas(); break;
    case 'guardarFijas': guardarFijas(t.dataset.todos === '1'); break;
    case 'guardarReparto': guardarReparto(); break;
    case 'slotMenu': S.slotQ = ''; S.slotModo = 'sim'; S.slot = {d:parseInt(t.dataset.d,10), m:parseInt(t.dataset.m,10)}; dlgSlot(); break;
    case 'escalaSlot': cambiarSlot(m => { m.s = Math.round(clamp(m.s + parseFloat(t.dataset.n), 0.3, 3)*20)/20; }); break;
    case 'quitarSlot': if (S.menu[S.slot.d].meals[S.slot.m].extra) quitarExtra(); else cambiarSlot(m => { m.rid = null; delete m.name; }, true, 'Comida quitada.'); break;
    case 'addExtra': addExtra(parseInt(t.dataset.d, 10)); break;
    case 'elegirReceta': { const r = recetaPorId(t.dataset.id); if (r) { const p = pacienteActual(); const sl = S.slot; const m0 = S.menu[sl.d].meals[sl.m];
        const pct = (repartoDe(p).find(x => x[0] === m0.slot) || [0,0])[1], obj = objetivoDia(p, sl.d);
        const s = obj && !m0.extra ? escalaPara(r, {kcal:obj.kcal*pct/100}) : 1;
        cambiarSlot(m => Object.assign(m, comidaDe(r, m.slot, s), {fija:false}), true, DIAS[sl.d]+' · '+m0.slot+': cambiado a '+r.name+'.'); } break; }
    case 'buscarSolic': cargarSolicitudes().then(render); break;
    case 'eqDlg': S.eqSel = null; S.eqProp = null; if (t.dataset.d !== undefined && t.dataset.d !== '') { const dd = parseInt(t.dataset.d, 10); S.eqSel = null; } dlgEquilibrio(); break;
    case 'eqCalc': eqCalc(); break;
    case 'eqAplicar': eqAplicar(); break;
    case 'claudeSemana': claudeSemana(); break;
    case 'realLibre': realLibre(); break;
    case 'diaMenu': setMsg(null); S.mdia = t.dataset.d === '' ? null : t.dataset.d === 'semana' ? 'semana' : parseInt(t.dataset.d, 10); render(); window.scrollTo(0, 0); break;
    case 'comidaNav': { const sl = S.slot, n = S.menu[sl.d].meals.length, k = sl.m + parseInt(t.dataset.n, 10); if (k >= 0 && k < n) { S.slot = {d:sl.d, m:k}; dlgComida(); } break; }
    case 'comidaDlg': S.slot = {d:parseInt(t.dataset.d,10), m:parseInt(t.dataset.m,10)}; dlgComida(); break;
    case 'marcaHecho': marcarComida(m => { m.estado = 'hecho'; delete m.real; }, 'Comida marcada como hecha.'); break;
    case 'marcaNo': marcarComida(m => { delete m.estado; m.real = {none:true}; }, 'Comida marcada como no hecha.'); break;
    case 'marcaPend': marcarComida(m => { delete m.estado; delete m.real; }, 'Comida otra vez pendiente.'); break;
    case 'addCompl': addComplemento(parseInt(t.dataset.d, 10), t.dataset.n, parseInt(t.dataset.g, 10)); break;
    case 'equipoAnadir': equipoCambiar($('#eq_mail') ? $('#eq_mail').value : '', true); break;
    case 'equipoQuitar': equipoCambiar(t.dataset.e, false); break;
    case 'rgrp': S.rgrp = t.dataset.v; render(); break;
    case 'rtab': S.rtab = t.dataset.v; setRmsg(null); render(); break;
    case 'verReceta': dlgVerReceta(t.dataset.id); break;
    case 'revisarRec': dlgRevision(); break;
    case 'recalcularTodas': recalcularTodas(); break;
    case 'fotoAlim': dlgFotoAlim(); break;
    case 'misAlim': dlgMisAlim(); break;
    case 'guardarAlim': guardarAlim(); break;
    case 'borrarAlim': borrarAlim(t.dataset.id); break;
    case 'slotModo': S.slotModo = t.dataset.n; S.slotQ = ''; S.slotAll = false; dlgSlot(); break;
    case 'realModo': S.realModo = t.dataset.n; S.realQ = ''; dlgReal(); break;
    case 'slotTodas': S.slotAll = true; dlgSlot(); break;
    case 'platosFuera': platosFuera(); break;
    case 'postresBase': postresBase(); break;
    case 'postreDia': addPostres(parseInt(t.dataset.d, 10)); break;
    case 'nuevaReceta': S.cola = []; dlgFormReceta(null, 0); break;
    case 'importarWord': { const i = $('#docxIn'); if (i) i.click(); break; }
    case 'editarReceta': S.cola = []; dlgFormReceta(recetaPorId(t.dataset.id), 0); break;
    case 'calcReceta': calcReceta(); break;
    case 'guardarReceta': guardarReceta(t.dataset.id); break;
    case 'recetaDesdeSlot': S.slotPend = S.slot; S.cola = []; dlgFormReceta(null, 0); break;
    case 'cerrarReceta': S.slotPend = null; if (S.cola.length) siguienteDeCola(); else cerrarDlg(); break;
    case 'compartirReceta': compartirReceta(t.dataset.id); break;
    case 'copiarReceta': copiarReceta(t.dataset.id); break;
    case 'borrarReceta': borrarReceta(t.dataset.id, t); break;
    case 'borrarTodasDlg': dlgBorrarTodas(); break;
    case 'borrarGrupoDlg': dlgBorrarGrupo(t.dataset.g); break;
    case 'borrarTodasOk': borrarTodasOk(t); break;
    case 'horasComp': dlgComp(t.dataset.k || ''); break;
    case 'guardarComp': guardarComp(t.dataset.k || ''); break;
    case 'quitarComp': quitarComp(t.dataset.k); break;
    case 'guardarVinculo': guardarVinculo(); break;
    case 'quitarVinculo': quitarVinculo(t.dataset.id); break;
    case 'aceptar': aceptar(t.dataset.id); break;
    case 'rechazar': rechazar(t.dataset.id); break;
    case 'retirar': retirar(t.dataset.id); break;
    case 'leerwo': leerWorkOut(S.pid).then(() => cargarPesos()).then(render); break;
    case 'proponer': proponer(); break;
  }
});
document.addEventListener('input', e => {
  if (e.target && e.target.dataset && e.target.dataset.filtra) { filtraSelect(e.target); return; }
  if (e.target && e.target.id === 'rq2') { S.realQ = e.target.value; if (S.realQ) S.realModo = 'libre'; dlgReal(); const n = $('#rq2'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } return; }
  if (e.target && e.target.id === 'sq') { S.slotQ = e.target.value; if (S.slotQ) S.slotModo = 'libre'; dlgSlot(); const n = $('#sq'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } return; } if (e.target && e.target.id === 'rq') { S.rq = e.target.value; render(); } });
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'd_tsel') { const w = document.getElementById('d_tdwrap'); if (w) w.style.display = e.target.value === 'otra' ? '' : 'none'; }
  if (e.target && e.target.classList && e.target.classList.contains('uso-ck')) { const r = $('#r_usoRes'); if (r) r.firstChild.textContent = usoResumen(); return; }
  if (e.target && e.target.id === 'r_base') {
    const o = recetaPorId(e.target.value); if (!o) return;
    const put = (id, v) => { const el = $('#'+id); if (el) el.value = v; };
    put('r_name', (o.name||'') + ' (copia)'); put('r_serv', o.servings||4); usoPoner(o.useIn || 'Almuerzo, Cena');
    put('r_ing', (o.ingredients||[]).join('\n')); put('r_prep', o.prep||'');
    put('r_kcal', o.kcal||0); put('r_w', o.weight||0); put('r_p', kgTxt(o.prot||0)); put('r_c', kgTxt(o.carb||0)); put('r_g', kgTxt(o.fat||0));
    const m = $('#r_msg'); if (m) { m.className = 'msg ok'; m.textContent = 'Copiada de «'+o.name+'». Cambia lo que quieras y guarda.'; }
    return;
  }
  if (e.target && e.target.id === 'alimFoto' && e.target.files.length) { leerFotoAlim(e.target.files[0]); e.target.value = ''; return; }
  if (e.target && e.target.id === 'docxIn' && e.target.files.length) { importarDocx(e.target.files); e.target.value = ''; return; } if (e.target && e.target.id === 'woplan') S.woPlanId = e.target.value; });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && S.view === 'login' && e.target.id === 'pw') entrar(false); });

/* ---------- aviso de versión nueva ---------- */
function comprobarVersion(){
  if (!window.fetch) return;
  fetch('version.json?t=' + Date.now(), {cache:'no-store'}).then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d.v || d.v === window.RPT_VERSION || document.getElementById('avisoVersion')) return;
    const b = document.createElement('div'); b.id = 'avisoVersion';
    b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:50;background:var(--t-surface);color:var(--t-text);border:1px solid var(--t-line);border-radius:16px;padding:14px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);font:600 17px/1.3 Archivo,system-ui,sans-serif;max-width:560px;margin:0 auto;';
    b.innerHTML = '<span style="flex:1">✨ Hay una versión nueva</span><button class="btn small" id="avisoBtn">Actualizar</button>';
    document.body.appendChild(b); $('#avisoBtn').onclick = recargar;
  }).catch(() => {});
}
window.addEventListener('load', () => setTimeout(comprobarVersion, 3000));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') comprobarVersion(); });

/* ---------- arranque ---------- */
auth.onAuthStateChanged(async u => {
  S.user = u; S.pid = null; setMsg(null);
  if (!u) { S.isNutri = false; S.view = 'login'; render(); return; }
  S.view = 'boot'; render();
  try {
    // Ficha básica (nombre/correo); si ya existe por WorkOut no se toca.
    const ur = db.collection('users').doc(u.uid);
    const pGrant = ur.collection('roleGrants').doc('nutritionist').get();
    const pSol = cargarSolicitudes().catch(() => { S.requests = []; });
    const ud = await ur.get();
    S.prefs = (ud.exists && ud.data().nuPrefs) || {}; S.team = (ud.exists && Array.isArray(ud.data().nuTeam)) ? ud.data().nuTeam : []; S.wsOwner = null; S.wsTeamList = null;
    if (!ud.exists) await ur.set({email:u.email, name:u.displayName || (u.email||'').split('@')[0], createdAt:Date.now()});
    const g = await pGrant;
    S.isNutri = g.exists;
    await pSol;
    if (S.isNutri) {
      // Todo a la vez (antes iba una consulta detrás de otra).
      await Promise.all([cargarPacientes(), cargarRecetas().catch(e => { S.recipes = []; S.foods = []; S.sharedRecipes = []; console.error('recetas', e); }), cargarLinks().catch(() => { S.links = []; })]);
      filtraCompartidas(); S.view = 'app'; S.tab = 'pacientes'; }
    else S.view = 'activar';
  } catch(e){ S.view = 'activar'; setMsg('No se pudieron leer tus datos. Comprueba la conexión.', false); }
  render();
});
render();
})();
