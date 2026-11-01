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
  patients:[], pid:null, ptab:'resumen',
  weights:[], weekStart:lunesISO(new Date()), levels:null,
  links:[], requests:[], wo:{}, woPlanId:null, woMsg:null,
  recipes:[], sharedRecipes:[], rtab:'mias', rq:'', cola:[], rmsg:null,
  menu:null, slot:null,
  msg:null, msgOk:false, busy:false
};
const refPac = pid => db.collection('nu_patients').doc(pid);
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
  return '<header class="topbar"><div class="brand"><span class="appicon">🥗</span><span>Nutrición</span></div>' +
    (S.user ? '<button class="user" data-act="tab" data-v="cuenta">'+esc((S.user.email||'').split('@')[0])+' ▾</button>' : '') + '</header>';
}
function bottomNav(){
  const items = [['pacientes','👥','Pacientes'],['recetario','📖','Recetario'],['cuenta','⚙️','Cuenta']];
  return '<nav class="bottomnav">' + items.map(i =>
    '<button data-act="tab" data-v="'+i[0]+'"'+(S.tab===i[0]&&!S.pid?' aria-current="page"':'')+'><span class="ico">'+i[1]+'</span>'+i[2]+'</button>').join('') + '</nav>';
}
function msgHtml(){ return S.msg ? '<div class="msg '+(S.msgOk?'ok':'err')+'">'+esc(S.msg)+'</div>' : '<div class="msg"></div>'; }

function vLogin(){
  return '<div class="app">'+topBar()+'<div class="login">' +
    '<div class="center"><span class="appicon" style="margin:0 auto 12px">🥗</span><h1>RPT Nutrición</h1><p class="sub">Entra con la misma cuenta que usas en WorkOut, o crea una nueva.</p></div>' +
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
  const tabs = '<div class="tabs" role="tablist"><button role="tab" data-act="ptab" data-v="resumen" aria-selected="'+(S.ptab==='resumen')+'">Resumen</button>' +
    '<button role="tab" data-act="ptab" data-v="semana" aria-selected="'+(S.ptab==='semana')+'">Semana</button></div>';
  return '<div class="crumbs"><a href="#" data-act="volver">Pacientes</a> › <b>'+esc(p.name)+'</b></div><div class="content">' +
    '<button class="btn small secondary" style="width:fit-content" data-act="volver">‹ Volver</button><h1>'+esc(p.name)+'</h1>' + tabs +
    (S.ptab==='resumen' ? vResumen(p) : vSemana(p)) + '</div>';
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
  return {kcal:Math.round(kcal/10)*10, prot:Math.round(prot), carb:Math.round(carb), grasa:Math.round(grasa), nota, carbKg:carb/kg};
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
function puntua(r, t, usos, previa, delDia){
  const s = escalaPara(r, t);
  const e = Math.abs(r.prot*s - t.prot)/Math.max(t.prot, 10) + Math.abs(r.carb*s - t.carb)/Math.max(t.carb, 15) + Math.abs(r.fat*s - t.fat)/Math.max(t.fat, 8);
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
async function guardarMenu(){
  try {
    const limpio = JSON.parse(JSON.stringify(S.menu));
    await refPac(S.pid).collection('weeks').doc(S.weekStart).set({menu:limpio, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
    return true;
  } catch(e){ setMsg('No se pudo guardar el menú ('+((e && (e.code||e.message)) || 'error')+'). Lo que ves no está guardado.', false); console.error('menu', e); render(); return false; }
}
async function proponerMenu(){
  const p = pacienteActual(); if (!p) return;
  if (!S.recipes.length) { setMsg('Primero necesitas recetas en el Recetario.', false); render(); return; }
  const rep = repartoDe(p), usos = {}, menu = [];
  for (let i = 0; i < 7; i++) {
    const obj = objetivoDia(p, i), meals = [], hoy = {};
    if (obj) rep.forEach(([slot, pct]) => {
      const t = {kcal:obj.kcal*pct/100, prot:obj.prot*pct/100, carb:obj.carb*pct/100, fat:obj.fat*pct/100};
      const previa = menu[i-1] && (menu[i-1].meals.find(m => m.slot === slot) || {}).rid;
      const mejor = candidatas(slot).map(r => ({r, sc:puntua(r, t, usos, previa, hoy)})).sort((a,b) => a.sc - b.sc)[0];
      if (mejor) { usos[mejor.r.id] = (usos[mejor.r.id]||0) + 1; hoy[mejor.r.id] = true; meals.push(comidaDe(mejor.r, slot, escalaPara(mejor.r, t))); }
      else meals.push({slot, rid:null});
    });
    menu.push({meals});
  }
  S.menu = menu; setMsg('Menú propuesto. Toca cualquier comida para cambiarla.', true); render(); await guardarMenu();
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
    '<div class="btn-row"><button class="btn" data-act="proponerMenu">'+(hay ? '🔄 Proponer de nuevo' : '✨ Proponer menú')+'</button><button class="btn secondary" data-act="repartoDlg">Reparto</button></div></div>';
  if (!hay) return html;
  html += DIAS.map((d, i) => {
    const dia = S.menu[i]; if (!dia || !dia.meals || !dia.meals.length) return '';
    const obj = objetivoDia(p, i), tot = totalDia(dia);
    const filas = dia.meals.map((m, j) => {
      if (!m.rid) return '<button class="row" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'"><div class="grow"><b>'+esc(m.slot)+'</b><p class="sub">Sin receta · toca para elegir</p></div><span class="chev">＋</span></button>';
      const v = valsComida(m);
      return '<button class="row" data-act="slotMenu" data-d="'+i+'" data-m="'+j+'"><div class="grow"><b>'+esc(m.slot)+'</b> · '+esc(m.name)+
        '<p class="sub">ración ×'+kgTxt(Math.round(m.s*100)/100)+(m.bw ? ' · '+Math.round(v.g)+' g' : '')+' · '+Math.round(v.kcal)+' kcal · P '+r1(v.prot)+' · C '+r1(v.carb)+' · G '+r1(v.fat)+'</p></div><span class="chev">›</span></button>';
    }).join('');
    return '<div class="card"><h3 style="margin-bottom:2px">'+d+' · '+NIVELES[S.levels[i]-1]+'</h3>' +
      '<p class="sub" style="margin-bottom:8px">Total '+Math.round(tot.kcal)+' de '+(obj ? obj.kcal : '?')+' kcal · P '+Math.round(tot.prot)+'/'+(obj ? obj.prot : '?')+' · C '+Math.round(tot.carb)+'/'+(obj ? obj.carb : '?')+' · G '+Math.round(tot.fat)+'/'+(obj ? obj.fat : '?')+'</p>' +
      '<div class="list">'+filas+'</div></div>';
  }).join('');
  return html;
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
  const lista = buscador + (cands.length ? '<h3 style="margin:6px 0">'+(q ? 'Resultados' : 'Recetas que encajan')+'</h3><div class="list">' + cands.filter(r => r.id !== m.rid).map(r => {
    const s = t ? escalaPara(r, t) : 1;
    return '<button class="row" data-act="elegirReceta" data-id="'+esc(r.id)+'"><div class="grow"><b>'+esc(r.name)+'</b><p class="sub">ración ×'+kgTxt(s)+' · '+Math.round(r.kcal*s)+' kcal · P '+r1(r.prot*s)+' · C '+r1(r.carb*s)+' · G '+r1(r.fat*s)+'</p></div><span class="chev">›</span></button>';
  }).join('') + '</div>' : '<div class="empty">'+(q ? 'Ninguna receta coincide.' : 'No hay recetas para esta comida. Añade recetas en el Recetario.')+'</div>');
  abrirDlg(cabecera + actual + lista + '<button class="btn ghost" style="margin-top:12px" data-act="cerrar">Cerrar</button>');
}
async function cambiarSlot(fn, cerrar, aviso){
  const sl = S.slot; if (!sl) return;
  fn(S.menu[sl.d].meals[sl.m]);
  if (cerrar) { cerrarDlg(); S.slotQ = ''; } else dlgSlot();
  if (aviso) setMsg(aviso, true);
  render();
  const ok = await guardarMenu();
  if (ok && aviso) { render(); }
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
function vSemana(p){
  const lv = S.levels || [0,0,0,0,0,0,0];
  const fin = sumaDias(S.weekStart, 6);
  const filas = DIAS.map((d,i) =>
    '<div class="weekrow"><div class="day">'+d+'<span class="sub">'+fechaCorta(sumaDias(S.weekStart,i)).slice(0,5)+'</span></div><div class="levels">' +
    [1,2,3,4].map(l => '<button data-l="'+l+'" data-act="nivel" data-d="'+i+'" aria-pressed="'+(lv[i]===l)+'"><span class="bars"><i></i><i></i><i></i><i></i></span>'+NIVELES[l-1]+'</button>').join('') +
    '</div></div>').join('');
  return vWorkOutSemana(p) + '<div class="weekhead"><button class="btn secondary" data-act="semana" data-n="-7" aria-label="Semana anterior">‹</button>' +
    '<div class="t">'+fechaCorta(S.weekStart).slice(0,5)+' – '+fechaCorta(fin).slice(0,5)+'</div>' +
    '<button class="btn secondary" data-act="semana" data-n="7" aria-label="Semana siguiente">›</button></div>' +
    msgHtml() +
    '<div class="card"><h3 style="margin-bottom:0">Intensidad de entreno</h3><p class="sub">Elige un nivel para cada día. Se guarda al tocar.</p>'+filas+'</div>'+vMacros(p)+vMenu(p);
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
    '<p class="sub">'+esc([r.category, r.useIn].filter(Boolean).join(' · '))+(S.rtab==='mias' && r.shared ? ' · 🔗 compartida' : '')+(S.rtab==='compartidas' ? ' · de '+esc(r.ownerName||'otro nutricionista') : '')+'</p></div><span class="chev">›</span></button>').join('') + '</div>'
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
    const cuerpo = S.pid ? vPaciente() : (S.tab==='recetario' ? vRecetario() : S.tab==='cuenta' ? vCuenta() : vPacientes());
    html = '<div class="app">'+topBar()+cuerpo+bottomNav()+'</div>';
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
function cerrarDlg(){ $('#dlg').classList.remove('open'); }
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
}
async function abrirPaciente(id){
  S.pid = id; S.ptab = 'resumen'; S.weights = []; S.levels = null; S.menu = null; S.weekStart = lunesISO(new Date()); setMsg(null);
  render();
  const l0 = linkDe(id); if (l0 && l0.status === 'accepted') await leerWorkOut(id);
  try { await cargarPesos(); } catch(e){ setMsg('No se pudo leer el peso (' + ((e && (e.code || e.message)) || 'error') + ').', false); console.error('pesos', e); }
  render();
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
async function guardarPeso(){
  const kg = parseFloat(String(($('#kg').value||'')).replace(',','.'));
  if (!(kg >= 20 && kg <= 300)){ setMsg('Escribe un peso entre 20 y 300 kg.', false); render(); return; }
  try {
    await refPac(S.pid).collection('weights').doc(iso(new Date())).set({kg:Math.round(kg*10)/10, by:'nutricion', byUid:S.user.uid, at:firebase.firestore.FieldValue.serverTimestamp()});
    const l = linkDe(S.pid);
    if (l && l.status === 'accepted' && l.patientUid) {
      try { await db.collection('users').doc(l.patientUid).collection('bodyLog').doc(iso(new Date())).set({kg:Math.round(kg*10)/10, by:'nutricion', byUid:S.user.uid, at:firebase.firestore.FieldValue.serverTimestamp()}); }
      catch(e){ console.error('bodyLog', e); }
    }
    setMsg('Guardado.', true); await cargarPesos();
  } catch(e){ setMsg('No se pudo guardar (' + ((e && (e.code || e.message)) || 'error') + ').', false); console.error('peso', e); }
  render();
}
async function ponerNivel(dia, nivel){
  const lv = (S.levels || [0,0,0,0,0,0,0]).slice(); lv[dia] = nivel; S.levels = lv; setMsg(null); render();
  try { await refPac(S.pid).collection('weeks').doc(S.weekStart).set({levels:lv, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}, {merge:true}); }
  catch(e){ setMsg('No se pudo guardar la semana. Inténtalo de nuevo.', false); render(); }
}
async function cambiarSemana(n){
  S.weekStart = sumaDias(S.weekStart, n); S.levels = null; S.menu = null; setMsg(null); render();
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
  $('#r_msg').textContent = e.noReconocidos.length ? 'Calculado. No se han reconocido: '+e.noReconocidos.join(', ')+'.' : 'Calculado.';
}
async function guardarReceta(id){
  const name = ($('#r_name').value || '').trim();
  const ing = $('#r_ing').value.split('\n').map(x => x.trim()).filter(Boolean);
  if (!name) { $('#r_msg').textContent = 'Escribe el nombre.'; return; }
  if (!ing.length) { $('#r_msg').textContent = 'Escribe al menos un ingrediente.'; return; }
  const kcal = Math.round(leerNum('r_kcal')), prot = leerNum('r_p'), carb = leerNum('r_c'), fat = leerNum('r_g');
  const datos = { name, servings:Math.max(parseInt($('#r_serv').value, 10) || 1, 1), useIn:($('#r_use').value || '').trim(), ingredients:ing,
    prep:($('#r_prep').value || '').trim(), kcal, prot, carb, fat, weight:Math.round(leerNum('r_w')),
    category:RPT_RECETAS.categorizar(kcal, prot, carb, fat), shared:$('#r_sh').checked, updatedMs:Date.now() };
  try {
    if (id) await db.collection('nu_recipes').doc(id).update(datos);
    else await db.collection('nu_recipes').add(Object.assign({ownerUid:S.user.uid, ownerName:S.user.displayName || (S.user.email||'').split('@')[0], createdMs:Date.now()}, datos));
    await cargarRecetas();
  } catch(e){ $('#r_msg').textContent = 'No se pudo guardar ('+((e && (e.code||e.message)) || 'error')+').'; return; }
  siguienteDeCola();
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
    case 'tab': S.tab = t.dataset.v; S.pid = null; setMsg(null); render(); break;
    case 'abrir': abrirPaciente(t.dataset.id); break;
    case 'volver': S.pid = null; setMsg(null); render(); break;
    case 'nuevo': dlgPaciente(null); break;
    case 'editar': dlgPaciente(pacienteActual()); break;
    case 'guardarPaciente': guardarPaciente(t.dataset.id); break;
    case 'cerrar': cerrarDlg(); break;
    case 'borrar': borrarPaciente(); break;
    case 'borrarSeguro': borrarSeguro(); break;
    case 'ptab': S.ptab = t.dataset.v; setMsg(null); render(); if (S.ptab==='semana') cambiarSemana(0); break;
    case 'guardarPeso': guardarPeso(); break;
    case 'nivel': ponerNivel(parseInt(t.dataset.d,10), parseInt(t.dataset.l,10)); break;
    case 'semana': cambiarSemana(parseInt(t.dataset.n,10)); break;
    case 'recargar': recargar(); break;
    case 'vincular': dlgVinculo(); break;
    case 'proponerMenu': proponerMenu(); break;
    case 'repartoDlg': dlgReparto(); break;
    case 'guardarReparto': guardarReparto(); break;
    case 'slotMenu': S.slotQ = ''; S.slot = {d:parseInt(t.dataset.d,10), m:parseInt(t.dataset.m,10)}; dlgSlot(); break;
    case 'escalaSlot': cambiarSlot(m => { m.s = Math.round(clamp(m.s + parseFloat(t.dataset.n), 0.3, 3)*20)/20; }); break;
    case 'quitarSlot': cambiarSlot(m => { m.rid = null; delete m.name; }, true, 'Comida quitada.'); break;
    case 'elegirReceta': { const r = recetaPorId(t.dataset.id); if (r) { const p = pacienteActual(); const sl = S.slot; const m0 = S.menu[sl.d].meals[sl.m];
        const pct = (repartoDe(p).find(x => x[0] === m0.slot) || [0,0])[1], obj = objetivoDia(p, sl.d);
        const s = obj ? escalaPara(r, {kcal:obj.kcal*pct/100}) : 1;
        cambiarSlot(m => Object.assign(m, comidaDe(r, m.slot, s)), true, DIAS[sl.d]+' · '+m0.slot+': cambiado a '+r.name+'.'); } break; }
    case 'rtab': S.rtab = t.dataset.v; setRmsg(null); render(); break;
    case 'verReceta': dlgVerReceta(t.dataset.id); break;
    case 'nuevaReceta': S.cola = []; dlgFormReceta(null, 0); break;
    case 'importarWord': { const i = $('#docxIn'); if (i) i.click(); break; }
    case 'editarReceta': S.cola = []; dlgFormReceta(recetaPorId(t.dataset.id), 0); break;
    case 'calcReceta': calcReceta(); break;
    case 'guardarReceta': guardarReceta(t.dataset.id); break;
    case 'cerrarReceta': if (S.cola.length) siguienteDeCola(); else cerrarDlg(); break;
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
