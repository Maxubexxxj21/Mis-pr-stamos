/* ============================================================
   MIS PRÉSTAMOS - Lógica de la aplicación
   Datos en el celular (localStorage) + copia en Google Drive.
   ============================================================ */

const STORAGE_KEY = 'prestamos_data_v1';
const MAX_ATTACHMENT_MB = 4;
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
    if (typeof scheduleCloudBackup === 'function') scheduleCloudBackup();
    return true;
  } catch (e) {
    console.error('Error guardando datos', e);
    showToastSafe('No se pudo guardar: el almacenamiento está lleno. Elimina algún adjunto pesado.');
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
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function isoFromDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function addMonths(dateISO, months) {
  const d = new Date(dateISO + 'T00:00:00');
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInTarget));
  return isoFromDate(d);
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
// Ejemplo: Capital 100, tasa 10%, 5 meses -> meses 1-4: 10 soles; mes 5: 110.
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

// MÓDULO 2 - MÉTODO 1 (predeterminado): interés fijo sobre el capital del ciclo.
// Ejemplo: Capital 100, tasa 10%, 5 meses -> 20 + 10 = 30 soles cada mes.
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

// MÓDULO 2 - MÉTODO 2 (alternativo): interés sobre saldo decreciente.
// Ejemplo: Capital 100, tasa 10%, 5 meses -> cuotas 30, 28, 26, 24, 22.
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
  const firstOfMonth = isoFromDate(new Date(base.getFullYear(), base.getMonth(), 1));
  const withDay = setDaySafe(firstOfMonth, paymentDay);
  return addMonths(withDay, installmentNumber);
}

function setDaySafe(monthISO, day) {
  const d = new Date(monthISO + 'T00:00:00');
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInMonth));
  return isoFromDate(d);
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

function regenerateRemaining(client, newBalance, newRemainingMonths) {
  const paid = client.installments.filter((i) => i.status === 'pagado');
  const lastPaidNumber = paid.length ? Math.max(...paid.map((i) => i.number)) : 0;
  const nextNumber = lastPaidNumber + 1;

  let builder;
  if (client.module === 1) builder = buildModule1Schedule;
  else if (client.method === 'declining') builder = buildModule2DecliningSchedule;
  else builder = buildModule2FixedSchedule;

  const remainingSchedule = builder(newBalance, client.rate, newRemainingMonths, client.startDate, client.paymentDay, 1)
    .map((inst, idx) => ({ ...inst, number: nextNumber + idx, dueDate: dueDateFromToday(client, idx + 1) }));

  client.installments = [...paid, ...remainingSchedule];
  client.months = client.installments.length;
}

function dueDateFromToday(client, monthsAhead) {
  const firstOfThisMonth = todayISO().slice(0, 8) + '01';
  const base = setDaySafe(firstOfThisMonth, client.paymentDay);
  return addMonths(base, monthsAhead);
}

function currentBalance(client) {
  const unpaid = client.installments.filter((i) => i.status !== 'pagado');
  if (unpaid.length === 0) return 0;
  if (client.module === 1) return client.principal;
  const amortPaid = client.installments
    .filter((i) => i.status === 'pagado')
    .reduce((s, i) => s + i.amortization, 0);
  return round2(client.principal - amortPaid);
}

// Ganancia total: suma de todo el interés del cronograma vigente.
function calcTotalGain(client) {
  return round2(client.installments.reduce((sum, inst) => sum + inst.interest, 0));
}

function calcGainCollected(client) {
  return round2(client.installments.filter((i) => i.status === 'pagado').reduce((sum, inst) => sum + inst.interest, 0));
}

/* ---------- Estado de cuotas ---------- */

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
  if (!inst || inst.settlement) return;
  inst.status = inst.dueDate < todayISO() ? 'atrasado' : 'pendiente';
  inst.paidDate = null;
  inst.paidAmount = null;
  saveData(DB);
}

function sumPaidAmortization(client) {
  return client.installments.filter((i) => i.status === 'pagado').reduce((s, i) => s + i.amortization, 0);
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
    // El capital de referencia incluye lo ya amortizado, para que el saldo = capital - amortizado.
    client.principal = round2(newBalance + sumPaidAmortization(client));
  }
  client.ledger.push({ date, type: 'ampliacion', amount, note: note || 'Ampliación de préstamo' });
  saveData(DB);
}

function generateFullScheduleKeepingPaid(client) {
  const paid = client.installments.filter((i) => i.status === 'pagado');
  const lastPaidNumber = paid.length ? Math.max(...paid.map((i) => i.number)) : 0;
  const remainingMonths = Math.max(client.months - paid.length, 1);
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
    }

    if (newBalance <= 0) {
      const paid = client.installments.filter((i) => i.status === 'pagado');
      client.installments = paid;
      client.months = paid.length;
    } else {
      regenerateRemaining(client, newBalance, newRemainingMonths);
    }
    client.principal = round2(newBalance + sumPaidAmortization(client));
  }
  client.ledger.push({ date, type: 'abono', amount, note: note || (choice === 'reduce_months' ? 'Abono a capital (reduce meses)' : 'Abono a capital (reduce cuota)') });
  saveData(DB);
}

/* ---------- Liquidación total anticipada ---------- */

function calcPayoffSuggestion(client) {
  const unpaid = client.installments.filter((i) => i.status !== 'pagado');
  if (unpaid.length === 0) return { balance: 0, nextInterest: 0, suggested: 0 };
  const balance = currentBalance(client);
  const nextInterest = unpaid[0].interest;
  return { balance, nextInterest, suggested: round2(balance + nextInterest) };
}

// Cierra el préstamo: reemplaza todas las cuotas pendientes por una sola
// "liquidación" pagada. La ganancia real = monto pagado - capital pendiente.
function registerFullPayoff(clientId, date, amount) {
  const client = DB.clients.find((c) => c.id === clientId);
  if (!client) return;
  const balance = currentBalance(client);
  const paid = client.installments.filter((i) => i.status === 'pagado');
  const lastNumber = paid.length ? Math.max(...paid.map((i) => i.number)) : 0;
  const settlement = {
    number: lastNumber + 1,
    dueDate: date,
    amortization: balance,
    interest: round2(Math.max(amount - balance, 0)),
    total: round2(amount),
    status: 'pagado',
    paidDate: date,
    paidAmount: amount,
    settlement: true
  };
  client.installments = [...paid, settlement];
  client.months = client.installments.length;
  client.ledger.push({ date, type: 'liquidacion', amount, note: 'Liquidación total anticipada' });
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

/* ---------- Exportar / Importar (archivo manual) ---------- */

function exportData() {
  const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `respaldo_prestamos_${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importData(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!parsed || !Array.isArray(parsed.clients)) {
    throw new Error('El archivo no tiene el formato correcto.');
  }
  parsed.clients.forEach((c) => {
    if (!c.id || !c.name || !Array.isArray(c.installments)) {
      throw new Error('El archivo no tiene el formato correcto.');
    }
    c.ledger = c.ledger || [];
    c.attachments = c.attachments || [];
  });
  const previous = DB;
  DB = parsed;
  if (!saveData(DB)) {
    DB = previous;
    throw new Error('storage_full');
  }
}

/* ============================================================
   COPIA DE SEGURIDAD EN GOOGLE DRIVE
   - Se guarda en el Drive del usuario como "respaldo_mis_prestamos.json".
   - Permiso mínimo: solo archivos creados por esta app (drive.file).
   - Se actualiza (sobrescribe) ~20 s después de cada cambio y una vez
     cada noche (a partir de las 8 pm) cuando la app se abre o está en uso.
   ============================================================ */

const DRIVE_FILE_NAME = 'respaldo_mis_prestamos.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const LS = {
  connected: 'cloud_connected',
  lastAt: 'cloud_last_backup_at',
  lastHash: 'cloud_last_hash',
  fileId: 'cloud_file_id',
  trusted: 'cloud_device_trusted',
  restoreDismissed: 'cloud_restore_dismissed'
};

let driveToken = null;
let driveTokenExpiry = 0;
let tokenClient = null;
let backupTimer = null;
let backupRunning = false;
let cloudState = 'idle'; // idle | ok | needs_auth | error

function cloudConfigured() {
  return typeof GOOGLE_CLIENT_ID === 'string' &&
    GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com') &&
    !GOOGLE_CLIENT_ID.startsWith('PEGA_AQUI');
}

function isCloudConnected() {
  return localStorage.getItem(LS.connected) === '1';
}

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return String(h) + ':' + str.length;
}

function getAccessToken(interactive) {
  return new Promise((resolve, reject) => {
    if (driveToken && Date.now() < driveTokenExpiry - 60000) return resolve(driveToken);
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      return reject(new Error('sin_google'));
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: () => {},
        error_callback: () => {}
      });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      driveToken = resp.access_token;
      driveTokenExpiry = Date.now() + (parseInt(resp.expires_in, 10) || 3600) * 1000;
      resolve(driveToken);
    };
    tokenClient.error_callback = (err) => reject(new Error((err && err.type) || 'popup'));
    tokenClient.requestAccessToken({ prompt: interactive ? '' : '' });
  });
}

async function driveRequest(url, options, token) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options && options.headers), Authorization: 'Bearer ' + token }
  });
  if (res.status === 401) {
    driveToken = null;
    throw new Error('auth');
  }
  return res;
}

async function findBackupFile(token) {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const order = encodeURIComponent('modifiedTime desc');
  const res = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=${order}&pageSize=10&fields=files(id,name,modifiedTime)`,
    {}, token
  );
  if (!res.ok) throw new Error('drive_' + res.status);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0] : null;
}

async function uploadBackup(token, jsonString, fileId) {
  if (fileId) {
    const res = await driveRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: jsonString },
      token
    );
    if (res.ok) return fileId;
    if (res.status !== 404) throw new Error('drive_' + res.status);
  }
  const boundary = 'prestamos' + Date.now();
  const metadata = JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonString}\r\n--${boundary}--`;
  const res = await driveRequest(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body },
    token
  );
  if (!res.ok) throw new Error('drive_' + res.status);
  const created = await res.json();
  return created.id;
}

async function downloadBackup(token, fileId) {
  const res = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {}, token);
  if (!res.ok) throw new Error('drive_' + res.status);
  return res.text();
}

function friendlyCloudError(e) {
  const m = (e && e.message) || '';
  if (m === 'sin_google') return 'No pude conectar con Google. Revisa tu internet e inténtalo de nuevo.';
  if (m === 'storage_full') return 'El celular no tiene espacio suficiente para restaurar los datos.';
  if (m.includes('formato')) return m;
  if (m.includes('popup') || m.includes('access_denied') || m.includes('auth') || m.includes('immediate')) {
    return 'Google necesita que vuelvas a autorizar. Toca "Reconectar con Google Drive".';
  }
  if (m.startsWith('drive_403')) return 'Google Drive rechazó el permiso. Verifica que la API de Drive esté habilitada.';
  return 'No se pudo completar la operación con Google Drive. Revisa tu internet.';
}

function setCloudState(state) {
  cloudState = state;
  updateCloudStatusUI();
}

// Sube la copia a Drive. Devuelve true si quedó respaldada (o ya estaba al día).
async function runCloudBackup(opts = {}) {
  const interactive = !!opts.interactive;
  const force = !!opts.force;
  if (!cloudConfigured() || backupRunning) return false;
  if (!isCloudConnected() && !interactive) return false;

  const json = JSON.stringify(DB);
  const hash = hashString(json);
  if (!force && hash === localStorage.getItem(LS.lastHash)) return true;

  backupRunning = true;
  try {
    const token = await getAccessToken(interactive);
    let fileId = localStorage.getItem(LS.fileId);
    if (!fileId) {
      const existing = await findBackupFile(token);
      fileId = existing ? existing.id : null;
    }
    // Protección: un celular que aún no restauró no debe pisar la copia existente.
    if (fileId && localStorage.getItem(LS.trusted) !== '1') {
      setCloudState('needs_auth');
      return false;
    }
    const newId = await uploadBackup(token, json, fileId);
    localStorage.setItem(LS.fileId, newId);
    localStorage.setItem(LS.trusted, '1');
    localStorage.setItem(LS.lastHash, hash);
    localStorage.setItem(LS.lastAt, String(Date.now()));
    setCloudState('ok');
    return true;
  } catch (e) {
    const m = (e && e.message) || '';
    const needsAuth = m.includes('popup') || m.includes('access_denied') || m.includes('auth') || m.includes('immediate') || m === 'sin_google';
    setCloudState(needsAuth ? 'needs_auth' : 'error');
    if (interactive) showToast(friendlyCloudError(e), 5000);
    return false;
  } finally {
    backupRunning = false;
  }
}

function scheduleCloudBackup() {
  if (!cloudConfigured() || !isCloudConnected()) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { runCloudBackup({}); }, 20000);
}

// Garantiza una copia cada noche: a partir de las 8 pm, si aún no hay copia de hoy.
function maybeNightlyBackup() {
  if (!cloudConfigured() || !isCloudConnected()) return;
  const last = parseInt(localStorage.getItem(LS.lastAt) || '0', 10);
  const now = new Date();
  const today8pm = new Date(now);
  today8pm.setHours(20, 0, 0, 0);
  const older24h = !last || (Date.now() - last) > 24 * 3600 * 1000;
  const dueTonight = now >= today8pm && last < today8pm.getTime();
  if (older24h || dueTonight) runCloudBackup({ force: true });
}

async function restoreFromDrive(token, file) {
  const text = await downloadBackup(token, file.id);
  importData(text);
  localStorage.setItem(LS.fileId, file.id);
  localStorage.setItem(LS.connected, '1');
  localStorage.setItem(LS.trusted, '1');
  localStorage.setItem(LS.restoreDismissed, '1');
  localStorage.setItem(LS.lastHash, hashString(JSON.stringify(DB)));
  localStorage.setItem(LS.lastAt, String(Date.now()));
  setCloudState('ok');
  renderHome();
  showToast(`Datos restaurados: ${DB.clients.length} cliente(s).`, 4500);
}

async function connectCloud() {
  if (!cloudConfigured()) {
    showToast('Falta pegar tu ID de cliente de Google en el archivo config.js.', 5000);
    return;
  }
  try {
    const token = await getAccessToken(true);
    const file = await findBackupFile(token);
    if (file) {
      const when = new Date(file.modifiedTime).toLocaleString('es-PE');
      if (confirm(`Encontré una copia de seguridad en tu Google Drive (${when}).\n\n¿Quieres restaurarla ahora? Reemplazará los datos de este celular.`)) {
        await restoreFromDrive(token, file);
        return;
      }
      if (!confirm('Entonces la copia antigua de Drive será REEMPLAZADA por los datos de este celular. ¿Continuar?')) {
        return;
      }
      localStorage.setItem(LS.fileId, file.id);
    }
    localStorage.setItem(LS.connected, '1');
    localStorage.setItem(LS.trusted, '1');
    localStorage.setItem(LS.restoreDismissed, '1');
    const ok = await runCloudBackup({ interactive: true, force: true });
    if (ok) showToast('Listo: tu copia en Google Drive está activa.', 4000);
    renderHome();
  } catch (e) {
    showToast(friendlyCloudError(e), 5000);
  }
}

async function manualBackup() {
  if (!cloudConfigured()) {
    showToast('Falta pegar tu ID de cliente de Google en el archivo config.js.', 5000);
    return;
  }
  if (!isCloudConnected()) { await connectCloud(); return; }
  const ok = await runCloudBackup({ interactive: true, force: true });
  if (ok) showToast('Copia guardada en Google Drive.');
}

async function manualRestore() {
  if (!cloudConfigured()) {
    showToast('Falta pegar tu ID de cliente de Google en el archivo config.js.', 5000);
    return;
  }
  if (DB.clients.length > 0 && !confirm('Esto reemplazará los datos de este celular por los de tu copia en Google Drive. ¿Continuar?')) return;
  try {
    const token = await getAccessToken(true);
    const file = await findBackupFile(token);
    if (!file) {
      showToast('No encontré ninguna copia en este Google Drive. Revisa que elegiste la misma cuenta de Google de antes.', 6000);
      return;
    }
    await restoreFromDrive(token, file);
  } catch (e) {
    showToast(friendlyCloudError(e), 5000);
  }
}

function updateCloudStatusUI() {
  const statusEl = document.getElementById('cloud-status');
  const connectBtn = document.getElementById('cloud-connect-btn');
  const backupBtn = document.getElementById('cloud-backup-btn');
  const restoreBtn = document.getElementById('cloud-restore-btn');
  if (!statusEl) return;

  if (!cloudConfigured()) {
    statusEl.className = 'cloud-status off';
    statusEl.textContent = '☁️ Copia en la nube: aún no configurada (falta pegar tu ID de cliente de Google en config.js).';
    connectBtn.style.display = 'none';
    backupBtn.style.display = 'none';
    restoreBtn.style.display = 'none';
    return;
  }

  restoreBtn.style.display = 'block';
  if (!isCloudConnected()) {
    statusEl.className = 'cloud-status off';
    statusEl.textContent = '☁️ Copia en la nube: desconectada. Conéctala para que tus datos se respalden solos en Google Drive.';
    connectBtn.style.display = 'block';
    connectBtn.textContent = '☁️ Conectar con Google Drive';
    backupBtn.style.display = 'none';
    return;
  }

  const last = parseInt(localStorage.getItem(LS.lastAt) || '0', 10);
  const lastTxt = last ? new Date(last).toLocaleString('es-PE') : 'todavía ninguna';
  backupBtn.style.display = 'block';
  if (cloudState === 'needs_auth' || cloudState === 'error') {
    statusEl.className = 'cloud-status warn';
    statusEl.textContent = `⚠️ No pude actualizar la copia. Última copia: ${lastTxt}. Toca "Reconectar con Google Drive".`;
    connectBtn.style.display = 'block';
    connectBtn.textContent = '🔄 Reconectar con Google Drive';
  } else {
    statusEl.className = 'cloud-status ok';
    statusEl.textContent = `✅ Copia automática activa. Última copia en Drive: ${lastTxt}.`;
    connectBtn.style.display = 'none';
  }
}

function updateRestoreBanner() {
  const banner = document.getElementById('restore-banner');
  if (!banner) return;
  const show = cloudConfigured() &&
    DB.clients.length === 0 &&
    localStorage.getItem(LS.trusted) !== '1' &&
    localStorage.getItem(LS.restoreDismissed) !== '1';
  banner.style.display = show ? 'block' : 'none';
}

/* ============================================================
   INTERFAZ (RENDERIZADO)
   ============================================================ */

let currentModuleTab = 1;
let currentClientId = null;
let editingClientId = null;
let pendingNewAttachments = [];

const screens = {
  home: document.getElementById('screen-home'),
  form: document.getElementById('screen-form'),
  detail: document.getElementById('screen-detail')
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showToast(msg, ms) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), ms || 3200);
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
  updateRestoreBanner();
  updateCloudStatusUI();
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
        <p>${nextInst ? `Próxima cuota: ${money(nextInst.total)} · ${fmtDate(nextInst.dueDate)}` : '✅ Deuda terminada de pagar'}</p>
      </div>
      <div class="card-actions"></div>
    `;
    const actions = div.querySelector('.card-actions');
    const btn = document.createElement('button');
    if (status === 'finalizado') {
      btn.className = 'danger small';
      btn.textContent = '🗑 Eliminar';
      btn.addEventListener('click', (e) => { e.stopPropagation(); deleteClientWithConfirm(client.id); });
    } else {
      btn.className = 'secondary small';
      btn.textContent = '🏁 Liquidar';
      btn.addEventListener('click', (e) => { e.stopPropagation(); openPayoffModal(client.id); });
    }
    actions.appendChild(btn);
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

  clearFormErrors();
  document.getElementById('client-form').reset();
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

  const finished = client.installments.every((i) => i.status === 'pagado');

  document.getElementById('detail-name').textContent = client.name;
  document.getElementById('detail-sub').textContent =
    (client.module === 1 ? 'Módulo: Solo interés mensual' : `Módulo: Amortización (${client.method === 'declining' ? 'saldo decreciente' : 'capital fijo'})`);
  document.getElementById('detail-balance').textContent = money(currentBalance(client));
  document.getElementById('detail-rate').textContent = client.rate + '%';
  document.getElementById('detail-notes').textContent = client.notes || 'Sin observaciones.';
  document.getElementById('detail-gain-total').textContent = money(calcTotalGain(client));
  document.getElementById('detail-gain-collected').textContent = money(calcGainCollected(client));

  document.getElementById('payoff-btn').style.display = finished ? 'none' : 'block';
  document.getElementById('detail-delete-btn').style.display = finished ? 'block' : 'none';
  document.getElementById('extra-loan-btn').disabled = finished;
  document.getElementById('prepay-btn').disabled = finished;

  const instBody = document.getElementById('installments-body');
  instBody.innerHTML = '';
  client.installments.forEach((inst) => {
    const tr = document.createElement('tr');
    const colorDot = inst.status === 'pagado' ? '🟢' : inst.status === 'atrasado' ? '🔴' : '⚪';
    tr.innerHTML = `
      <td>${inst.settlement ? 'Liq.' : inst.number}</td>
      <td>${fmtDate(inst.dueDate)}</td>
      <td>${money(inst.total)}</td>
      <td>${colorDot} ${inst.status}</td>
      <td></td>
    `;
    const actionTd = tr.lastElementChild;
    if (!inst.settlement) {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.style.padding = '8px 10px';
      btn.style.minHeight = '38px';
      btn.style.fontSize = '14px';
      if (inst.status !== 'pagado') {
        btn.textContent = 'Pagar';
        btn.addEventListener('click', () => openPaymentModal(inst.number, inst.total));
      } else {
        btn.textContent = 'Deshacer';
        btn.addEventListener('click', () => { undoPayment(client.id, inst.number); renderDetail(); });
      }
      actionTd.appendChild(btn);
    }
    instBody.appendChild(tr);
  });

  const ledgerBody = document.getElementById('ledger-body');
  ledgerBody.innerHTML = '';
  const labels = { origen: 'Préstamo original', ampliacion: 'Ampliación', abono: 'Abono a capital', pago: 'Pago de cuota', liquidacion: 'Liquidación total' };
  [...client.ledger].reverse().forEach((entry) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(entry.date)}</td><td>${labels[entry.type] || entry.type}</td><td>${money(entry.amount)}</td>`;
    ledgerBody.appendChild(tr);
  });

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

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

function openPaymentModal(installmentNumber, suggestedAmount) {
  document.getElementById('pay-installment-number').value = installmentNumber;
  document.getElementById('pay-date').value = todayISO();
  document.getElementById('pay-amount').value = suggestedAmount;
  document.getElementById('modal-payment').classList.add('show');
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

function openPayoffModal(clientId) {
  currentClientId = clientId;
  const client = DB.clients.find((c) => c.id === clientId);
  if (!client) return;
  const s = calcPayoffSuggestion(client);
  document.getElementById('payoff-info').textContent =
    `${client.name}: capital pendiente ${money(s.balance)} + interés de la cuota en curso ${money(s.nextInterest)} = ${money(s.suggested)} (monto sugerido; puedes cambiarlo si acordaron otro).`;
  document.getElementById('payoff-date').value = todayISO();
  document.getElementById('payoff-amount').value = s.suggested;
  document.getElementById('modal-payoff').classList.add('show');
}

function confirmPayoff() {
  const client = DB.clients.find((c) => c.id === currentClientId);
  if (!client) return;
  const date = document.getElementById('payoff-date').value;
  const amount = parseFloat(document.getElementById('payoff-amount').value);
  const balance = currentBalance(client);
  if (!date || isNaN(amount) || amount <= 0) {
    showToast('Revisa la fecha y el monto ingresado.');
    return;
  }
  if (amount < balance) {
    showToast(`El monto debe cubrir al menos el capital pendiente (${money(balance)}).`, 4500);
    return;
  }
  registerFullPayoff(currentClientId, date, amount);
  closeModal('modal-payoff');
  if (screens.detail.classList.contains('active')) renderDetail(); else renderHome();
  showToast('Deuda liquidada. Ya puedes eliminar el nombre de la lista.', 4500);
}

function deleteClientWithConfirm(id) {
  const c = DB.clients.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`¿Eliminar a "${c.name}" y todo su historial?\n\nNo se puede deshacer. La copia de Google Drive también se actualizará sin este cliente.`)) return;
  deleteClient(id);
  showScreen('home');
  renderHome();
  showToast('Cliente eliminado.');
}

/* ---------- Importar archivo manual ---------- */

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
  document.getElementById('delete-client-btn').addEventListener('click', () => deleteClientWithConfirm(editingClientId));
  document.getElementById('detail-delete-btn').addEventListener('click', () => deleteClientWithConfirm(currentClientId));
  document.getElementById('f-attachments').addEventListener('change', handleNewAttachmentsSelected);

  document.getElementById('edit-client-btn').addEventListener('click', () => openForm(currentClientId));
  document.getElementById('extra-loan-btn').addEventListener('click', openExtraLoanModal);
  document.getElementById('prepay-btn').addEventListener('click', openPrepayModal);
  document.getElementById('payoff-btn').addEventListener('click', () => openPayoffModal(currentClientId));
  document.getElementById('detail-attachments-input').addEventListener('change', handleDetailAttachmentsSelected);

  document.getElementById('modal-payment-confirm').addEventListener('click', confirmPayment);
  document.getElementById('modal-payment-cancel').addEventListener('click', () => closeModal('modal-payment'));
  document.getElementById('modal-extra-confirm').addEventListener('click', confirmExtraLoan);
  document.getElementById('modal-extra-cancel').addEventListener('click', () => closeModal('modal-extra'));
  document.getElementById('modal-prepay-confirm').addEventListener('click', confirmPrepay);
  document.getElementById('modal-prepay-cancel').addEventListener('click', () => closeModal('modal-prepay'));
  document.getElementById('modal-payoff-confirm').addEventListener('click', confirmPayoff);
  document.getElementById('modal-payoff-cancel').addEventListener('click', () => closeModal('modal-payoff'));

  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-input').addEventListener('change', handleImportFile);

  document.getElementById('cloud-connect-btn').addEventListener('click', connectCloud);
  document.getElementById('cloud-backup-btn').addEventListener('click', manualBackup);
  document.getElementById('cloud-restore-btn').addEventListener('click', manualRestore);
  document.getElementById('banner-restore-btn').addEventListener('click', manualRestore);
  document.getElementById('banner-skip-btn').addEventListener('click', () => {
    localStorage.setItem(LS.restoreDismissed, '1');
    updateRestoreBanner();
  });

  setTab(1);

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  // Copia nocturna: al abrir, al volver a la app y cada 10 minutos mientras esté abierta.
  window.addEventListener('load', () => setTimeout(maybeNightlyBackup, 3000));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybeNightlyBackup(); });
  setInterval(maybeNightlyBackup, 10 * 60 * 1000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
