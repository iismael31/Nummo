// Modelo de datos: forma de cada entidad, validación estricta (copias) o de reparación
// (datos propios), estado inicial y reparto en bloques cifrados ("buckets").

import { newId, isId } from './ids.js';
import { isCents } from './money.js';
import { isISODate } from './dates.js';
import { cleanText, cleanLetters } from './text.js';
import {
  COLOR_KEYS, PICKER_ICONS, ACCOUNT_TYPE_KEYS, accountTypeInfo,
  DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES, AUTO_LOCK_OPTIONS, DEFAULT_AUTO_LOCK, HOME_PANEL_KEYS, DEFAULT_HOME_PANELS,
} from './catalog.js';

// 2: presupuestos con varias categorías (`categoryIds`). Los datos de la versión 1 se convierten al leerlos.
// 3: huchas (`piggies` y movimientos de tipo 'piggy').
export const SCHEMA_VERSION = 3;
export const CORE_BUCKET = 'core';
export const LIMITS = {
  name: 40, note: 140,
  // 100.000 movimientos ≈ 10 al día durante 27 años; la copia cabe en MAX_BACKUP_BYTES (backup.js).
  accounts: 100, categories: 300, debts: 1000, budgets: 300, recurring: 300, movements: 100_000,
  piggies: 100, boxes: 1000,
};
export const MOVEMENT_TYPES = ['expense', 'income', 'transfer', 'debt', 'piggy'];
export const PIGGY_FLOWS = ['in', 'out']; // meter dinero / vaciar la hucha al terminar
export const DEBT_KINDS = ['owe', 'owed']; // debo / me deben
export const DEBT_FLOWS = ['add', 'pay']; // la deuda crece / se paga
export const FREQUENCIES = ['weekly', 'monthly', 'yearly'];
export const MAX_INTERVAL = 12;
const MAX_RECURRING_INDEX = 100_000;
const AUTO_LOCK_VALUES = AUTO_LOCK_OPTIONS.map((o) => o.seconds);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const fail = (message) => {
  throw new ValidationError(message);
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const orderOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

function requireId(value, what) {
  return isId(value) ? value : fail(`${what}: identificador no válido.`);
}

function positiveCents(value, what) {
  return isCents(value, { min: 1 }) ? value : fail(`${what}: el importe debe ser mayor que 0.`);
}

// ---------------------------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------------------------

export function normalizeAccount(raw) {
  if (!isObject(raw)) fail('Cuenta no válida.');
  const name = cleanText(raw.name, LIMITS.name) || fail('La cuenta necesita un nombre.');
  const type = pick(raw.type, ACCOUNT_TYPE_KEYS, 'other');
  const initial = raw.initial ?? 0;
  if (!isCents(initial)) fail(`Cuenta «${name}»: saldo inicial no válido.`);
  return {
    id: requireId(raw.id, `Cuenta «${name}»`),
    name,
    type,
    icon: pick(raw.icon, PICKER_ICONS, accountTypeInfo(type).icon),
    letters: cleanLetters(raw.letters),
    color: pick(raw.color, COLOR_KEYS, 'blue'),
    initial,
    includeInTotal: raw.includeInTotal !== false,
    archived: raw.archived === true,
    order: orderOf(raw.order),
  };
}

export function normalizeCategory(raw) {
  if (!isObject(raw)) fail('Categoría no válida.');
  const name = cleanText(raw.name, LIMITS.name) || fail('La categoría necesita un nombre.');
  return {
    id: requireId(raw.id, `Categoría «${name}»`),
    kind: pick(raw.kind, ['expense', 'income'], null) ?? fail(`Categoría «${name}»: tipo no válido.`),
    name,
    icon: pick(raw.icon, PICKER_ICONS, 'tag'),
    color: pick(raw.color, COLOR_KEYS, 'gray'),
    archived: raw.archived === true,
    order: orderOf(raw.order),
  };
}

export function normalizeDebt(raw) {
  if (!isObject(raw)) fail('Deuda no válida.');
  const name = cleanText(raw.name, LIMITS.name) || fail('La deuda necesita un nombre.');
  if (raw.dueDate != null && !isISODate(raw.dueDate)) fail(`Deuda «${name}»: fecha límite no válida.`);
  return {
    id: requireId(raw.id, `Deuda «${name}»`),
    kind: pick(raw.kind, DEBT_KINDS, null) ?? fail(`Deuda «${name}»: tipo no válido.`),
    name,
    note: cleanText(raw.note, LIMITS.note),
    dueDate: raw.dueDate ?? null,
  };
}

/** Presupuesto mensual: el total del mes (`categoryIds: null`) o la suma de una o varias categorías. */
export function normalizeBudget(raw) {
  if (!isObject(raw)) fail('Presupuesto no válido.');
  let ids;
  if ('categoryIds' in raw) ids = raw.categoryIds;
  else if ('categoryId' in raw) ids = raw.categoryId === null ? null : [raw.categoryId]; // versión 1: una sola categoría
  else fail('Presupuesto no válido.');
  if (ids !== null && (!Array.isArray(ids) || ids.length === 0 || ids.length > LIMITS.categories)) {
    fail('El presupuesto necesita al menos una categoría.');
  }
  return {
    id: requireId(raw.id, 'Presupuesto'),
    name: cleanText(raw.name, LIMITS.name),
    categoryIds: ids === null ? null : [...new Set(ids.map((id) => requireId(id, 'Presupuesto')))],
    amount: positiveCents(raw.amount, 'Presupuesto'),
  };
}

/**
 * Hucha: un objetivo con fecha límite repartido en casillas de importes fijos que suman el objetivo.
 * Lo metido, las casillas pagadas y si se vació salen de sus movimientos de tipo 'piggy'.
 */
export function normalizePiggy(raw) {
  if (!isObject(raw)) fail('Hucha no válida.');
  const name = cleanText(raw.name, LIMITS.name) || fail('La hucha necesita un nombre.');
  const what = `Hucha «${name}»`;
  if (!isISODate(raw.startDate) || !isISODate(raw.deadline)) fail(`${what}: fechas no válidas.`);
  if (raw.deadline <= raw.startDate) fail(`${what}: la fecha límite debe ser posterior a hoy.`);
  if (!Array.isArray(raw.boxes) || raw.boxes.length === 0 || raw.boxes.length > LIMITS.boxes) fail(`${what}: casillas no válidas.`);
  const boxes = raw.boxes.map((box) => positiveCents(box, what));
  const goal = positiveCents(raw.goal, what);
  if (boxes.reduce((sum, box) => sum + box, 0) !== goal) fail(`${what}: las casillas no suman el objetivo.`);
  return {
    id: requireId(raw.id, what),
    name,
    icon: pick(raw.icon, PICKER_ICONS, 'pig-money'),
    color: pick(raw.color, COLOR_KEYS, 'green'),
    goal,
    startDate: raw.startDate,
    deadline: raw.deadline,
    boxes,
    order: orderOf(raw.order),
  };
}

/** Campos comunes de un movimiento y de la plantilla de un movimiento programado. */
function normalizeMovementFields(raw, what) {
  if (!isObject(raw)) fail(`${what}: formato no válido.`);
  const type = pick(raw.type, MOVEMENT_TYPES, null) ?? fail(`${what}: tipo no válido.`);
  const out = { type, amount: positiveCents(raw.amount, what) };
  if (type === 'debt') {
    out.debtId = requireId(raw.debtId, what);
    out.flow = pick(raw.flow, DEBT_FLOWS, null) ?? fail(`${what}: operación de deuda no válida.`);
    out.accountId = raw.accountId == null ? null : requireId(raw.accountId, what);
  } else if (type === 'piggy') {
    out.piggyId = requireId(raw.piggyId, what);
    out.flow = pick(raw.flow, PIGGY_FLOWS, null) ?? fail(`${what}: operación de hucha no válida.`);
    out.accountId = raw.accountId == null ? null : requireId(raw.accountId, what);
    const boxes = raw.boxes ?? [];
    if (!Array.isArray(boxes) || boxes.length > LIMITS.boxes || !boxes.every((i) => Number.isSafeInteger(i) && i >= 0 && i < LIMITS.boxes)) {
      fail(`${what}: casillas no válidas.`);
    }
    if (new Set(boxes).size !== boxes.length || (out.flow === 'out' && boxes.length)) fail(`${what}: casillas no válidas.`);
    out.boxes = [...boxes];
  } else {
    out.accountId = requireId(raw.accountId, what);
    if (type === 'transfer') {
      out.toAccountId = requireId(raw.toAccountId, what);
      if (out.toAccountId === out.accountId) fail(`${what}: el origen y el destino deben ser cuentas distintas.`);
    } else {
      out.categoryId = requireId(raw.categoryId, what);
    }
  }
  out.note = cleanText(raw.note, LIMITS.note);
  return out;
}

export function normalizeMovement(raw) {
  const what = 'Movimiento';
  if (!isObject(raw)) fail(`${what}: formato no válido.`);
  const movement = {
    id: requireId(raw.id, what),
    date: isISODate(raw.date) ? raw.date : fail(`${what}: fecha no válida.`),
    ...normalizeMovementFields(raw, what),
    ts: Number.isSafeInteger(raw.ts) && raw.ts >= 0 ? raw.ts : 0,
  };
  if (isId(raw.recurringId)) movement.recurringId = raw.recurringId;
  return movement;
}

export function normalizeRecurring(raw) {
  const what = 'Movimiento programado';
  if (!isObject(raw)) fail(`${what}: formato no válido.`);
  const interval = raw.interval ?? 1;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > MAX_INTERVAL) fail(`${what}: periodicidad no válida.`);
  if (!isISODate(raw.startDate)) fail(`${what}: fecha de inicio no válida.`);
  if (raw.endDate != null && (!isISODate(raw.endDate) || raw.endDate < raw.startDate)) fail(`${what}: fecha de fin no válida.`);
  const index = raw.index ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_RECURRING_INDEX) fail(`${what}: estado no válido.`);
  const recurring = {
    id: requireId(raw.id, what),
    active: raw.active !== false,
    frequency: pick(raw.frequency, FREQUENCIES, null) ?? fail(`${what}: frecuencia no válida.`),
    interval,
    startDate: raw.startDate,
    index,
    endDate: raw.endDate ?? null,
    anchorDay: Number.isInteger(raw.anchorDay) && raw.anchorDay >= 29 && raw.anchorDay <= 31 ? raw.anchorDay : null,
    template: normalizeMovementFields(raw.template, what),
  };
  if (recurring.template.type === 'piggy') fail(`${what}: no se pueden programar movimientos de huchas.`);
  return recurring;
}

export function normalizeSettings(raw) {
  const s = isObject(raw) ? raw : {};
  return {
    autoLockSec: pick(s.autoLockSec, AUTO_LOCK_VALUES, DEFAULT_AUTO_LOCK),
    lastBackupAt: Number.isSafeInteger(s.lastBackupAt) && s.lastBackupAt > 0 ? s.lastBackupAt : null,
    lastAccountId: isId(s.lastAccountId) ? s.lastAccountId : null,
    installHintDismissed: s.installHintDismissed === true,
    // Paneles visibles en Inicio, en orden (solo claves conocidas y sin repetir).
    homePanels: Array.isArray(s.homePanels)
      ? [...new Set(s.homePanels.filter((key) => HOME_PANEL_KEYS.includes(key)))]
      : [...DEFAULT_HOME_PANELS],
  };
}

// ---------------------------------------------------------------------------------------------
// Conjunto completo
// ---------------------------------------------------------------------------------------------

/**
 * Valida un conjunto de datos completo, incluida la integridad entre entidades.
 * - strict: true  → cualquier error rechaza todo (restaurar copias: fallar de forma cerrada).
 * - strict: false → se descartan los elementos inválidos (cargar datos propios sin bloquear la app).
 * Devuelve { data, dropped }.
 */
export function normalizeData(raw, { strict = true } = {}) {
  if (!isObject(raw)) fail('Los datos no tienen un formato válido.');
  if (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > SCHEMA_VERSION) {
    fail(Number.isInteger(raw.version) && raw.version > SCHEMA_VERSION
      ? 'Los datos son de una versión más nueva de la app. Actualiza la app e inténtalo de nuevo.'
      : 'Versión de datos no reconocida.');
  }
  let dropped = 0;
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (strict || !(error instanceof ValidationError)) throw error;
      dropped += 1;
      return null;
    }
  };
  const collect = (list, limit, label, normalize) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) fail(`${label}: formato no válido.`);
    if (list.length > limit) fail(`${label}: hay demasiados elementos (máximo ${limit}).`);
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const value = attempt(() => {
        const normalized = normalize(item);
        if (seen.has(normalized.id)) fail(`${label}: identificador repetido.`);
        return normalized;
      });
      if (value) {
        seen.add(value.id);
        out.push(value);
      }
    }
    return out;
  };

  const accounts = collect(raw.accounts, LIMITS.accounts, 'Cuentas', normalizeAccount);
  const categories = collect(raw.categories, LIMITS.categories, 'Categorías', normalizeCategory);
  const debts = collect(raw.debts, LIMITS.debts, 'Deudas', normalizeDebt);
  const accountIds = new Set(accounts.map((a) => a.id));
  const categoryKind = new Map(categories.map((c) => [c.id, c.kind]));
  const debtIds = new Set(debts.map((d) => d.id));
  const piggies = collect(raw.piggies, LIMITS.piggies, 'Huchas', normalizePiggy);
  const piggyById = new Map(piggies.map((p) => [p.id, p]));

  const checkRefs = (m, what) => {
    if (m.accountId !== null && !accountIds.has(m.accountId)) fail(`${what}: la cuenta no existe.`);
    if (m.type === 'transfer' && !accountIds.has(m.toAccountId)) fail(`${what}: la cuenta de destino no existe.`);
    if ((m.type === 'expense' || m.type === 'income') && categoryKind.get(m.categoryId) !== m.type) {
      fail(`${what}: la categoría no existe o no corresponde al tipo.`);
    }
    if (m.type === 'debt' && !debtIds.has(m.debtId)) fail(`${what}: la deuda no existe.`);
    if (m.type === 'piggy' && !piggyById.has(m.piggyId)) fail(`${what}: la hucha no existe.`);
    return m;
  };

  const recurring = collect(raw.recurring, LIMITS.recurring, 'Programados', (item) => {
    const r = normalizeRecurring(item);
    checkRefs(r.template, 'Movimiento programado');
    return r;
  });
  const recurringIds = new Set(recurring.map((r) => r.id));

  let movements = collect(raw.movements, LIMITS.movements, 'Movimientos', (item) => {
    const m = checkRefs(normalizeMovement(item), 'Movimiento');
    if (m.recurringId && !recurringIds.has(m.recurringId)) delete m.recurringId;
    return m;
  });

  // Huchas, en orden de creación: cada casilla se paga una sola vez, nunca se tacha más de lo metido
  // y vaciarla (una única vez, todo lo metido) la cierra.
  const tracks = new Map(piggies.map((p) => [p.id, { paid: new Set(), deposited: 0, paidAmount: 0, closed: false }]));
  const rejected = new Set();
  const piggyMoves = movements.filter((m) => m.type === 'piggy').sort((a, b) => a.ts - b.ts || (a.date < b.date ? -1 : 1));
  for (const m of piggyMoves) {
    const ok = attempt(() => {
      const piggy = piggyById.get(m.piggyId);
      const t = tracks.get(m.piggyId);
      const what = `Hucha «${piggy.name}»`;
      if (t.closed) fail(`${what}: tiene movimientos después de vaciarla.`);
      if (m.flow === 'out') {
        if (m.amount !== t.deposited) fail(`${what}: al vaciarla hay que sacar todo lo metido.`);
        t.closed = true;
        return true;
      }
      let sum = 0;
      for (const i of m.boxes) {
        if (i >= piggy.boxes.length || t.paid.has(i)) fail(`${what}: casilla no válida o ya pagada.`);
        sum += piggy.boxes[i];
      }
      if (t.paidAmount + sum > t.deposited + m.amount) fail(`${what}: hay casillas tachadas sin dinero suficiente.`);
      for (const i of m.boxes) t.paid.add(i);
      t.paidAmount += sum;
      t.deposited += m.amount;
      return true;
    });
    if (!ok) rejected.add(m);
  }
  if (rejected.size) movements = movements.filter((m) => !rejected.has(m));

  // Una categoría puede estar en varios presupuestos; el total del mes solo puede haber uno.
  let hasTotal = false;
  const budgets = collect(raw.budgets, LIMITS.budgets, 'Presupuestos', (item) => {
    const b = normalizeBudget(item);
    if (b.categoryIds === null) {
      if (hasTotal) fail('Solo puede haber un presupuesto total del mes.');
      hasTotal = true;
    } else if (b.categoryIds.some((id) => categoryKind.get(id) !== 'expense')) {
      fail('Presupuesto: la categoría no existe o no es de gasto.');
    }
    return b;
  });

  const settings = normalizeSettings(raw.settings);
  // Datos anteriores a las huchas: su panel aparece en Inicio (después de los presupuestos).
  if (raw.version < 3 && !settings.homePanels.includes('piggies')) {
    const at = settings.homePanels.indexOf('budgets');
    settings.homePanels.splice(at < 0 ? settings.homePanels.length : at + 1, 0, 'piggies');
  }
  if (settings.lastAccountId && !accountIds.has(settings.lastAccountId)) settings.lastAccountId = null;

  const byOrder = (a, b) => a.order - b.order;
  accounts.sort(byOrder).forEach((a, i) => { a.order = i; });
  categories.sort(byOrder).forEach((c, i) => { c.order = i; });
  piggies.sort(byOrder).forEach((p, i) => { p.order = i; });

  return {
    data: { version: SCHEMA_VERSION, settings, accounts, categories, debts, budgets, piggies, recurring, movements },
    dropped,
  };
}

/** Datos de una instalación nueva: cuentas y categorías de ejemplo, sin movimientos. */
export function createInitialState() {
  return {
    version: SCHEMA_VERSION,
    settings: normalizeSettings({}),
    accounts: DEFAULT_ACCOUNTS.map((a, i) => ({
      id: newId(), letters: '', initial: 0, includeInTotal: true, archived: false, order: i, ...a,
    })),
    categories: DEFAULT_CATEGORIES.map((c, i) => ({ id: newId(), archived: false, order: i, ...c })),
    debts: [],
    budgets: [],
    piggies: [],
    recurring: [],
    movements: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Bloques de almacenamiento: 'core' (todo menos movimientos) + 'mov-AAAA' (movimientos de un año).
// Guardar un movimiento solo recifra su año, no todo el historial.
// ---------------------------------------------------------------------------------------------

const MOVEMENT_BUCKET_RE = /^mov-\d{4}$/;
export const movementBucket = (date) => `mov-${date.slice(0, 4)}`;
export const isBucketKey = (key) => key === CORE_BUCKET || MOVEMENT_BUCKET_RE.test(key);

export function buildBucket(state, key) {
  if (key === CORE_BUCKET) {
    const { movements, ...core } = state;
    return core;
  }
  const prefix = `${key.slice(4)}-`;
  return { movements: state.movements.filter((m) => m.date.startsWith(prefix)) };
}

export function allBucketKeys(state) {
  const keys = new Set([CORE_BUCKET]);
  for (const m of state.movements) keys.add(movementBucket(m.date));
  return keys;
}

/** Une los bloques descifrados en un único objeto (aún sin validar). */
export function mergeBuckets(buckets) {
  const core = buckets.get(CORE_BUCKET);
  if (!isObject(core)) fail('Faltan los datos principales.');
  const movements = [];
  for (const [key, value] of buckets) {
    if (!MOVEMENT_BUCKET_RE.test(key) || !Array.isArray(value?.movements)) continue;
    for (const m of value.movements) movements.push(m);
  }
  return { ...core, movements };
}
