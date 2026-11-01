/* RPT Nutrición — app del nutricionista (y del paciente, en una fase posterior).
   Mismo Firebase y misma cuenta que WorkOut 2.0, pero datos propios:
     nu_patients/{pid}                  ficha del paciente (la crea el nutricionista a mano)
     nu_patients/{pid}/weights/{día}    peso (un registro por día)
     nu_patients/{pid}/weeks/{lunes}    intensidad de entreno de la semana (4 niveles)
   El permiso de nutricionista es users/{uid}/roleGrants/nutritionist. */
(function(){
'use strict';

const NIVELES = ['Descanso','Baja','Media','Alta'];
const DIAS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
const $ = s => document.querySelector(s);
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
  tab:'pacientes',        // pacientes | recetario | cuenta
  patients:[], pid:null, ptab:'menu', side:false, compraOn:false, menuBase:null,
  weights:[], weekStart:lunesISO(new Date()), levels:null,
  links:[], requests:[], wo:{}, woPlanId:null, woMsg:null,
  recipes:[], sharedRecipes:[], rtab:'mias', rq:'', cola:[], rmsg:null,
  menu:null, slot:null, prefs:{},
  msg:null, msgOk:false, busy:false
};
const refPac = pid => db.collection('nu_patients').doc(pid);
try { S.side = window.innerWidth >= 900 && localStorage.getItem('nu_side') !== '0'; } catch(e){ S.side = window.innerWidth >= 900; }
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
/* Menú lateral: lo que son datos de base (paciente, recetario, cuenta). Se puede ocultar. */
function sideHtml(){
  if (S.view !== 'app') return '';
  const p = S.pid ? pacienteActual() : null;
  const it = (act, v, ico, txt, cur) => '<button class="sitem" data-act="'+act+'" data-v="'+v+'"'+(cur ? ' aria-current="page"' : '')+'><span class="ico">'+ico+'</span><span>'+txt+'</span></button>';
  return '<div class="sidebk" data-act="side"></div><aside class="side'+(S.side ? ' open' : '')+'" aria-label="Menú">' +
    '<div class="sidehead"><b>Menú</b><button class="btn small secondary" data-act="side" aria-label="Cerrar el menú">✕</button></div>' +
    it('tab', 'pacientes', '👥', 'Pacientes', S.tab === 'pacientes' && !(p && S.ptab === 'datos')) +
    (p ? '<div class="sgroup">Paciente: '+esc(p.name)+'</div>' + it('sideDatos', 'datos', '📋', 'Datos, peso y WorkOut', S.tab === 'pacientes' && S.ptab === 'datos') : '') +
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
    '<h1>Bienvenido</h1>' + solicitudesHtml() +
    '<div class="card"><h3>Soy nutricionista</h3><p class="sub" style="margin-bottom:14px">Podrás crear tus pacientes, marcar su semana de entreno y preparar sus menús.</p>' +
    '<button class="btn" data-act="activar">Activar modo nutricionista</button></div>' +
    '<div class="card"><h3>Soy paciente</h3><p class="sub">Tu nutricionista te dará acceso con tu correo. Cuando lo haga, tu menú aparecerá aquí.</p></div>' +
    msgHtml() +
    '<button class="btn secondary" data-act="salir">Salir</button></div></div>';
}
function vPacientes(){
  const lista = S.patients.length
    ? '<div class="list">' + S.patients.map(p =>
        '<button class="row" data-act="abrir" data-id="'+esc(p.id)+'"><div class="avatar">'+esc((p.name||'?').trim().charAt(0).toUpperCase())+'</div>' +
        '<div class="grow"><b>'+esc(p.name)+'</b><p class="sub">'+esc([p.sex, p.heightCm ? p.heightCm+' cm' : '', p.goal].filter(Boolean).join(' · ') || 'Sin más datos')+'</p></div><span class="chev">›</span></button>').join('') + '</div>'
    : '<div class="empty">Todavía no tienes pacientes.<br>Crea el primero con el botón de abajo.</div>';
  return '<div class="crumbs"><b>Pacientes</b></div><div class="content"><h1>Pacientes</h1>'+solicitudesHtml()+lista+
    '<button class="btn" data-act="nuevo">＋ Nuevo paciente</button></div>';
}
function vPaciente(){
  const p = pacienteActual();
  if (!p) return '<div class="content"><div class="empty">Paciente no encontrado.</div></div>';
  const t = (v, txt) => '<button role="tab" data-act="ptab" data-v="'+v+'" aria-selected="'+(S.ptab===v)+'">'+txt+'</button>';
  const tabs = '<div class="tabs" role="tablist">'+t('entreno','Entreno')+t('menu','Menú')+t('informe','Informe')+(S.compraOn ? t('compra','🛒 Compra') : '')+'</div>';
  const kg = kgDe();
  const cuerpo = S.ptab==='datos' ? vResumen(p) : S.ptab==='entreno' ? vEntreno(p) : S.ptab==='informe' ? vInforme(p) : S.ptab==='compra' ? vCompraTab(p) : vMenuTab(p);
  return '<div class="crumbs"><a href="#" data-act="volver">Pacientes</a> › <b>'+esc(p.name)+'</b></div><div class="content">' +
    '<div class="pacthead"><h1>'+esc(p.name)+'</h1><button class="pesochip" data-act="pesoDlg" aria-label="Anotar peso">⚖️ '+(kg ? kgTxt(kg)+' kg' : 'Anotar peso')+'</button></div>' + tabs + cuerpo + '</div>';
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
    vWorkOutCard(p) + vCompeticion(p) +
    '<div class="card"><h3>Datos</h3><p class="sub">'+esc([p.sex, p.birthYear ? 'nacido en '+p.birthYear : '', p.heightCm ? p.heightCm+' cm' : '', p.goal ? 'Objetivo: '+p.goal : ''].filter(Boolean).join(' · ') || 'Sin datos')+'</p>' +
    (p.notes ? '<p style="margin:8px 0 0">'+esc(p.notes)+'</p>' : '') + '</div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="editar">Editar datos</button><button class="btn danger" data-act="borrar">Eliminar</button></div>';
}
function vWorkOutCard(p){
  const l = linkDe(p.id);
  let cuerpo;
  if (!l || l.status === 'revoked' || l.status === 'rejected') {
    cuerpo = (l ? '<p class="sub" style="margin-bottom:10px">'+(l.status==='rejected' ? 'El paciente rechazó la solicitud.' : 'El paciente retiró el permiso.')+'</p>' : '') +
      '<p class="sub" style="margin-bottom:12px">Si el paciente usa WorkOut, puedes leer su semana, competiciones y peso, con su permiso.</p>' +
      '<button class="btn ghost" data-act="vincular">🔗 Vincular con WorkOut</button>';
  } else if (l.status === 'pending') {
    cuerpo = '<p class="sub" style="margin-bottom:12px">Solicitud enviada a <b>'+esc(l.email)+'</b>. Falta que el paciente la acepte entrando en esta app con ese correo.</p>' +
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
// Competiciones del paciente: las de WorkOut (fechas, con su permiso) + las puestas a mano.
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
function calcDia(p, nivel, fecha, kg, comp){
  const edad = new Date().getFullYear() - p.birthYear;
  const reposo = 10*kg + 6.25*p.heightCm - 5*edad + (p.sex === 'Hombre' ? 5 : -161);
  const mant = reposo * FACTOR[nivel-1];
  const obj = tipoObjetivo(p);
  let kcal = mant, nota = '';
  if (obj === 'bajar') {
    if (nivel <= 2 && !comp[fecha]) { kcal = Math.max(mant*(1-DEFICIT), reposo); nota = 'déficit'; }
    else nota = comp[fecha] ? 'competición: sin déficit' : 'sin déficit';
  } else if (obj === 'subir') { kcal = mant*(1+SUPERAVIT); nota = 'superávit'; }
  // Proteína fija. Grasa 1 g/kg, pero si así los carbohidratos quedan bajo 3 g/kg, la grasa baja
  // (hasta 0,7 g/kg) para protegerlos: son el combustible del entreno.
  const prot = PROT_G_KG*kg;
  let grasa = GRASA_G_KG*kg;
  if ((kcal - 4*prot - 9*grasa)/4/kg < CARB_MIN_G_KG) grasa = Math.max(GRASA_MIN_G_KG*kg, (kcal - 4*prot - 4*CARB_MIN_G_KG*kg)/9);
  const carb = Math.max((kcal - 4*prot - 9*grasa)/4, 0);
  if (carb/kg < CARB_MIN_G_KG) nota += (nota ? ' · ' : '') + 'carbohidratos bajos';
  return {kcal:Math.round(kcal/10)*10, prot:Math.round(prot), carb:Math.round(carb), grasa:Math.round(grasa), nota, carbKg:carb/kg, gasto:Math.round(mant/10)*10, reposo:Math.round(reposo)};
}
function vMacros(p){
  const lv = S.levels;
  if (!lv || !lv.some(x => x)) return '';
  const falta = [];
  if (!p.sex) falta.push('sexo'); if (!p.birthYear) falta.push('año de nacimiento'); if (!p.heightCm) falta.push('altura');
  const kg = S.weights.length ? S.weights[0].kg : null;
  if (!kg) falta.push('un peso');
  if (falta.length) return '<div class="card"><h3>Calorías y macros</h3><p class="sub">Para calcularlos falta: '+falta.join(', ')+'. Complétalo en Resumen → Editar datos.</p></div>';
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
const REPARTO_DEF = [['Desayuno',25],['Media mañana',10],['Almuerzo',30],['Merienda',10],['Cena',25]];
const repartoDe = p => (Array.isArray(p.reparto) && p.reparto.length === 5) ? REPARTO_DEF.map((x,i) => [x[0], Number(p.reparto[i])||0]) : REPARTO_DEF;
function kgDe(){ return S.weights.length ? S.weights[0].kg : null; }
function datosOk(p){ return !!(p.sex && p.birthYear && p.heightCm && kgDe()); }
function objetivoDia(p, i){
  if (!S.levels || !S.levels[i] || !datosOk(p)) return null;
  const r = calcDia(p, S.levels[i], sumaDias(S.weekStart,i), kgDe(), diasCompeticion(p.id));
  return {kcal:r.kcal, prot:r.prot, carb:r.carb, fat:r.grasa};
}
function aptaPara(r, slot){
  const u = norm(r.useIn || '');
  if (slot === 'Desayuno') return u.indexOf('desayun') >= 0;
  if (slot === 'Almuerzo') return u.indexOf('almuerz') >= 0 || u.indexOf('comida') >= 0;
  if (slot === 'Cena') return u.indexOf('cena') >= 0;
  return u.indexOf('merienda') >= 0 || u.indexOf('media') >= 0 || u.indexOf('snack') >= 0 || u.indexOf('desayun') >= 0;
}
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
function escalaPara(r, t){ return Math.round(clamp(t.kcal / Math.max(r.kcal, 1), 0.5, 2) * 20) / 20; }
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
function candidatas(slot){
  const todas = S.recipes.filter(r => (r.kcal||0) > 0);
  const aptas = todas.filter(r => aptaPara(r, slot));
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
  const rep = repartoDe(p), usos = {}, menu = [];
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
    if (obj) afinarDia(obj, meals, menu[i-1], usos);
    menu.push({meals});
  }
  S.menu = menu; S.menuBase = baseDeMenu(menu); S.ptab = 'informe'; setMsg('Menú generado. Toca cualquier comida de la tabla para cambiarla y verás cómo cambian las kcal y los macros.', true); render(); window.scrollTo(0, 0); await guardarMenu();
}
/* Segunda pasada: ajusta el día ENTERO (no cada comida por separado) para que las kcal cuadren y
   la proteína no se quede corta ni la grasa se pase. Prueba otras recetas y raciones comida a comida. */
function afinarDia(obj, meals, diaPrevio, usos){
  const suma = ms => { const t = {kcal:0, prot:0, carb:0, fat:0}; ms.forEach(m => { if (m.rid) { const v = valsComida(m); t.kcal += v.kcal; t.prot += v.prot; t.carb += v.carb; t.fat += v.fat; } }); return t; };
  const costeDia = ms => { const t = suma(ms); return 3*Math.max(Math.abs(t.kcal - obj.kcal) - 0.03*obj.kcal, 0)/obj.kcal + errMacros(t, obj); };
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
        const s0 = clamp((obj.kcal - kOtras)/Math.max(r.kcal, 1), 0.5, 2);
        [0, -0.1, 0.1].forEach(dl => {
          const s = Math.round(clamp(s0 + dl, 0.5, 2)*20)/20, cand = comidaDe(r, m.slot, s);
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
/* ---------- copiar menú de otra semana ---------- */
async function dlgCopiarSemana(){
  abrirDlg('<h2>Copiar menú de otra semana</h2><div class="empty">Buscando semanas…</div>');
  try {
    const snap = await refPac(S.pid).collection('weeks').get();
    S.semanasMenu = snap.docs.map(d => ({id:d.id, menu:d.data().menu, levels:d.data().levels}))
      .filter(w => w.id !== S.weekStart && Array.isArray(w.menu) && w.menu.some(d => d.meals && d.meals.some(m => m.rid))).sort((a,b) => a.id < b.id ? 1 : -1);
  } catch(e){ abrirDlg('<h2>Copiar menú</h2><div class="msg err">No se pudieron leer las semanas ('+esc((e && (e.code||e.message)) || 'error')+').</div><button class="btn ghost" data-act="cerrar">Cerrar</button>'); return; }
  if (!S.semanasMenu.length) { abrirDlg('<h2>Copiar menú de otra semana</h2><div class="empty">Este paciente aún no tiene menús en otras semanas.</div><button class="btn ghost" data-act="cerrar">Cerrar</button>'); return; }
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
const hayReal = dia => (dia.meals||[]).some(m => m.rid && m.real);
function dlgReal(){
  const p = pacienteActual(), sl = S.slot; if (!p || !sl) return;
  const m = S.menu[sl.d].meals[sl.m], plan = valsComida(m);
  let h = '<h2>'+DIAS[sl.d]+' · '+esc(m.slot)+'</h2><p class="sub" style="margin-bottom:10px">Cambio sobre la marcha: lo que se comió de verdad frente a lo planificado.</p>' +
    '<div class="card" style="margin-bottom:10px"><p class="sub">Planificado</p><b>'+esc(m.name)+'</b><p class="sub">'+Math.round(plan.kcal)+' kcal · P '+r1(plan.prot)+' · C '+r1(plan.carb)+' · G '+r1(plan.fat)+'</p></div>';
  if (m.real) {
    const rv = valsReal(m);
    h += '<div class="card accent" style="margin-bottom:10px"><p class="sub">Comido</p><b>'+(m.real.none ? 'No se comió' : esc(m.real.name))+'</b>' +
      '<p class="sub">'+Math.round(rv.kcal)+' kcal · P '+r1(rv.prot)+' · C '+r1(rv.carb)+' · G '+r1(rv.fat)+'</p>' +
      '<p style="margin:6px 0 10px;font-weight:800;font-size:17px">Variación: '+txtVariacion(plan, rv)+'</p>' +
      (m.real.none ? '' : '<div class="btn-row"><button class="btn secondary" data-act="escalaReal" data-n="-0.1">− Ración</button><b style="align-self:center;text-align:center;min-width:64px">×'+kgTxt(Math.round(m.real.s*100)/100)+'</b><button class="btn secondary" data-act="escalaReal" data-n="0.1">＋ Ración</button></div>') +
      '<button class="btn danger" style="margin-top:10px" data-act="quitarReal">Volver a lo planificado</button></div>';
  }
  const q = norm(S.realQ || '');
  const lista = S.recipes.filter(r => (r.kcal||0) > 0 && (!q || norm([r.name, (r.ingredients||[]).join(' ')].join(' ')).indexOf(q) >= 0)).slice(0, q ? 30 : 12);
  h += '<button class="btn secondary" style="margin-bottom:10px" data-act="noComi">🚫 No se comió esta comida</button>' +
    '<div class="field"><label class="f" for="rq2">Lo que se comió</label><input id="rq2" type="search" value="'+esc(S.realQ||'')+'" placeholder="Buscar receta…" autocomplete="off"></div>' +
    (lista.length ? '<div class="list">'+lista.map(r => { const sc = Math.round(clamp(plan.kcal/Math.max(r.kcal,1), 0.3, 3)*20)/20;
      return '<button class="row" data-act="elegirReal" data-id="'+esc(r.id)+'"><div class="grow"><b>'+esc(r.name)+'</b><p class="sub">ración ×'+kgTxt(sc)+' · '+Math.round(r.kcal*sc)+' kcal · P '+r1(r.prot*sc)+' · C '+r1(r.carb*sc)+' · G '+r1(r.fat*sc)+'</p></div><span class="chev">›</span></button>'; }).join('')+'</div>' : '<div class="empty">Ninguna receta coincide.</div>') +
    '<div class="btn-row" style="margin-top:12px"><button class="btn secondary" data-act="slotMenu" data-d="'+sl.d+'" data-m="'+sl.m+'">‹ Volver</button><button class="btn" data-act="cerrar">Hecho</button></div>';
  abrirDlg(h);
}
function totalDia(dia){
  const t = {kcal:0, prot:0, carb:0, fat:0};
  (dia.meals||[]).forEach(m => { if (m.rid) { const v = valsComida(m); t.kcal += v.kcal; t.prot += v.prot; t.carb += v.carb; t.fat += v.fat; } });
  return t;
}
const r1 = x => kgTxt(Math.round(x*10)/10);
function vMenu(p){
  if (!S.levels || !S.levels.some(x => x)) return '';
  if (!datosOk(p)) return '';
  const hay = S.menu && S.menu.some(d => d.meals && d.meals.length);
  let html = '<div class="card"><h3>Menú de la semana</h3>' +
    '<p class="sub" style="margin-bottom:10px">'+(hay ? 'Toca una comida para cambiar la receta o la ración.' : 'La app propone una receta para cada comida, con la ración ajustada a las kcal y macros del día.')+'</p>' +
    '<div class="btn-row"><button class="btn secondary" data-act="repartoDlg">Reparto</button><button class="btn secondary" data-act="copiarSemana">📋 Copiar de otra semana</button></div>' +
    '<button class="btn secondary" style="margin-top:10px" data-act="fijasDlg">📌 Comidas fijas'+(() => { const f = fijasDe(p), n = Object.keys(f).filter(k => f[k] && f[k].rid).length; return n ? ' ('+n+(fijasPropias(p) ? '' : ', por defecto')+')' : ''; })()+'</button></div>';
  const btnGen = '<div class="card"><button class="btn" data-act="proponerMenu">'+(hay ? '🔄 Generar menú de nuevo y ver la tabla' : '✨ Generar menú y ver la tabla')+'</button><p class="sub" style="margin-top:8px">Propone los platos de toda la semana y te lleva a Informe, donde ves el menú en tabla y puedes cambiar cualquier plato.</p>' +
    (hay ? '<button class="btn secondary" style="margin-top:10px" data-act="ptab" data-v="informe">Ver la tabla</button>' : '') + '</div>';
  if (!hay) return html + vMacros(p) + btnGen;
  html += DIAS.map((d, i) => {
    const dia = S.menu[i]; if (!dia || !dia.meals || !dia.meals.length) return '';
    const obj = objetivoDia(p, i), tot = totalDia(dia);
    const filas = dia.meals.map((m, j) => {
      if (!m.rid) return '<button class="row" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'"><div class="grow"><b>'+esc(m.slot)+'</b><p class="sub">Sin receta · toca para elegir</p></div><span class="chev">＋</span></button>';
      const v = valsComida(m);
      let real = '';
      if (m.real) { const rv = valsReal(m);
        real = '<p class="sub" style="color:var(--t-accent2);font-weight:700">🔁 Comido: '+(m.real.none ? 'nada' : esc(m.real.name)+' · ×'+kgTxt(Math.round(m.real.s*100)/100)+' · '+Math.round(rv.kcal)+' kcal · P '+r1(rv.prot)+' · C '+r1(rv.carb)+' · G '+r1(rv.fat))+'</p>' +
          '<p class="sub">Variación: '+txtVariacion(v, rv)+'</p>'; }
      return '<button class="row" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'"><div class="grow"><b>'+esc(m.slot)+'</b>'+(m.fija ? ' 📌' : '')+' · '+esc(m.name)+
        '<p class="sub">'+(m.real ? 'Planificado: ' : '')+'ración ×'+kgTxt(Math.round(m.s*100)/100)+(m.bw ? ' · '+Math.round(v.g)+' g' : '')+' · '+Math.round(v.kcal)+' kcal · P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+'</p>'+real+'</div><span class="chev">›</span></button>';
    }).join('');
    return '<div class="card"><h3 style="margin-bottom:2px">'+d+' · '+NIVELES[S.levels[i]-1]+'</h3>' +
      '<p class="sub" style="margin-bottom:8px">Total '+Math.round(tot.kcal)+' de '+(obj ? obj.kcal : '?')+' kcal · P '+Math.round(tot.prot)+'/'+(obj ? obj.prot : '?')+' · C '+Math.round(tot.carb)+'/'+(obj ? obj.carb : '?')+' · G '+Math.round(tot.fat)+'/'+(obj ? obj.fat : '?')+'</p>' +
      (hayReal(dia) ? (() => { const rt = totalReal(dia); return '<p class="sub" style="margin:-4px 0 8px;color:var(--t-accent2);font-weight:700">Real: '+Math.round(rt.kcal)+' kcal · P '+Math.round(rt.prot)+' · C '+Math.round(rt.carb)+' · G '+Math.round(rt.fat)+' ('+txtVariacion(tot, rt)+')</p>'; })() : '') +
      '<div class="list">'+filas+'</div></div>';
  }).join('');
  return html + btnGen;
}
function dlgSlot(){
  const p = pacienteActual(), sl = S.slot; if (!p || !sl) return;
  const dia = S.menu[sl.d], m = dia.meals[sl.m], obj = objetivoDia(p, sl.d);
  const pct = (repartoDe(p).find(x => x[0] === m.slot) || [0,0])[1];
  const t = obj ? {kcal:obj.kcal*pct/100, prot:obj.prot*pct/100, carb:obj.carb*pct/100, fat:obj.fat*pct/100} : null;
  const usos = {}; S.menu.forEach(d => (d.meals||[]).forEach(x => { if (x.rid) usos[x.rid] = (usos[x.rid]||0) + 1; }));
  const delDia = {}; dia.meals.forEach(x => { if (x.rid && x !== m) delDia[x.rid] = true; });
  const q = norm(S.slotQ || '');
  const base = q ? S.recipes.filter(r => (r.kcal||0) > 0 && norm([r.name, r.useIn, (r.ingredients||[]).join(' ')].join(' ')).indexOf(q) >= 0) : candidatas(m.slot);
  const cands = (t ? base.map(r => ({r, sc:puntua(r, t, usos, null, delDia)})).sort((a,b) => a.sc - b.sc).map(x => x.r) : base).slice(0, q ? 30 : 10);
  let cabecera = '<h2>'+DIAS[sl.d]+' · '+esc(m.slot)+'</h2>';
  if (t) cabecera += '<p class="sub" style="margin-bottom:12px">Objetivo de esta comida: '+Math.round(t.kcal)+' kcal · P '+Math.round(t.prot)+' · C '+Math.round(t.carb)+' · G '+Math.round(t.fat)+'</p>';
  let actual = '';
  if (m.rid) {
    const v = valsComida(m);
    actual = '<div class="card accent" style="margin-bottom:12px"><b>'+esc(m.name)+'</b><p class="sub" style="margin:4px 0 10px">'+Math.round(v.kcal)+' kcal · P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+(m.bw ? ' · '+Math.round(v.g)+' g' : '')+'</p>' +
      '<div class="btn-row"><button class="btn secondary" data-act="escalaSlot" data-n="-0.1" aria-label="Menos ración">− Ración</button><b style="align-self:center;text-align:center;min-width:64px">×'+kgTxt(Math.round(m.s*100)/100)+'</b><button class="btn secondary" data-act="escalaSlot" data-n="0.1" aria-label="Más ración">＋ Ración</button></div>' +
      '<button class="btn danger" style="margin-top:10px" data-act="quitarSlot">Quitar esta comida</button></div>';
  }
  const buscador = '<div class="field"><label class="f" for="sq">Buscar receta</label><input id="sq" type="search" value="'+esc(S.slotQ||'')+'" placeholder="Nombre o ingrediente…" autocomplete="off"></div>';
  const sinKcal = S.recipes.filter(r => !(r.kcal > 0)).length;
  const lista = buscador + '<button class="btn secondary" style="margin-bottom:10px" data-act="recetaDesdeSlot">＋ Añadir receta a mano</button>' +
    (sinKcal ? '<p class="sub" style="margin-bottom:10px">⚠ '+sinKcal+' receta'+(sinKcal>1?'s':'')+' sin calorías no sale'+(sinKcal>1?'n':'')+' aquí. Ábrela'+(sinKcal>1?'s':'')+' en el Recetario y pulsa «Calcular macros».</p>' : '') + (cands.length ? '<h3 style="margin:6px 0">'+(q ? 'Resultados' : 'Recetas que encajan')+'</h3><div class="list">' + cands.filter(r => r.id !== m.rid).map(r => {
    const s = t ? escalaPara(r, t) : 1;
    return '<button class="row" data-act="elegirReceta" data-id="'+esc(r.id)+'"><div class="grow"><b>'+esc(r.name)+'</b><p class="sub">ración ×'+kgTxt(s)+' · '+Math.round(r.kcal*s)+' kcal · P '+r1(r.prot*s)+' · C '+r1(r.carb*s)+' · G '+r1(r.fat*s)+'</p></div><span class="chev">›</span></button>';
  }).join('') + '</div>' : '<div class="empty">'+(q ? 'Ninguna receta coincide.' : 'No hay recetas para esta comida. Añade recetas en el Recetario.')+'</div>');
  const botonReal = m.rid ? '<button class="btn secondary" style="margin-bottom:12px" data-act="realDlg">🔁 Cambio sobre la marcha'+(m.real ? ' (registrado)' : '')+'</button>' : '';
  abrirDlg(cabecera + actual + botonReal + lista + '<button class="btn ghost" style="margin-top:12px" data-act="cerrar">Cerrar</button>');
}
async function cambiarSlot(fn, cerrar, aviso, reabrir){
  const sl = S.slot; if (!sl) return;
  const antes = totalDia(S.menu[sl.d]);
  fn(S.menu[sl.d].meals[sl.m]);
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
      '<div class="field"><label class="f" for="fx'+i+'">Receta fija</label><select id="fx'+i+'"><option value="">— ninguna (la app elige) —</option>' +
      recs.map(r => '<option value="'+esc(r.id)+'"'+(r.id === f.rid ? ' selected' : '')+'>'+esc(r.name)+'</option>').join('') + '</select></div>' +
      '<p class="sub" style="margin-bottom:6px">Días en que se repite</p><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
      DIA_CORTO.map((d, k) => '<label style="display:flex;flex-direction:column;align-items:center;gap:2px;font-weight:800;font-size:17px"><input type="checkbox" id="fd'+i+'_'+k+'" style="width:28px;min-height:28px"'+(dias.indexOf(k) >= 0 ? ' checked' : '')+'>'+d+'</label>').join('') + '</div>' +
      '<div class="field"><label class="f" for="fs'+i+'">Ración (1 = la receta entera)</label><input id="fs'+i+'" inputmode="decimal" value="'+esc(kgTxt(f.s || 1))+'"></div></div>';
  }).join('');
  abrirDlg('<h2>Comidas fijas</h2><p class="sub" style="margin-bottom:12px">Comidas que se repiten (por ejemplo, el desayuno de lunes a viernes). El resto del día se reparte contando con ellas. Después puedes cambiar una en un día concreto tocándola.</p>' +
    bloques + '<div class="msg err" id="fx_msg"></div>' +
    '<button class="btn" data-act="guardarFijas" data-todos="1">Guardar para todos mis pacientes</button>' +
    '<p class="sub" style="margin:4px 0 10px">Se usará con los pacientes que no tengan ajuste propio.</p>' +
    '<button class="btn secondary" data-act="guardarFijas" data-todos="0">Guardar solo para este paciente</button>' +
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
      await db.collection('users').doc(S.user.uid).update({nuPrefs:Object.assign({}, S.prefs, {fijas})});
      S.prefs = Object.assign({}, S.prefs, {fijas});
      await refPac(p.id).update({fijas:firebase.firestore.FieldValue.delete()}); delete p.fijas;
    } else { await refPac(p.id).update({fijas}); p.fijas = fijas; }
    cerrarDlg(); setMsg(todos ? 'Comidas fijas guardadas para todos tus pacientes. Pulsa «Proponer menú» para aplicarlas.' : 'Comidas fijas guardadas para este paciente. Pulsa «Proponer menú» para aplicarlas.', true);
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
  const v = [0,1,2,3,4].map(i => parseInt($('#rp'+i).value, 10) || 0);
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
    gastoMedio: conMenu.length ? sum(conMenu, d => d.gasto)/conMenu.length : 0
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
    const r = recetaPorId(m.rid); if (!r) return;
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
function vPdf(p){
  if (!datosOk(p) || !S.levels || !S.levels.some(x => x)) return '';
  const ds = datosSemana(p), rs = resumenSemana(ds), kg = kgDe(), fin = sumaDias(S.weekStart, 6), hayR = ds.some(d => d.real);
  const edad = new Date().getFullYear() - p.birthYear;
  let h = '<div class="pdfdoc"><div class="pdfbar"><button class="btn secondary" data-act="pdfCerrar">‹ Cerrar</button><button class="btn" data-act="pdfImprimir">🖨️ Imprimir / Guardar PDF</button></div><div class="pdfpage">';
  h += '<header class="wo2head"><img src="static/icon-192.png" alt="NutriForce" width="64" height="64"><div><div class="ttl">INFORME SEMANAL DE NUTRICIÓN</div>' +
    '<div class="l2">Semana  ·  '+fechaCorta(S.weekStart)+' – '+fechaCorta(fin)+'</div>' +
    '<div class="l2">Paciente: '+esc(p.name)+'  ·  '+esc(p.sex || '')+' · '+edad+' años · '+p.heightCm+' cm · '+kgTxt(kg)+' kg'+(p.goal ? '  ·  Objetivo: '+esc(p.goal) : '')+'</div></div></header>';
  h += '<section><h2>Cómo cuadra el menú con la semana de entreno</h2>'+explicacionSemana(p, ds, rs)+'</section>';
  if (rs.nMenu) {
    h += '<section><h2>Resumen</h2><div class="kpis"><div><span>Objetivo medio</span><b>'+fmtN(rs.objMedio)+' kcal</b></div><div><span>Menú medio</span><b>'+fmtN(rs.menuMedio)+' kcal</b></div><div><span>Cubierto</span><b>'+Math.round(rs.cobertura*100)+' %</b></div><div><span>Balance semanal</span><b>'+(rs.balance >= 0 ? '+' : '−')+fmtN(Math.abs(rs.balance))+' kcal</b></div></div>' +
      '<h3>Lectura rápida</h3>'+lecturaRapida(ds, rs, kg, PAL_PDF)+'<div class="g2"><div><h3>Energía por día (kcal)</h3>'+chartKcal(ds, PAL_PDF)+leyendaKcal(PAL_PDF, hayR)+'</div>' +
      '<div><h3>Macros: necesarios y en el menú</h3>'+barrasMacros(ds, PAL_PDF, kg)+'</div></div>' +
      '<div class="g2"><div><h3>Macros día a día</h3>'+chartMacrosDia(ds, PAL_PDF)+leyendaMacros(PAL_PDF)+'</div><div><h3>Cifras por día</h3>'+tablaCifras(ds, PAL_PDF)+'</div></div></section>';
    h += '<section><h2>Pautas a seguir</h2><ul>'+pautasAuto(p, ds, rs).map(x => '<li>'+x+'</li>').join('')+'</ul>' +
    (S.notas && S.notas.trim() ? '<h3>Notas del nutricionista</h3><p style="white-space:pre-wrap">'+esc(S.notas.trim())+'</p>' : '')+'</section>';

    h += cambiosPdf();
    h += '<section class="menupage"><h2>Menú de la semana</h2>'+tablaMenuPdf(p)+'</section>';
  } else h += '<section><p class="mut">Esta semana aún no tiene menú.</p></section>';
  if (!rs.nMenu) { h += '<section><h2>Pautas a seguir</h2><ul>'+pautasAuto(p, ds, rs).map(x => '<li>'+x+'</li>').join('')+'</ul>' +
    (S.notas && S.notas.trim() ? '<h3>Notas del nutricionista</h3><p style="white-space:pre-wrap">'+esc(S.notas.trim())+'</p>' : '')+'</section>'; }
  h += '<footer'+(rs.nMenu ? ' style="page:menu"' : '')+'>Generado el '+fechaCorta(iso(new Date()))+' con NutriForce · RPT · Las cifras son estimaciones orientativas.</footer></div></div>';
  return h;
}
function tablaMenuApp(p){
  const slots = []; (S.menu || []).forEach(d => (d && d.meals || []).forEach(m => { if (slots.indexOf(m.slot) < 0) slots.push(m.slot); }));
  const cab = DIAS.map((d, i) => '<th>'+d.slice(0,3)+'<br><span style="font-weight:700;color:'+(S.levels && S.levels[i] ? LVL_COL[S.levels[i]-1] : 'var(--t-muted)')+'">'+(S.levels && S.levels[i] ? NIVELES[S.levels[i]-1] : '—')+'</span></th>').join('');
  const celda = (i, sl) => { const d = S.menu[i], j = d && d.meals ? d.meals.findIndex(x => x.slot === sl) : -1; if (j < 0) return '<td></td>'; const m = d.meals[j];
    if (!m.rid) return '<td class="cel" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'" tabindex="0" role="button"><span class="mut">＋ elegir</span></td>';
    const v = valsComida(m);
    return '<td class="cel" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'" tabindex="0" role="button"><b>'+esc(m.name)+'</b>'+(m.fija ? ' 📌' : '')+(m.real ? ' 🔁' : '')+'<br><span class="mut">×'+kgTxt(Math.round(m.s*100)/100)+' · '+Math.round(v.kcal)+' kcal</span><br><span class="mut">P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+'</span></td>'; };
  const filas = slots.map(sl => '<tr><th class="sl">'+esc(sl)+'</th>'+DIAS.map((d, i) => celda(i, sl)).join('')+'</tr>').join('');
  const tot = '<tr class="tot"><th class="sl">Total del día</th>'+DIAS.map((d, i) => {
    const dia = S.menu[i], o = objetivoDia(p, i); if (!dia || !dia.meals || !dia.meals.some(m => m.rid)) return '<td class="mut">–</td>';
    const t = totalDia(dia), b = S.menuBase && S.menuBase[i];
    const pct = o ? t.kcal/o.kcal : 1, col = estado(pct, PAL_APP);
    const dif = b ? Math.abs(t.kcal - b.kcal) + Math.abs(t.prot - b.prot) + Math.abs(t.carb - b.carb) + Math.abs(t.fat - b.fat) : 0;
    return '<td><b style="color:'+col+'">'+fmtN(t.kcal)+' kcal</b>'+(o ? ' <span class="mut">('+Math.round(pct*100)+'%)</span>' : '')+'<br><span class="mut">obj. '+(o ? o.kcal : '?')+'</span><br><span class="mut">P '+Math.round(t.prot)+(o ? '/'+o.prot : '')+'<br>C '+Math.round(t.carb)+(o ? '/'+o.carb : '')+'<br>G '+Math.round(t.fat)+(o ? '/'+o.fat : '')+'</span>' +
      (dif > 4 ? '<br><span class="chg">Desde el menú generado:<br>'+txtVariacion(b, t)+'</span>' : '') + '</td>'; }).join('')+'</tr>';
  return '<div class="tscroll"><table class="mtabapp"><thead><tr><th class="sl"></th>'+cab+'</tr></thead><tbody>'+filas+tot+'</tbody></table></div>';
}
function vCompraTab(p){
  const c = vCompra(false);
  return cabSemana() + msgHtml() + (c || '<div class="card"><p class="sub">Esta semana aún no hay menú, así que no hay nada que comprar.</p></div>') +
    '<button class="btn secondary" data-act="compraCerrar">Ocultar la lista de la compra</button>';
}
function vInforme(p){
  let h = cabSemana() + msgHtml();
  if (S.menu && S.menu.some(d => d && d.meals && d.meals.some(m => m.rid))) {
    h += '<div class="card"><h3>Menú de la semana</h3><p class="sub" style="margin-bottom:8px">Toca una comida para cambiarla. Abajo de cada día ves cómo queda frente al objetivo y cuánto ha cambiado desde que se generó el menú.</p>' + tablaMenuApp(p) +
      '<div class="btn-row" style="margin-top:12px"><button class="btn secondary" data-act="compraAbrir">🛒 Lista de la compra</button><button class="btn" data-act="pdfAbrir">📄 Ver informe PDF</button></div></div>';
  }
  if (!datosOk(p)) return h + '<div class="card"><p class="sub">Para calcular hace falta sexo, año de nacimiento, altura y un peso. Complétalo en Resumen.</p></div>';
  if (!S.levels || !S.levels.some(x => x)) return h + '<div class="card"><p class="sub">Esta semana aún no tiene niveles de entreno. Ponlos en la pestaña Entreno.</p></div>';
  const ds = datosSemana(p), rs = resumenSemana(ds), kg = kgDe(), hayR = ds.some(d => d.real);
  if (!rs.nMenu) return h + '<div class="card"><p class="sub" style="margin-bottom:10px">Esta semana aún no tiene menú. Genéralo en la pestaña Menú y aquí verás la tabla y los gráficos.</p><button class="btn" data-act="ptab" data-v="menu">Ir a Menú</button></div>';
  const bal = rs.balance, grasa = Math.abs(bal)/7.7;
  const colBal = Math.abs(bal) < 700 ? 'var(--t-good-fg)' : 'var(--t-chg-fg)';
  h += '<div class="card"><h3>Resumen de la semana</h3><div style="display:flex;flex-wrap:wrap;gap:8px">' +
    kpi('Objetivo medio', fmtN(rs.objMedio)+' kcal', 'por día') + kpi('Menú medio', fmtN(rs.menuMedio)+' kcal', (hayR ? 'con lo realmente comido' : 'por día')) +
    kpi('Cubierto', Math.round(rs.cobertura*100)+'%', 'del objetivo', rs.cobertura >= 0.95 && rs.cobertura <= 1.05 ? 'var(--t-good-fg)' : 'var(--t-chg-fg)') +
    kpi('Balance semanal', (bal >= 0 ? '+' : '−')+fmtN(Math.abs(bal))+' kcal', 'frente al gasto estimado (≈ '+(bal >= 0 ? '+' : '−')+Math.round(grasa)+' g de grasa)', colBal) + '</div></div>';
  h += '<div class="card"><h3>Lectura rápida</h3>'+lecturaRapida(ds, rs, kg, PAL_APP)+'</div>';
  h += '<div class="card"><h3 style="margin-bottom:0">Energía por día (kcal)</h3><p class="sub" style="margin-bottom:6px">La barra gris es lo que necesitas ese día; la de color, lo que aporta el menú. La línea discontinua es lo que gastas.</p>' +
    chartKcal(ds, PAL_APP) + leyendaKcal(PAL_APP, hayR) +
    '<div style="margin-top:10px">'+tablaCifras(ds, PAL_APP)+'</div></div>';
  h += '<div class="card"><h3>Macros: necesarios y en el menú</h3>' + barrasMacros(ds, PAL_APP, kg) + '</div>';
  h += '<div class="card"><h3>Macros día a día</h3>' + chartMacrosDia(ds, PAL_APP) + leyendaMacros(PAL_APP) + '</div>';
  h += '<div class="card"><h3>Informe en PDF</h3><p class="sub" style="margin-bottom:8px">Notas para el paciente: aparecerán en el informe, junto a las pautas automáticas.</p>' +
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
  return cabSemana() + msgHtml() + vMenu(p);
}
function norm(t){ return String(t||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
const macrosTxt = r => (r.kcal||0)+' kcal · P '+kgTxt(r.prot||0)+' · C '+kgTxt(r.carb||0)+' · G '+kgTxt(r.fat||0);
function vRecetario(){
  const lista = S.rtab === 'compartidas' ? S.sharedRecipes : S.recipes;
  const q = norm(S.rq);
  const f = lista.filter(r => !q || norm([r.name, r.category, r.useIn, (r.ingredients||[]).join(' ')].join(' ')).indexOf(q) >= 0);
  const filas = f.length ? '<div class="list">' + f.map(r =>
    '<button class="row" data-act="verReceta" data-id="'+esc(r.id)+'"><div class="avatar">🍽</div><div class="grow"><b>'+esc(r.name)+'</b>' +
    '<p class="sub">'+esc(macrosTxt(r))+' por ración</p>' +
    (r.sinContar && r.sinContar.length ? '<p class="sub" style="color:var(--t-bad-fg);font-weight:700">⚠ Macros incompletos: sin contar '+esc(r.sinContar.join(', '))+'</p>' : '') + '<p class="sub">'+esc([r.category, r.useIn].filter(Boolean).join(' · '))+(S.rtab==='mias' && r.shared ? ' · 🔗 compartida' : '')+(S.rtab==='compartidas' ? ' · de '+esc(r.ownerName||'otro nutricionista') : '')+'</p></div><span class="chev">›</span></button>').join('') + '</div>'
    : '<div class="empty">'+(lista.length ? 'Ninguna receta coincide con la búsqueda.' : (S.rtab==='compartidas' ? 'Todavía nadie ha compartido recetas.' : 'Todavía no tienes recetas.<br>Crea una o importa fichas de Word.'))+'</div>';
  return '<div class="crumbs"><b>Recetario</b></div><div class="content"><h1>Recetario</h1>' +
    '<div class="tabs" role="tablist"><button role="tab" data-act="rtab" data-v="mias" aria-selected="'+(S.rtab==='mias')+'">Mis recetas ('+S.recipes.length+')</button>' +
    '<button role="tab" data-act="rtab" data-v="compartidas" aria-selected="'+(S.rtab==='compartidas')+'">Compartidas ('+S.sharedRecipes.length+')</button></div>' +
    '<div class="field" style="margin-top:14px"><label class="f" for="rq">Buscar</label><input id="rq" type="search" value="'+esc(S.rq)+'" placeholder="Nombre, ingrediente, categoría…" autocomplete="off"></div>' +
    (S.rmsg ? '<div class="msg '+(S.rmsgOk?'ok':'err')+'">'+esc(S.rmsg)+'</div>' : '') + filas +
    '<div class="btn-row"><button class="btn" data-act="nuevaReceta">＋ Nueva receta</button><button class="btn secondary" data-act="importarWord">📄 Importar de Word</button></div>' +
    '<input id="docxIn" type="file" accept=".docx" multiple style="display:none"></div>';
}
function vCuenta(){
  return '<div class="crumbs"><b>Cuenta</b></div><div class="content"><h1>Cuenta</h1>' +
    '<div class="card"><p class="sub">Sesión iniciada como</p><b>'+esc(S.user.email)+'</b></div>' +
    S.requests.filter(l => l.status === 'accepted').map(l =>
      '<div class="card"><p class="sub">'+esc(l.nutriName||'Un nutricionista')+' puede leer tus datos de WorkOut y anotarte pesos.</p>' +
      '<button class="btn danger" style="margin-top:10px" data-act="retirar" data-id="'+esc(l.id)+'">Retirar permiso</button></div>').join('') +
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
function abrirDlg(html){ $('#dlgBody').innerHTML = html; $('#dlg').classList.add('open'); }
function cerrarDlg(){ $('#dlg').classList.remove('open'); S.slotPend = null; }
function dlgPaciente(p){
  const v = p || {};
  abrirDlg('<h2>'+(p?'Editar paciente':'Nuevo paciente')+'</h2>' +
    '<div class="field"><label class="f" for="d_name">Nombre</label><input id="d_name" value="'+esc(v.name||'')+'" autocomplete="off"></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="d_sex">Sexo</label><select id="d_sex">'+['','Mujer','Hombre'].map(o=>'<option'+(o===(v.sex||'')?' selected':'')+' value="'+o+'">'+(o||'—')+'</option>').join('')+'</select></div>' +
    '<div class="field"><label class="f" for="d_year">Año de nacimiento</label><input id="d_year" inputmode="numeric" value="'+esc(v.birthYear||'')+'"></div></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="d_h">Altura (cm)</label><input id="d_h" inputmode="numeric" value="'+esc(v.heightCm||'')+'"></div>' +
    '<div class="field"><label class="f" for="d_gt">Objetivo de peso</label><select id="d_gt">'+[['mantener','Mantener'],['bajar','Bajar'],['subir','Subir']].map(o=>'<option value="'+o[0]+'"'+(o[0]===tipoObjetivo(v)?' selected':'')+'>'+o[1]+'</option>').join('')+'</select></div></div>' +
    '<div class="field"><label class="f" for="d_goal">Objetivo (texto libre)</label><input id="d_goal" value="'+esc(v.goal||'')+'" placeholder="Opcional"></div>' +
    '<div class="field"><label class="f" for="d_notes">Notas</label><input id="d_notes" value="'+esc(v.notes||'')+'"></div>' +
    '<div class="msg err" id="d_msg"></div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="cerrar">Cancelar</button><button class="btn" data-act="guardarPaciente" data-id="'+esc(v.id||'')+'">Guardar</button></div>');
}

/* ---------- datos ---------- */
async function cargarPacientes(){
  const snap = await db.collection('nu_patients').where('ownerUid','==',S.user.uid).get();
  S.patients = snap.docs.map(d => Object.assign({id:d.id}, d.data()))
    .sort((a,b) => String(a.name||'').localeCompare(String(b.name||''),'es'));
}
async function cargarLinks(){
  const snap = await db.collection('nu_links').where('ownerUid','==',S.user.uid).get();
  S.links = snap.docs.map(d => Object.assign({id:d.id}, d.data()));
}
async function cargarSolicitudes(){
  const snap = await db.collection('nu_links').where('email','==',(S.user.email||'').toLowerCase()).get();
  S.requests = snap.docs.map(d => Object.assign({id:d.id}, d.data()));
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
  S.pid = id; S.tab = 'pacientes'; S.ptab = 'menu'; S.compraOn = false; S.menuBase = null; S.weights = []; S.levels = null; S.menu = null; S.weekStart = lunesISO(new Date()); setMsg(null);
  render();
  const l0 = linkDe(id); if (l0 && l0.status === 'accepted') await leerWorkOut(id);
  try { await cargarPesos(); } catch(e){ setMsg('No se pudo leer el peso (' + ((e && (e.code || e.message)) || 'error') + ').', false); console.error('pesos', e); }
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
  const datos = { name, sex:g('d_sex'), birthYear:y, heightCm:h, goal:g('d_goal'), goalType:g('d_gt'), notes:g('d_notes') };
  try {
    if (id) await refPac(id).update(datos);
    else await db.collection('nu_patients').add(Object.assign({ownerUid:S.user.uid, linkedUid:null, createdAt:firebase.firestore.FieldValue.serverTimestamp()}, datos));
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
  S.weekStart = sumaDias(S.weekStart, n); S.levels = null; S.menu = null; S.menuBase = null; setMsg(null); render();
  try { await cargarSemana(); } catch(e){ setMsg('No se pudo leer la semana (' + ((e && (e.code || e.message)) || 'error') + ').', false); console.error('semana', e); }
  render();
}
async function borrarPaciente(){
  const p = pacienteActual(); if (!p) return;
  abrirDlg('<h2>Eliminar paciente</h2><p class="sub" style="margin-bottom:14px">Se borrará a <b>'+esc(p.name)+'</b> con sus pesos y semanas. No se puede deshacer.</p>' +
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
  const m = await db.collection('nu_recipes').where('ownerUid','==',S.user.uid).get();
  S.recipes = m.docs.map(d => Object.assign({id:d.id}, d.data())).sort(porNombre);
  try {
    const c = await db.collection('nu_recipes').where('shared','==',true).get();
    S.sharedRecipes = c.docs.map(d => Object.assign({id:d.id}, d.data())).filter(r => r.ownerUid !== S.user.uid).sort(porNombre);
  } catch(e){ S.sharedRecipes = []; console.error('compartidas', e); }
}
function setRmsg(t, ok){ S.rmsg = t; S.rmsgOk = !!ok; }
const recetaPorId = id => S.recipes.concat(S.sharedRecipes).find(r => r.id === id);
function dlgVerReceta(id){
  const r = recetaPorId(id); if (!r) return;
  const mia = r.ownerUid === S.user.uid;
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
function dlgFormReceta(r, pendientes){
  r = r || {};
  const falta = pendientes > 0 ? '<div class="notice" style="margin-bottom:12px">📄 Receta leída del Word. Revísala. Quedan '+pendientes+' más después de esta.</div>' : '';
  const no = (r.unrecognized && r.unrecognized.length) ? '<div class="notice" style="margin-bottom:12px">No se han reconocido para el cálculo: '+esc(r.unrecognized.join(', '))+'. Corrige los macros a mano si hace falta.</div>' : '';
  const decl = r.declarado ? '<div class="notice ok" style="margin-bottom:12px">Los macros vienen declarados en el propio documento.</div>' : '';
  abrirDlg('<h2>'+(r.id ? 'Editar receta' : 'Receta')+'</h2>' + falta + decl + no +
    '<div class="field"><label class="f" for="r_name">Nombre</label><input id="r_name" value="'+esc(r.name||'')+'" autocomplete="off"></div>' +
    '<div class="grid2"><div class="field"><label class="f" for="r_serv">Raciones</label><input id="r_serv" inputmode="numeric" value="'+esc(r.servings||4)+'"></div>' +
    '<div class="field"><label class="f" for="r_use">Utilizar en</label><input id="r_use" value="'+esc(r.useIn||'Almuerzo, Cena')+'"></div></div>' +
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
  let kcal = Math.round(leerNum('r_kcal')), prot = leerNum('r_p'), carb = leerNum('r_c'), fat = leerNum('r_g'), peso = Math.round(leerNum('r_w'));
  if (!kcal && !prot && !carb && !fat) { // sin macros: se estiman desde los ingredientes
    const e = RPT_RECETAS.estimarMacros(ing, Math.max(parseInt($('#r_serv').value, 10) || 1, 1));
    kcal = e.kcal; prot = e.prot; carb = e.carb; fat = e.grasa; peso = peso || e.peso;
  }
  const datos = { name, servings:Math.max(parseInt($('#r_serv').value, 10) || 1, 1), useIn:($('#r_use').value || '').trim(), ingredients:ing,
    prep:($('#r_prep').value || '').trim(), kcal, prot, carb, fat, weight:peso,
    category:RPT_RECETAS.categorizar(kcal, prot, carb, fat), shared:$('#r_sh').checked, updatedMs:Date.now(),
    sinContar:RPT_RECETAS.estimarMacros(ing, Math.max(parseInt($('#r_serv').value, 10) || 1, 1)).noReconocidos };
  try {
    let nuevoId = null;
    if (id) await db.collection('nu_recipes').doc(id).update(datos);
    else nuevoId = (await db.collection('nu_recipes').add(Object.assign({ownerUid:S.user.uid, ownerName:S.user.displayName || (S.user.email||'').split('@')[0], createdMs:Date.now()}, datos))).id;
    await cargarRecetas();
    if (nuevoId && S.slotPend) { const sp = S.slotPend; S.slotPend = null; S.slot = sp; asignarASlot(nuevoId); return; }
  } catch(e){ $('#r_msg').textContent = 'No se pudo guardar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  siguienteDeCola();
}
function asignarASlot(rid){
  const r = recetaPorId(rid), p = pacienteActual(), sl = S.slot; if (!r || !p || !sl) { cerrarDlg(); render(); return; }
  const m0 = S.menu[sl.d].meals[sl.m];
  const pct = (repartoDe(p).find(x => x[0] === m0.slot) || [0,0])[1], obj = objetivoDia(p, sl.d);
  const s = obj && r.kcal > 0 ? escalaPara(r, {kcal:obj.kcal*pct/100}) : 1;
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
  S.cola = ok; siguienteDeCola(); render();
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
  Object.assign(c, {ownerUid:S.user.uid, ownerName:S.user.displayName || (S.user.email||'').split('@')[0], shared:false, copiedFrom:r.ownerUid, createdMs:Date.now(), updatedMs:Date.now()});
  try { await db.collection('nu_recipes').add(c); await cargarRecetas(); }
  catch(e){ $('#r_msg').textContent = 'No se pudo copiar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  cerrarDlg(); S.rtab = 'mias'; setRmsg('Copiada a tus recetas.', true); render();
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
// Al abrir un paciente: si tiene una competición en los próximos 45 días sin horas, pregunta una vez.
function preguntarHoras(p){
  S.preguntadas = S.preguntadas || {};
  const limite = sumaDias(iso(new Date()), 45);
  const c = compsProximas(p).find(x => x.date <= limite && (!x.weighIn || !x.start) && !S.preguntadas[p.id+'|'+x.key]);
  if (!c) return;
  S.preguntadas[p.id+'|'+c.key] = true; dlgComp(c.key, true);
}

/* ---------- acciones de vínculo ---------- */
function dlgVinculo(){
  abrirDlg('<h2>Vincular con WorkOut</h2><p class="sub" style="margin-bottom:14px">Escribe el correo con el que el paciente entra en WorkOut. Recibirá una solicitud al entrar en esta app y decidirá si la acepta.</p>' +
    '<div class="field"><label class="f" for="v_email">Correo del paciente</label><input id="v_email" type="email" inputmode="email" autocomplete="off"></div>' +
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
    case 'realDlg': S.realQ = ''; dlgReal(); break;
    case 'elegirReal': { const r = recetaPorId(t.dataset.id); if (r) { const m0 = S.menu[S.slot.d].meals[S.slot.m], plan = valsComida(m0);
        const sc = Math.round(clamp(plan.kcal/Math.max(r.kcal,1), 0.3, 3)*20)/20;
        cambiarSlot(m => { m.real = comidaDe(r, m.slot, sc); }, false, null, dlgReal); } break; }
    case 'noComi': cambiarSlot(m => { m.real = {none:true}; }, false, null, dlgReal); break;
    case 'quitarReal': cambiarSlot(m => { delete m.real; }, false, null, dlgReal); break;
    case 'escalaReal': cambiarSlot(m => { if (m.real && !m.real.none) m.real.s = Math.round(clamp(m.real.s + parseFloat(t.dataset.n), 0.3, 3)*20)/20; }, false, null, dlgReal); break;
    case 'proponerMenu':
      if (S.menu && S.menu.some(d => d.meals && d.meals.some(m => m.rid)) && !t.dataset.seguro) { t.dataset.seguro = '1'; t.textContent = '⚠ Pulsa otra vez: se sustituye el menú'; break; }
      proponerMenu(); break;
    case 'copiarSemana': dlgCopiarSemana(); break;
    case 'copiarDe': copiarDe(t.dataset.w); break;
    case 'repartoDlg': dlgReparto(); break;
    case 'fijasDlg': dlgFijas(); break;
    case 'guardarFijas': guardarFijas(t.dataset.todos === '1'); break;
    case 'guardarReparto': guardarReparto(); break;
    case 'slotMenu': S.slotQ = ''; S.slot = {d:parseInt(t.dataset.d,10), m:parseInt(t.dataset.m,10)}; dlgSlot(); break;
    case 'escalaSlot': cambiarSlot(m => { m.s = Math.round(clamp(m.s + parseFloat(t.dataset.n), 0.3, 3)*20)/20; }); break;
    case 'quitarSlot': cambiarSlot(m => { m.rid = null; delete m.name; }, true, 'Comida quitada.'); break;
    case 'elegirReceta': { const r = recetaPorId(t.dataset.id); if (r) { const p = pacienteActual(); const sl = S.slot; const m0 = S.menu[sl.d].meals[sl.m];
        const pct = (repartoDe(p).find(x => x[0] === m0.slot) || [0,0])[1], obj = objetivoDia(p, sl.d);
        const s = obj ? escalaPara(r, {kcal:obj.kcal*pct/100}) : 1;
        cambiarSlot(m => Object.assign(m, comidaDe(r, m.slot, s), {fija:false}), true, DIAS[sl.d]+' · '+m0.slot+': cambiado a '+r.name+'.'); } break; }
    case 'rtab': S.rtab = t.dataset.v; setRmsg(null); render(); break;
    case 'verReceta': dlgVerReceta(t.dataset.id); break;
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
  if (e.target && e.target.id === 'rq2') { S.realQ = e.target.value; dlgReal(); const n = $('#rq2'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } return; }
  if (e.target && e.target.id === 'sq') { S.slotQ = e.target.value; dlgSlot(); const n = $('#sq'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } return; } if (e.target && e.target.id === 'rq') { S.rq = e.target.value; render(); } });
document.addEventListener('change', e => {
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
    const ud = await ur.get();
    S.prefs = (ud.exists && ud.data().nuPrefs) || {};
    if (!ud.exists) await ur.set({email:u.email, name:u.displayName || (u.email||'').split('@')[0], createdAt:Date.now()});
    const g = await ur.collection('roleGrants').doc('nutritionist').get();
    S.isNutri = g.exists;
    try { await cargarSolicitudes(); } catch(e){ S.requests = []; }
    if (S.isNutri) { try { await cargarRecetas(); } catch(e){ S.recipes = []; console.error('recetas', e); } await cargarPacientes(); try { await cargarLinks(); } catch(e){ S.links = []; } S.view = 'app'; S.tab = 'pacientes'; }
    else S.view = 'activar';
  } catch(e){ S.view = 'activar'; setMsg('No se pudieron leer tus datos. Comprueba la conexión.', false); }
  render();
});
render();
})();
