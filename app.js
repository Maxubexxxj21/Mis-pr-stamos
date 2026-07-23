/* ============================================================
   MIS PRÉSTAMOS - Lógica de la aplicación
   Almacenamiento 100% local (localStorage). Sin servidores.
   ============================================================ */

const STORAGE_KEY = 'prestamos_data_v1';
const MAX_ATTACHMENT_MB = 4; // límite por archivo, para no saturar localStorage
const MAX_ATTACHMENTS_PER_CLIENT = 6;

/* ---------- Utilidades generales ---------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { clients: [] };
    const parsed = JSON.parse(raw);
    if (!parsed.clients) return { clients: [] };
    return parsed;
  } catch (e) {
    console.error('Error leyendo datos', e);
    return { clients: [] };
  }
}

function saveData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error('Error guardando datos', e);
    showToastSafe('No se pudo guardar: el almacenamiento está lleno. Elimina algún adjunto pesado o exporta y limpia respaldos antiguos.');
    return false;
  }
}

function showToastSafe(msg) {
  if (typeof showToast === 'function') showToast(msg);
  else alert(msg);
}

let DB = loadData();

function money(n) {
  if (isNaN(n)) return 'S/. 0.00';
  return 'S/. ' + n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Suma "months" meses a una fecha ISO (YYYY-MM-DD), ajustando el día
// si el mes destino tiene menos días (ej. 31 de enero + 1 mes = 28/29 feb).
function addMonths(dateISO, months) {
  const d = new Date(dateISO + 'T00:00:00');
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInTarget));
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/* ---------- Validaciones ---------- */

function validateClientForm(f) {
  const errors = {};
  if (!f.name || f.name.trim().length < 2) errors.name = 'Escribe el nombre completo del cliente.';
  if (isNaN(f.principal) || f.principal <= 0) errors.principal = 'El monto prestado debe ser mayor a cero.';
  if (isNaN(f.rate) || f.rate <= 0) errors.rate = 'La tasa de interés debe ser mayor a cero.';
  if (!f.startDate) errors.startDate = 'Elige la fecha de inicio.';
  if (isNaN(f.months) || f.months <= 0 || !Number.isInteger(f.months)) errors.months = 'El número de meses debe ser un entero mayor a cero.';
  if (isNaN(f.paymentDay) || f.paymentDay < 1 || f.paymentDay > 31) errors.paymentDay = 'El día de pago debe estar entre 1 y 31.';
  return errors;
}

/* ============================================================
   CÁLCULO DE CUOTAS
   ============================================================ */

// MÓDULO 1: Solo interés mensual, capital al final.
// Ejemplo validación: Capital 100, tasa 10%, 5 meses ->
//   meses 1-4: 10 soles (interés). Mes 5: 10 + 100 = 110 soles.
function buildModule1Schedule(principal, rate, months, startDate, paymentDay, fromNumber = 1) {
  const schedule = [];
  const interest = round2(principal * (rate / 100));
  for (let i = fromNumber; i <= months; i++) {
    const due = dueDateFor(startDate, paymentDay, i);
    const isLast = i === months;
    schedule.push({
      number: i,
      dueDate: due,
      amortization: isLast ? principal : 0,
      interest: interest,
      total: isLast ? round2(interest + principal) : interest,
      status: 'pendiente',
      paidDate: null,
      paidAmount: null
    });
  }
  return schedule;
}

// MÓDULO 2 - MÉTODO 1 (predeterminado): interés fijo sobre capital ORIGINAL
// del ciclo vigente, amortización fija, cuota constante.
// Ejemplo validación: Capital 100, tasa 10%, 5 meses ->
//   Amortización = 100/5 = 20 soles/mes
//   Interés = 100 * 10% = 10 soles/mes (constante)
//   Cuota = 30 soles/mes, los 5 meses.
function buildModule2FixedSchedule(balance, rate, months, startDate, paymentDay, fromNumber = 1) {
  const schedule = [];
  const amortization = round2(balance / months);
  const interest = round2(balance * (rate / 100));
  let runningBalance = balance;
  for (let i = fromNumber; i < fromNumber + months; i++) {
    const due = dueDateFor(startDate, paymentDay, i - fromNumber + 1);
    const isLast = i === fromNumber + months - 1;
    const amort = isLast ? round2(runningBalance) : amortization;
    runningBalance = round2(runningBalance - amort);
    schedule.push({
      number: i,
      dueDate: due,
      amortization: amort,
      interest: interest,
      total: round2(amort + interest),
      status: 'pendiente',
      paidDate: null,
      paidAmount: null,
      balanceAfter: runningBalance
    });
  }
  return schedule;
}

// MÓDULO 2 - MÉTODO 2 (alternativo, no predeterminado): interés sobre saldo
// decreciente. Amortización fija, interés y cuota total decrecen cada mes.
// Ejemplo: Capital 100, tasa 10%, 5 meses ->
//   Amortización = 20 soles/mes (fija)
//   Mes1: interés=10 (10% de 100), cuota=30, saldo=80
//   Mes2: interés=8  (10% de 80),  cuota=28, saldo=60 ... etc.
function buildModule2DecliningSchedule(balance, rate, months, startDate, paymentDay, fromNumber = 1) {
  const schedule = [];
  const amortization = round2(balance / months);
  let runningBalance = balance;
  for (let i = fromNumber; i < fromNumber + months; i++) {
    const due = dueDateFor(startDate, paymentDay, i - fromNumber + 1);
    const isLast = i === fromNumber + months - 1;
    const interest = round2(runningBalance * (rate / 100));
    const amort = isLast ? round2(runningBalance) : amortization;
    runningBalance = round2(runningBalance - amort);
    schedule.push({
      number: i,
      dueDate: due,
      amortization: amort,
      interest: interest,
      total: round2(amort + interest),
      status: 'pendiente',
      paidDate: null,
      paidAmount: null,
      balanceAfter: runningBalance
    });
  }
  return schedule;
}

function dueDateFor(startDate, paymentDay, installmentNumber) {
  const base = new Date(startDate + 'T00:00:00');
  const y = base.getFullYear();
  const m = base.getMonth();
  const iso = new Date(y, m, 1).toISOString().slice(0, 10);
  const withDay = setDaySafe(iso, paymentDay);
  return addMonths(withDay, installmentNumber);
}

function setDaySafe(monthISO, day) {
  const d = new Date(monthISO + 'T00:00:00');
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInMonth));
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* ---------- Generación / regeneración de cronograma ---------- */

function generateFullSchedule(client) {
  if (client.module === 1) {
    return buildModule1Schedule(client.principal, client.rate, client.months, client.startDate, client.paymentDay, 1);
  }
  if (client.method === 'declining') {
    return buildModule2DecliningSchedule(client.principal, client.rate, client.months, client.startDate, client.paymentDay, 1);
  }
  return buildModule2FixedSchedule(client.principal, client.rate, client.months, client.startDate, client.paymentDay, 1);
}

// Recalcula únicamente las cuotas NO pagadas a partir de un nuevo saldo,
// conservando intactas las cuotas ya pagadas.
function regenerateRemaining(client, newBalance, newRemainingMonths) {
  const paid = client.installments.filter((i) => i.status === 'pagado');
  const lastPaidNumber = paid.length ? Math.max(...paid.map((i) => i.number)) : 0;
  const nextNumber = lastPaidNumber + 1;

  let remainingSchedule;
  if (client.module === 1) {
    remainingSchedule = buildModule1Schedule(newBalance, client.rate, newRemainingMonths, client.startDate, client.paymentDay, 1)
      .map((inst, idx) => ({ ...inst, number: nextNumber + idx, dueDate: dueDateFromToday(client, nextNumber + idx - lastPaidNumber) }));
  } else if (client.method === 'declining') {
    remainingSchedule = buildModule2DecliningSchedule(newBalance, client.rate, newRemainingMonths, client.startDate, client.paymentDay, 1)
      .map((inst, idx) => ({ ...inst, number: nextNumber + idx, dueDate: dueDateFromToday(client, nextNumber + idx - lastPaidNumber) }));
  } else {
    remainingSchedule = buildModule2FixedSchedule(newBalance, client.rate, newRemainingMonths, client.startDate, client.paymentDay, 1)
      .map((inst, idx) => ({ ...inst, number: nextNumber + idx, dueDate: dueDateFromToday(client, nextNumber + idx - lastPaidNumber) }));
  }
  client.installments = [...paid, ...remainingSchedule];
  client.months = client.installments.length;
}

function dueDateFromToday(client, monthsAhead) {
  const base = setDaySafe(todayISO().slice(0, 8) + '01', client.paymentDay);
  return addMonths(base, monthsAhead);
}

function currentBalance(client) {
  if (client.module === 1) return client.principal;
  const unpaid = client.installments.filter((i) => i.status !== 'pagado');
  if (unpaid.length === 0) return 0;
  const prevPaid = client.installments.filter((i) => i.status === 'pagado');
  const amortPaid = prevPaid.reduce((s, i) => s + i.amortization, 0);
  return round2(client.principal - amortPaid);
}

// GANANCIA TOTAL: suma de todo el interés cobrado a lo largo del préstamo
// (cronograma completo vigente, incluyendo cuotas ya pagadas y las que faltan).
function calcTotalGain(client) {
  return round2(client.installments.reduce((sum, inst) => sum + inst.interest, 0));
}

// Ganancia ya cobrada (solo cuotas efectivamente pagadas).
function calcGainCollected(client) {
  return round2(client.installments.filter((i) => i.status === 'pagado').reduce((sum, inst) => sum + inst.interest, 0));
}

/* ---------- Estado de cuotas (pendiente/pagado/atrasado) ---------- */

function refreshStatuses(client) {
  const today = todayISO();
  client.installments.forEach((inst) => {
    if (inst.status === 'pagado') return;
    inst.status = inst.dueDate < today ? 'atrasado' : 'pendiente';
  });
}

function clientOverallStatus(client) {
  refreshStatuses(client);
  const hasOverdue = client.installments.some((i) => i.status === 'atrasado');
  const allPaid = client.installments.every((i) => i.status === 'pagado');
  if (allPaid) return 'finalizado';
  if (hasOverdue) return 'atrasado';
  return 'al_dia';
}

/* ============================================================
   OPERACIONES SOBRE CLIENTES
   ============================================================ */

function createClient(form, attachments) {
  const client = {
    id: uid(),
    name: form.name.trim(),
    module: form.module,
    method: form.module === 2 ? (form.method || 'fixed') : null,
    principal: form.principal,
    rate: form.rate,
    startDate: form.startDate,
    months: form.months,
    paymentDay: form.paymentDay,
    notes: form.notes || '',
    createdAt: todayISO(),
    ledger: [{ date: form.startDate, type: 'origen', amount: form.principal, note: 'Préstamo original' }],
    installments: [],
    attachments: attachments || []
  };
  client.installments = generateFullSchedule(client);
  DB.clients.push(client);
  saveData(DB);
  return client;
}

function updateClientBasicInfo(id, form) {
  const client = DB.clients.find((c) => c.id === id);
  if (!client) return;
  client.name = form.name.trim();
  client.notes = form.notes || '';
  client.paymentDay = form.paymentDay;
  const hasPayments = client.installments.some((i) => i.status === 'pagado');
  if (!hasPayments) {
    client.principal = form.principal;
    client.rate = form.rate;
    client.months = form.months;
    client.startDate = form.startDate;
    client.method = client.module === 2 ? (form.method || 'fixed') : null;
    client.installments = generateFullSchedule(client);
    client.ledger[0] = { date: form.startDate, type: 'origen', amount: form.principal, note: 'Préstamo original' };
  }
  saveData(DB);
}

function deleteClient(id) {
  DB.clients = DB.clients.filter((c) => c.id !== id);
  saveData(DB);
}

function registerPayment(clientId, installmentNumber, paidDate, paidAmount) {
  const client = DB.clients.find((c) => c.id === clientId);
  const inst = client.installments.find((i) => i.number === installmentNumber);
  if (!inst) return;
  inst.status = 'pagado';
  inst.paidDate = paidDate;
  inst.paidAmount = paidAmount;
  client.ledger.push({ date: paidDate, type: 'pago', amount: paidAmount, note: `Cuota N° ${installmentNumber}` });
  saveData(DB);
}

function undoPayment(clientId, installmentNumber) {
  const client = DB.clients.find((c) => c.id === clientId);
  const inst = client.installments.find((i) => i.number === installmentNumber);
  if (!inst) return;
  inst.status = inst.dueDate < todayISO() ? 'atrasado' : 'pendiente';
  inst.paidDate = null;
  inst.paidAmount = null;
  saveData(DB);
}

function registerExtraLoan(clientId, amount, date, note) {
  const client = DB.clients.find((c) => c.id === clientId);
  const balance = currentBalance(client);
  const newBalance = round2(balance + amount);
  const remainingMonths = client.installments.filter((i) => i.status !== 'pagado').length || client.months;

  if (client.module === 1) {
    client.principal = newBalance;
    client.installments = generateFullScheduleKeepingPaid(client);
  } else {
    regenerateRemaining(client, newBalance, remainingMonths);
    client.principal = newBalance;
  }
  client.ledger.push({ date, type: 'ampliacion', amount, note: note || 'Ampliación de préstamo' });
  saveData(DB);
}

function generateFullScheduleKeepingPaid(client) {
  const paid = client.installments.filter((i) => i.status === 'pagado');
  const lastPaidNumber = paid.length ? Math.max(...paid.map((i) => i.number)) : 0;
  const remainingMonths = client.months - paid.length;
  const rest = buildModule1Schedule(client.principal, client.rate, remainingMonths, client.startDate, client.paymentDay, 1)
    .map((inst, idx) => ({ ...inst, number: lastPaidNumber + 1 + idx, dueDate: dueDateFromToday(client, idx + 1) }));
  return [...paid, ...rest];
}

function registerPrepayment(clientId, amount, date, choice, note) {
  const client = DB.clients.find((c) => c.id === clientId);
  const balance = currentBalance(client);
  const newBalance = round2(Math.max(balance - amount, 0));

  if (client.module === 1) {
    client.principal = newBalance;
    client.installments = generateFullScheduleKeepingPaid(client);
  } else {
    const currentRemainingMonths = client.installments.filter((i) => i.status !== 'pagado').length;
    const currentQuota = client.installments.find((i) => i.status !== 'pagado');
    let newRemainingMonths = currentRemainingMonths;

    if (newBalance <= 0) {
      newRemainingMonths = 0;
    } else if (choice === 'reduce_months') {
      const approxAmort = currentQuota ? currentQuota.amortization : (newBalance / currentRemainingMonths);
      newRemainingMonths = Math.max(1, Math.ceil(newBalance / (approxAmort || newBalance)));
    } else {
      newRemainingMonths = currentRemainingMonths;
    }

    if (newBalance <= 0) {
      const paid = client.installments.filter((i) => i.status === 'pagado');
      client.installments = paid;
      client.months = paid.length;
    } else {
      regenerateRemaining(client, newBalance, newRemainingMonths);
    }
    client.principal = newBalance + client.installments.filter(i => i.status === 'pagado').reduce((s, i) => s + i.amortization, 0);
  }
  client.ledger.push({ date, type: 'abono', amount, note: note || (choice === 'reduce_months' ? 'Abono a capital (reduce meses)' : 'Abono a capital (reduce cuota)') });
  saveData(DB);
}

/* ---------- Adjuntos: fotos / PDF de contratos ---------- */

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function filesToAttachments(fileList) {
  const attachments = [];
  const files = Array.from(fileList).slice(0, MAX_ATTACHMENTS_PER_CLIENT);
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
      showToastSafe(`"${file.name}" pesa demasiado (máx. ${MAX_ATTACHMENT_MB}MB). No se adjuntó.`);
      continue;
    }
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf';
    if (!isImage && !isPdf) {
      showToastSafe(`"${file.name}" no es una imagen ni un PDF. No se adjuntó.`);
      continue;
    }
    const dataUrl = await fileToDataUrl(file);
    attachments.push({ id: uid(), name: file.name, type: file.type, dataUrl });
  }
  return attachments;
}

function addAttachmentsToClient(clientId, attachments) {
  const client = DB.clients.find((c) => c.id === clientId);
  if (!client) return;
  client.attachments = client.attachments || [];
  const room = MAX_ATTACHMENTS_PER_CLIENT - client.attachments.length;
  if (room <= 0) {
    showToastSafe(`Este cliente ya tiene el máximo de ${MAX_ATTACHMENTS_PER_CLIENT} archivos adjuntos.`);
    return;
  }
  client.attachments = client.attachments.concat(attachments.slice(0, room));
  saveData(DB);
}

function removeAttachment(clientId, attachmentId) {
  const client = DB.clients.find((c) => c.id === clientId);
  if (!client) return;
  client.attachments = (client.attachments || []).filter((a) => a.id !== attachmentId);
  saveData(DB);
}

/* ---------- Exportar / Importar ---------- */

function exportData() {
  const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = todayISO();
  a.href = url;
  a.download = `respaldo_prestamos_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importData(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!parsed.clients || !Array.isArray(parsed.clients)) {
    throw new Error('El archivo no tiene el formato correcto.');
  }
  DB = parsed;
  saveData(DB);
}

/* ============================================================
   INTERFAZ (RENDERIZADO)
   ============================================================ */

let currentModuleTab = 1;
let currentClientId = null;
let editingClientId = null;
let pendingNewAttachments = []; // adjuntos elegidos en el formulario de nuevo cliente, antes de guardar

const screens = {
  home: document.getElementById('screen-home'),
  form: document.getElementById('screen-form'),
  detail: document.getElementById('screen-detail')
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function setTab(moduleNum) {
  currentModuleTab = moduleNum;
  document.getElementById('tab-1').classList.toggle('active', moduleNum === 1);
  document.getElementById('tab-2').classList.toggle('active', moduleNum === 2);
  renderHome();
}

function renderHome() {
  const list = document.getElementById('client-list');
  list.innerHTML = '';
  const clients = DB.clients.filter((c) => c.module === currentModuleTab);

  if (clients.length === 0) {
    list.innerHTML = '<div class="empty-state">No hay clientes registrados todavía en este módulo.<br>Toca el botón "+" para agregar el primero.</div>';
    return;
  }

  clients.forEach((client) => {
    const status = clientOverallStatus(client);
    const color = status === 'atrasado' ? 'red' : status === 'finalizado' ? 'yellow' : 'green';
    const nextInst = client.installments.find((i) => i.status !== 'pagado');
    const div = document.createElement('div');
    div.className = 'card client-card';
    div.innerHTML = `
      <div class="info">
        <h3><span class="badge ${color}"></span>${escapeHtml(client.name)}</h3>
        <p>Capital: ${money(client.principal)} · Tasa: ${client.rate}%</p>
        <p>${nextInst ? `Próxima cuota: ${money(nextInst.total)} · ${fmtDate(nextInst.dueDate)}` : 'Préstamo finalizado'}</p>
      </div>
    `;
    div.addEventListener('click', () => openDetail(client.id));
    list.appendChild(div);
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ---------- Formulario de registro / edición ---------- */

function openForm(clientId) {
  editingClientId = clientId || null;
  const isEdit = !!clientId;
  pendingNewAttachments = [];
  document.getElementById('form-title').textContent = isEdit ? 'Editar cliente' : 'Nuevo cliente';
  document.getElementById('form-module').value = isEdit ? DB.clients.find((c) => c.id === clientId).module : currentModuleTab;
  toggleMethodField();

  clearFormErrors();
  const f = document.getElementById('client-form');
  f.reset();
  document.getElementById('f-attachments').value = '';

  if (isEdit) {
    const c = DB.clients.find((cl) => cl.id === clientId);
    document.getElementById('f-name').value = c.name;
    document.getElementById('f-principal').value = c.principal;
    document.getElementById('f-rate').value = c.rate;
    document.getElementById('f-startDate').value = c.startDate;
    document.getElementById('f-months').value = c.months;
    document.getElementById('f-paymentDay').value = c.paymentDay;
    document.getElementById('f-notes').value = c.notes || '';
    document.getElementById('f-method').value = c.method || 'fixed';
    document.getElementById('form-module').value = c.module;
    document.getElementById('delete-client-btn').style.display = 'block';
    const hasPayments = c.installments.some((i) => i.status === 'pagado');
    document.getElementById('edit-locked-notice').style.display = hasPayments ? 'block' : 'none';
    document.getElementById('new-client-attachments-section').style.display = 'none';
    document.getElementById('existing-client-attachments-notice').style.display = 'block';
  } else {
    document.getElementById('f-startDate').value = todayISO();
    document.getElementById('f-paymentDay').value = new Date().getDate();
    document.getElementById('delete-client-btn').style.display = 'none';
    document.getElementById('edit-locked-notice').style.display = 'none';
    document.getElementById('new-client-attachments-section').style.display = 'block';
    document.getElementById('existing-client-attachments-notice').style.display = 'none';
  }
  renderPendingAttachmentsPreview();
  toggleMethodField();
  showScreen('form');
}

function toggleMethodField() {
  const module = parseInt(document.getElementById('form-module').value, 10);
  document.getElementById('method-field').style.display = module === 2 ? 'block' : 'none';
}

function clearFormErrors() {
  document.querySelectorAll('.error-msg').forEach((e) => {
    e.classList.remove('show');
    e.textContent = '';
  });
}

function readForm() {
  return {
    module: parseInt(document.getElementById('form-module').value, 10),
    method: document.getElementById('f-method').value,
    name: document.getElementById('f-name').value,
    principal: parseFloat(document.getElementById('f-principal').value),
    rate: parseFloat(document.getElementById('f-rate').value),
    startDate: document.getElementById('f-startDate').value,
    months: parseInt(document.getElementById('f-months').value, 10),
    paymentDay: parseInt(document.getElementById('f-paymentDay').value, 10),
    notes: document.getElementById('f-notes').value
  };
}

async function handleNewAttachmentsSelected(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;
  const newOnes = await filesToAttachments(files);
  const room = MAX_ATTACHMENTS_PER_CLIENT - pendingNewAttachments.length;
  pendingNewAttachments = pendingNewAttachments.concat(newOnes.slice(0, room));
  event.target.value = '';
  renderPendingAttachmentsPreview();
}

function renderPendingAttachmentsPreview() {
  const wrap = document.getElementById('pending-attachments-preview');
  wrap.innerHTML = '';
  pendingNewAttachments.forEach((att) => {
    wrap.appendChild(buildAttachmentItem(att, () => {
      pendingNewAttachments = pendingNewAttachments.filter((a) => a.id !== att.id);
      renderPendingAttachmentsPreview();
    }));
  });
}

function buildAttachmentItem(att, onRemove) {
  const div = document.createElement('div');
  div.className = 'attachment-item';
  const isImage = att.type.startsWith('image/');
  const preview = isImage
    ? `<a href="${att.dataUrl}" target="_blank" rel="noopener"><img src="${att.dataUrl}" alt="${escapeHtml(att.name)}"></a>`
    : `<a href="${att.dataUrl}" target="_blank" rel="noopener"><div class="pdf-icon">📄</div></a>`;
  div.innerHTML = `${preview}<span title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>`;
  if (onRemove) {
    const btn = document.createElement('button');
    btn.className = 'remove-att';
    btn.textContent = '✕';
    btn.addEventListener('click', (e) => { e.preventDefault(); onRemove(); });
    div.appendChild(btn);
  }
  return div;
}

function submitForm() {
  clearFormErrors();
  const form = readForm();
  const errors = validateClientForm(form);
  if (Object.keys(errors).length > 0) {
    Object.entries(errors).forEach(([field, msg]) => {
      const el = document.getElementById('err-' + field);
      if (el) {
        el.textContent = msg;
        el.classList.add('show');
      }
    });
    return;
  }
  if (editingClientId) {
    updateClientBasicInfo(editingClientId, form);
    showToast('Cliente actualizado.');
  } else {
    createClient(form, pendingNewAttachments);
    pendingNewAttachments = [];
    showToast('Cliente registrado.');
  }
  currentModuleTab = form.module;
  setTab(form.module);
  showScreen('home');
}

/* ---------- Detalle / historial ---------- */

function openDetail(clientId) {
  currentClientId = clientId;
  renderDetail();
  showScreen('detail');
}

function renderDetail() {
  const client = DB.clients.find((c) => c.id === currentClientId);
  if (!client) { showScreen('home'); return; }
  refreshStatuses(client);
  saveData(DB);

  document.getElementById('detail-name').textContent = client.name;
  document.getElementById('detail-sub').textContent =
    (client.module === 1 ? 'Módulo: Solo interés mensual' : `Módulo: Amortización (${client.method === 'declining' ? 'saldo decreciente' : 'capital fijo'})`);

  const balance = currentBalance(client);
  document.getElementById('detail-balance').textContent = money(balance);
  document.getElementById('detail-rate').textContent = client.rate + '%';
  document.getElementById('detail-notes').textContent = client.notes || 'Sin observaciones.';

  // Ganancia total proyectada al finalizar el préstamo
  const totalGain = calcTotalGain(client);
  const gainCollected = calcGainCollected(client);
  document.getElementById('detail-gain-total').textContent = money(totalGain);
  document.getElementById('detail-gain-collected').textContent = money(gainCollected);

  // Cuotas
  const instBody = document.getElementById('installments-body');
  instBody.innerHTML = '';
  client.installments.forEach((inst) => {
    const tr = document.createElement('tr');
    const colorDot = inst.status === 'pagado' ? '🟢' : inst.status === 'atrasado' ? '🔴' : '⚪';
    tr.innerHTML = `
      <td>${inst.number}</td>
      <td>${fmtDate(inst.dueDate)}</td>
      <td>${money(inst.total)}</td>
      <td>${colorDot} ${inst.status}</td>
      <td></td>
    `;
    const actionTd = tr.lastElementChild;
    if (inst.status !== 'pagado') {
      const btn = document.createElement('button');
      btn.textContent = 'Pagar';
      btn.className = 'secondary';
      btn.style.padding = '8px 10px';
      btn.style.minHeight = '38px';
      btn.style.fontSize = '14px';
      btn.addEventListener('click', () => openPaymentModal(inst.number, inst.total));
      actionTd.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.textContent = 'Deshacer';
      btn.className = 'secondary';
      btn.style.padding = '8px 10px';
      btn.style.minHeight = '38px';
      btn.style.fontSize = '14px';
      btn.addEventListener('click', () => {
        undoPayment(client.id, inst.number);
        renderDetail();
      });
      actionTd.appendChild(btn);
    }
    instBody.appendChild(tr);
  });

  // Historial (ledger)
  const ledgerBody = document.getElementById('ledger-body');
  ledgerBody.innerHTML = '';
  const labels = { origen: 'Préstamo original', ampliacion: 'Ampliación', abono: 'Abono a capital', pago: 'Pago de cuota' };
  [...client.ledger].reverse().forEach((entry) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(entry.date)}</td><td>${labels[entry.type] || entry.type}</td><td>${money(entry.amount)}</td>`;
    ledgerBody.appendChild(tr);
  });

  // Adjuntos (fotos / PDF del contrato)
  const attWrap = document.getElementById('detail-attachments');
  attWrap.innerHTML = '';
  (client.attachments || []).forEach((att) => {
    attWrap.appendChild(buildAttachmentItem(att, () => {
      removeAttachment(client.id, att.id);
      renderDetail();
    }));
  });
  if (!client.attachments || client.attachments.length === 0) {
    attWrap.innerHTML = '<p style="color:var(--text-dim); font-size:14px;">No hay fotos ni PDF del contrato adjuntos.</p>';
  }
}

/* ---------- Adjuntar archivos desde el detalle del cliente ---------- */

async function handleDetailAttachmentsSelected(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;
  const attachments = await filesToAttachments(files);
  addAttachmentsToClient(currentClientId, attachments);
  event.target.value = '';
  renderDetail();
  showToast('Archivo(s) adjuntado(s).');
}

/* ---------- Modales ---------- */

function openPaymentModal(installmentNumber, suggestedAmount) {
  document.getElementById('pay-installment-number').value = installmentNumber;
  document.getElementById('pay-date').value = todayISO();
  document.getElementById('pay-amount').value = suggestedAmount;
  document.getElementById('modal-payment').classList.add('show');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

function confirmPayment() {
  const number = parseInt(document.getElementById('pay-installment-number').value, 10);
  const date = document.getElementById('pay-date').value;
  const amount = parseFloat(document.getElementById('pay-amount').value);
  if (!date || isNaN(amount) || amount <= 0) {
    showToast('Revisa la fecha y el monto ingresado.');
    return;
  }
  registerPayment(currentClientId, number, date, amount);
  closeModal('modal-payment');
  renderDetail();
  showToast('Pago registrado.');
}

function openExtraLoanModal() {
  document.getElementById('extra-date').value = todayISO();
  document.getElementById('extra-amount').value = '';
  document.getElementById('extra-note').value = '';
  document.getElementById('modal-extra').classList.add('show');
}

function confirmExtraLoan() {
  const amount = parseFloat(document.getElementById('extra-amount').value);
  const date = document.getElementById('extra-date').value;
  const note = document.getElementById('extra-note').value;
  if (isNaN(amount) || amount <= 0 || !date) {
    showToast('Ingresa un monto y una fecha válidos.');
    return;
  }
  registerExtraLoan(currentClientId, amount, date, note);
  closeModal('modal-extra');
  renderDetail();
  showToast('Ampliación registrada y cuotas recalculadas.');
}

function openPrepayModal() {
  document.getElementById('prepay-date').value = todayISO();
  document.getElementById('prepay-amount').value = '';
  document.getElementById('prepay-note').value = '';
  document.getElementById('modal-prepay').classList.add('show');
  const client = DB.clients.find((c) => c.id === currentClientId);
  document.getElementById('prepay-choice-wrap').style.display = client.module === 1 ? 'none' : 'block';
}

function confirmPrepay() {
  const amount = parseFloat(document.getElementById('prepay-amount').value);
  const date = document.getElementById('prepay-date').value;
  const note = document.getElementById('prepay-note').value;
  const choice = document.querySelector('input[name="prepay-choice"]:checked')?.value || 'reduce_quota';
  if (isNaN(amount) || amount <= 0 || !date) {
    showToast('Ingresa un monto y una fecha válidos.');
    return;
  }
  registerPrepayment(currentClientId, amount, date, choice, note);
  closeModal('modal-prepay');
  renderDetail();
  showToast('Abono registrado y cuotas recalculadas.');
}

function confirmDeleteClient() {
  if (!confirm('¿Seguro que deseas eliminar este cliente? Esta acción no se puede deshacer.')) return;
  deleteClient(editingClientId || currentClientId);
  showScreen('home');
  renderHome();
  showToast('Cliente eliminado.');
}

/* ---------- Import/Export UI ---------- */

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importData(reader.result);
      renderHome();
      showToast('Datos restaurados correctamente.');
    } catch (e) {
      showToast('No se pudo leer el archivo de respaldo.');
    }
  };
  reader.readAsText(file);
}

/* ============================================================
   INICIALIZACIÓN
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tab-1').addEventListener('click', () => setTab(1));
  document.getElementById('tab-2').addEventListener('click', () => setTab(2));
  document.getElementById('fab-add').addEventListener('click', () => openForm(null));
  document.getElementById('form-back').addEventListener('click', () => showScreen('home'));
  document.getElementById('detail-back').addEventListener('click', () => { showScreen('home'); renderHome(); });
  document.getElementById('form-module').addEventListener('change', toggleMethodField);
  document.getElementById('client-form').addEventListener('submit', (e) => { e.preventDefault(); submitForm(); });
  document.getElementById('delete-client-btn').addEventListener('click', confirmDeleteClient);
  document.getElementById('f-attachments').addEventListener('change', handleNewAttachmentsSelected);

  document.getElementById('edit-client-btn').addEventListener('click', () => openForm(currentClientId));
  document.getElementById('extra-loan-btn').addEventListener('click', openExtraLoanModal);
  document.getElementById('prepay-btn').addEventListener('click', openPrepayModal);
  document.getElementById('detail-attachments-input').addEventListener('change', handleDetailAttachmentsSelected);

  document.getElementById('modal-payment-confirm').addEventListener('click', confirmPayment);
  document.getElementById('modal-payment-cancel').addEventListener('click', () => closeModal('modal-payment'));
  document.getElementById('modal-extra-confirm').addEventListener('click', confirmExtraLoan);
  document.getElementById('modal-extra-cancel').addEventListener('click', () => closeModal('modal-extra'));
  document.getElementById('modal-prepay-confirm').addEventListener('click', confirmPrepay);
  document.getElementById('modal-prepay-cancel').addEventListener('click', () => closeModal('modal-prepay'));

  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-input').addEventListener('change', handleImportFile);

  setTab(1);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
