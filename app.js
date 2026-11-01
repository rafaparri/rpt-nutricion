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
  msg:null, msgOk:false, busy:false
};
const refPac = pid => db.collection('nu_patients').doc(pid);
const pacienteActual = () => S.patients.find(p => p.id === S.pid);

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
    '<h1>Bienvenido</h1>' +
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
  return '<div class="crumbs"><b>Pacientes</b></div><div class="content"><h1>Pacientes</h1>'+lista+
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
    '<div class="card"><h3>Datos</h3><p class="sub">'+esc([p.sex, p.birthYear ? 'nacido en '+p.birthYear : '', p.heightCm ? p.heightCm+' cm' : '', p.goal ? 'Objetivo: '+p.goal : ''].filter(Boolean).join(' · ') || 'Sin datos')+'</p>' +
    (p.notes ? '<p style="margin:8px 0 0">'+esc(p.notes)+'</p>' : '') + '</div>' +
    '<div class="btn-row"><button class="btn secondary" data-act="editar">Editar datos</button><button class="btn danger" data-act="borrar">Eliminar</button></div>';
}
function vSemana(p){
  const lv = S.levels || [0,0,0,0,0,0,0];
  const fin = sumaDias(S.weekStart, 6);
  const filas = DIAS.map((d,i) =>
    '<div class="weekrow"><div class="day">'+d+'<span class="sub">'+fechaCorta(sumaDias(S.weekStart,i)).slice(0,5)+'</span></div><div class="levels">' +
    [1,2,3,4].map(l => '<button data-l="'+l+'" data-act="nivel" data-d="'+i+'" aria-pressed="'+(lv[i]===l)+'"><span class="bars"><i></i><i></i><i></i><i></i></span>'+NIVELES[l-1]+'</button>').join('') +
    '</div></div>').join('');
  return '<div class="weekhead"><button class="btn secondary" data-act="semana" data-n="-7" aria-label="Semana anterior">‹</button>' +
    '<div class="t">'+fechaCorta(S.weekStart).slice(0,5)+' – '+fechaCorta(fin).slice(0,5)+'</div>' +
    '<button class="btn secondary" data-act="semana" data-n="7" aria-label="Semana siguiente">›</button></div>' +
    '<div class="card"><h3 style="margin-bottom:0">Intensidad de entreno</h3><p class="sub">Elige un nivel para cada día. Se guarda al tocar.</p>'+filas+'</div>'+msgHtml();
}
function vRecetario(){
  return '<div class="crumbs"><b>Recetario</b></div><div class="content"><h1>Recetario</h1><div class="card"><p class="sub">Aquí estará el recetario compartido. Es la siguiente fase.</p></div></div>';
}
function vCuenta(){
  return '<div class="crumbs"><b>Cuenta</b></div><div class="content"><h1>Cuenta</h1>' +
    '<div class="card"><p class="sub">Sesión iniciada como</p><b>'+esc(S.user.email)+'</b></div>' +
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
  const antes = document.activeElement && document.activeElement.id;
  const val = antes && document.activeElement.value;
  $('#root').innerHTML = html;
  if (antes && $('#'+antes) && val != null) { $('#'+antes).value = val; }
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
    '<div class="field"><label class="f" for="d_goal">Objetivo</label><input id="d_goal" value="'+esc(v.goal||'')+'" placeholder="Bajar, mantener…"></div></div>' +
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
async function cargarPesos(){
  const snap = await refPac(S.pid).collection('weights').orderBy(firebase.firestore.FieldPath.documentId(),'desc').limit(8).get();
  S.weights = snap.docs.map(d => Object.assign({id:d.id}, d.data()));
}
async function cargarSemana(){
  const d = await refPac(S.pid).collection('weeks').doc(S.weekStart).get();
  S.levels = d.exists && Array.isArray(d.data().levels) ? d.data().levels : null;
}
async function abrirPaciente(id){
  S.pid = id; S.ptab = 'resumen'; S.weights = []; S.levels = null; S.weekStart = lunesISO(new Date()); setMsg(null);
  render();
  try { await cargarPesos(); } catch(e){ setMsg('No se pudo leer el peso.', false); }
  render();
}
async function guardarPaciente(id){
  const g = x => ($('#'+x).value || '').trim();
  const name = g('d_name');
  if (!name){ $('#d_msg').textContent = 'Escribe el nombre.'; return; }
  const num = x => { const n = parseInt(g(x),10); return isFinite(n) ? n : null; };
  const h = num('d_h'), y = num('d_year');
  if (h !== null && (h < 80 || h > 250)){ $('#d_msg').textContent = 'La altura debe estar entre 80 y 250 cm.'; return; }
  if (y !== null && (y < 1900 || y > new Date().getFullYear())){ $('#d_msg').textContent = 'Año de nacimiento no válido.'; return; }
  const datos = { name, sex:g('d_sex'), birthYear:y, heightCm:h, goal:g('d_goal'), notes:g('d_notes') };
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
    setMsg('Guardado.', true); await cargarPesos();
  } catch(e){ setMsg('No se pudo guardar. Inténtalo de nuevo.', false); }
  render();
}
async function ponerNivel(dia, nivel){
  const lv = (S.levels || [0,0,0,0,0,0,0]).slice(); lv[dia] = nivel; S.levels = lv; setMsg(null); render();
  try { await refPac(S.pid).collection('weeks').doc(S.weekStart).set({levels:lv, updatedAt:firebase.firestore.FieldValue.serverTimestamp()}, {merge:true}); }
  catch(e){ setMsg('No se pudo guardar la semana. Inténtalo de nuevo.', false); render(); }
}
async function cambiarSemana(n){
  S.weekStart = sumaDias(S.weekStart, n); S.levels = null; setMsg(null); render();
  try { await cargarSemana(); } catch(e){ setMsg('No se pudo leer la semana.', false); }
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
    S.isNutri = true; await cargarPacientes(); S.view = 'app'; S.tab = 'pacientes'; setMsg(null);
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
  }
});
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
    if (S.isNutri) { await cargarPacientes(); S.view = 'app'; S.tab = 'pacientes'; }
    else S.view = 'activar';
  } catch(e){ S.view = 'activar'; setMsg('No se pudieron leer tus datos. Comprueba la conexión.', false); }
  render();
});
render();
})();
