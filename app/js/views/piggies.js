// Huchas: retos de ahorro por casillas. Lista con el total ahorrado, detalle con su análisis, la
// cuadrícula de casillas y el historial, y las hojas para crear una hucha, meter dinero y vaciarla.

import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  section, list, row, tile, field, textInput, amountInput, dateInput, readDate, errorText, emptyState,
  segmented, chipPicker, iconPicker, colorPicker, progress,
} from '../ui/components.js';
import { lookups, shortDate } from '../ui/format.js';
import { openSheet, confirmDialog } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { rerender } from '../ui/shell.js';
import { registerViewReset } from '../ui/session.js';
import * as router from '../ui/router.js';
import * as store from '../core/store.js';
import { ValidationError, LIMITS } from '../core/model.js';
import { formatEuros, parseAmount } from '../core/money.js';
import { todayISO, addDays, addYears, diffDays, currentMonthKey, addMonthKey } from '../core/dates.js';
import {
  DENOMINATIONS, DEFAULT_DENOMINATIONS, BOX_PRESETS, planBoxes, autoBigCount, bigRange, goalRange,
  chooseBoxes, groupBoxes, analyzePiggy,
} from '../core/piggy.js';
import { selectableAccounts } from './movement-form.js';

const LEVELS = {
  start: { label: 'Recién creada', badge: '', bar: 'ok' },
  ok: { label: 'Vas bien', badge: 'ok', bar: 'ok' },
  warn: { label: 'Vas justo', badge: 'warn', bar: 'warn' },
  behind: { label: 'Vas por detrás', badge: 'danger', bar: 'warn' },
  late: { label: 'Fuera de plazo', badge: 'danger', bar: 'over' },
  done: { label: '¡Conseguida!', badge: 'ok', bar: 'ok' },
  closed: { label: 'Vaciada', badge: '', bar: 'ok' },
};

// Cómo se ve la cuadrícula (por sesión).
let gridOrder = 'mixed';
let hidePaid = false;
registerViewReset(() => {
  gridOrder = 'mixed';
  hidePaid = false;
});

const pct = (ratio) => `${Math.round(Math.max(0, ratio) * 100)} %`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const groupText = (groups) => groups.map((g) => `${g.count} × ${formatEuros(g.amount)}`).join(', ');
/** Por semana, en euros redondeados hacia arriba: «58 €» se entiende mejor que «57,59 €». */
const weekly = (cents) => formatEuros(Math.ceil(cents / 100) * 100);
/** «+207 €» / «−35 €» (euros enteros). */
const signedEuros = (cents) => `${cents < 0 ? '−' : '+'}${formatEuros(Math.round(Math.abs(cents) / 100) * 100)}`;

/**
 * Lo que la persona suele ahorrar y lo que lleva este mes, para los consejos del análisis.
 * Media de ingresos menos gastos de los 3 meses anteriores (solo los que tienen movimientos).
 */
function moneyContext(state, derived) {
  const month = currentMonthKey();
  const nets = [1, 2, 3]
    .map((i) => derived.period(addMonthKey(month, -i)))
    .filter((p) => p.income || p.expense)
    .map((p) => p.income - p.expense);
  const current = derived.period(month);
  const top = derived.byCategory(month, 'expense')[0];
  const category = top ? state.categories.find((c) => c.id === top.categoryId) : null;
  return {
    avgMonthlySaving: nets.length ? Math.round(nets.reduce((a, b) => a + b, 0) / nets.length) : 0,
    monthNet: current.income - current.expense,
    topCategory: category ? { name: category.name, amount: top.amount } : null,
  };
}

/** Fila de una hucha: símbolo, progreso, días que quedan y si vas bien. */
export function piggyItem(piggy, status, today, { onClick = null } = {}) {
  const a = analyzePiggy(piggy, status, today);
  const level = LEVELS[a.level];
  const running = ['start', 'ok', 'warn', 'behind'].includes(a.level);
  const days = running ? (a.daysLeft > 1 ? plural(a.daysLeft, 'día', 'días') : 'Último día') : null;
  return h(onClick ? 'button' : 'div', { type: onClick ? 'button' : null, class: ['budget', onClick && 'row'], onClick },
    h('span', { class: 'row-main' },
      h('span', { class: 'budget-top' },
        tile(piggy, 'sm'),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title' }, piggy.name),
          h('span', { class: 'row-sub' }, [`${formatEuros(status.deposited)} de ${formatEuros(piggy.goal)}`, days].filter(Boolean).join(' · '))),
        h('span', { class: ['badge', level.badge] }, running ? pct(a.ratio) : level.label)),
      progress(a.ratio, level.bar, `${piggy.name}: ${pct(a.ratio)} ahorrado`),
      running || a.level === 'late'
        ? h('span', { class: 'budget-meta' },
          h('span', { class: { ok: 'pos', warn: 'warn', behind: 'neg', late: 'neg' }[a.level] ?? 'muted' }, running ? level.label : ''),
          h('span', null, `Faltan ${formatEuros(a.remaining)}`))
        : null));
}

// --- Lista -----------------------------------------------------------------------------------------

export function piggiesView() {
  const state = store.getState();
  const derived = store.derived();
  const today = todayISO();
  const piggies = [...state.piggies].sort((a, b) => a.order - b.order);
  const open = piggies.filter((p) => !derived.piggies.get(p.id).closed);
  const closed = piggies.filter((p) => derived.piggies.get(p.id).closed);
  const saved = open.reduce((sum, p) => sum + derived.piggies.get(p.id).deposited, 0);
  const goals = open.reduce((sum, p) => sum + p.goal, 0);
  const item = (p) => piggyItem(p, derived.piggies.get(p.id), today, { onClick: () => router.navigate(`/mas/huchas/${p.id}`) });

  return {
    title: 'Huchas',
    back: { label: 'Más', path: '/mas' },
    body: [
      open.length
        ? h('section', { class: 'card', 'aria-label': 'Total ahorrado' },
          h('p', { class: 'hero-label' }, 'Total ahorrado'),
          h('p', { class: 'hero-value pos' }, formatEuros(saved)),
          h('p', { class: 'muted' }, `de ${formatEuros(goals)}`))
        : null,
      open.length
        ? list(open.map(item))
        : h('div', { class: 'card' }, emptyState('pig-money', 'Sin huchas', 'Ahorra para algo concreto casilla a casilla: por ejemplo, 1.000 € para una consola en 100 casillas de 2 a 20 €.')),
      h('button', { type: 'button', class: 'btn primary', onClick: () => openPiggyForm() }, icon('plus'), 'Nueva hucha'),
      closed.length ? section({ title: 'Terminadas' }, list(closed.map(item))) : null,
    ],
  };
}

// --- Detalle ---------------------------------------------------------------------------------------

function analysisCard(piggy, status, a) {
  const level = LEVELS[a.level];
  const lines = [];
  if (a.level === 'closed') {
    const out = status.history.at(-1);
    lines.push(`La vaciaste el ${shortDate(out.date)} con ${formatEuros(out.amount)} (${pct(status.deposited / piggy.goal)} del objetivo).`);
  } else if (a.level === 'done') {
    lines.push(`¡Lo has conseguido! Has metido ${formatEuros(status.deposited)} de ${formatEuros(piggy.goal)}. Cuando vayas a usar el dinero, vacía la hucha.`);
  } else if (a.level === 'late') {
    lines.push(`La fecha límite era el ${shortDate(piggy.deadline)} y faltan ${formatEuros(a.remaining)}. Puedes ampliarla en Editar.`);
  } else if (a.level === 'start') {
    lines.push(`Para llegar el ${shortDate(piggy.deadline)}, el plan es meter unos ${weekly(a.planWeekly)} a la semana (${formatEuros(a.neededDaily)} al día). Empieza cuando quieras: cada casilla cuenta.`);
  } else {
    const plan = weekly(a.planWeekly) === weekly(a.neededWeekly) ? '' : ` (el plan era de ${weekly(a.planWeekly)}/semana)`;
    const due = a.expected >= 100 ? `Hoy tocaba llevar ${formatEuros(Math.round(a.expected / 100) * 100)}. ` : '';
    lines.push(`${due}Para acabar el ${shortDate(piggy.deadline)} te ${a.diff >= 0 ? 'bastan' : 'hacen falta'} ${weekly(a.neededWeekly)}/semana${plan}.`);
    if (a.projection) {
      const days = Math.abs(a.projection.daysVsDeadline);
      lines.push(a.projection.daysVsDeadline <= 0
        ? `A tu ritmo (≈ ${weekly(a.projection.perWeek)}/semana) acabarás el ${shortDate(a.projection.finish)}${days ? `, ${plural(days, 'día', 'días')} antes de tiempo` : ''}.`
        : `A tu ritmo (≈ ${weekly(a.projection.perWeek)}/semana) acabarías el ${shortDate(a.projection.finish)}, ${plural(days, 'día', 'días')} tarde.`);
    }
  }
  const tips = a.tips.map((t) => {
    if (t.kind === 'saving-ok') return `Sueles ahorrar unos ${formatEuros(Math.round(t.avgMonthlySaving / 100) * 100)} al mes (ingresos menos gastos) y esta hucha necesita ${weekly(t.neededMonthly)} al mes: te llega.`;
    if (t.kind === 'saving-short') return `Esta hucha necesita ${weekly(t.neededMonthly)} al mes y sueles ahorrar unos ${formatEuros(Math.round(t.avgMonthlySaving / 100) * 100)}. A ese ritmo llegarías el ${shortDate(t.reachable)}: alarga el plazo o recorta algún gasto.`;
    if (t.kind === 'month-left') return `Este mes llevas ${formatEuros(t.monthNet)} de ingresos menos gastos: si metes ${weekly(t.suggestion)} ahora, vas por delante.`;
    if (t.kind === 'cut') {
      return t.daysSooner > 0
        ? `Tu mayor gasto del mes es ${t.category} (${formatEuros(t.amount)}). Recortarlo un 10 % (${formatEuros(t.cut)}) adelantaría la hucha unos ${plural(t.daysSooner, 'día', 'días')}.`
        : `Tu mayor gasto del mes es ${t.category} (${formatEuros(t.amount)}): recortarlo un 10 % serían ${formatEuros(t.cut)} más para la hucha.`;
    }
    return null;
  }).filter(Boolean);

  const bar = (label, ratio, level2) => h('div', { class: 'piggy-bar' },
    h('span', { class: 'muted' }, label), progress(ratio, level2, label), h('span', null, pct(ratio)));
  return section({ title: 'Análisis' },
    h('div', { class: ['card', 'piggy-analysis', `is-${a.level}`] },
      h('div', { class: 'card-head' },
        h('strong', { class: 'piggy-level' }, h('span', { class: ['badge', level.badge] }, level.label)),
        a.level === 'ok' || a.level === 'warn' || a.level === 'behind'
          ? h('span', { class: a.diff >= 0 ? 'pos' : 'neg' }, `${signedEuros(a.diff)} ${a.diff >= 0 ? 'sobre el plan' : 'respecto al plan'}`)
          : null),
      a.level === 'closed' ? null : [bar('Ahorrado', a.ratio, 'ok'), bar('Tiempo', a.timeRatio, '')],
      lines.map((text) => h('p', null, text)),
      a.streak > 1 ? h('p', { class: 'piggy-tip' }, icon('flame'), `Llevas ${a.streak} semanas seguidas metiendo dinero.`) : null,
      tips.map((text) => h('p', { class: 'piggy-tip' }, icon('bulb'), text))));
}

function boxGrid(piggy, status) {
  const items = piggy.boxes.map((amount, index) => ({ amount, index, paid: status.paid.get(index) }));
  if (gridOrder === 'amount') items.sort((a, b) => a.amount - b.amount || a.index - b.index);
  const visible = hidePaid ? items.filter((b) => !b.paid) : items;
  const grid = h('div', { class: 'box-grid', role: 'group', 'aria-label': 'Casillas' }, visible.map((b) => h('button', {
    type: 'button',
    class: 'box',
    'aria-pressed': String(Boolean(b.paid)),
    'aria-label': `${formatEuros(b.amount)}${b.paid ? ', pagada' : ''}`,
    onClick: () => {
      if (b.paid) toast(`Casilla de ${formatEuros(b.amount)} pagada el ${shortDate(b.paid.date)}.`);
      else if (!status.closed) openDeposit(piggy, { boxIndex: b.index });
    },
  }, formatEuros(b.amount).replace(/\s?€/, ''))));
  return section({ title: `Casillas · ${status.paidCount}/${piggy.boxes.length}` },
    h('div', { class: 'piggy-grid-tools' },
      segmented([{ value: 'mixed', label: 'Mezcladas' }, { value: 'amount', label: 'Por importe' }], gridOrder, (value) => { gridOrder = value; rerender(); }, { label: 'Orden de las casillas' }),
      h('button', { type: 'button', class: 'chip text-only', 'aria-pressed': String(hidePaid), onClick: () => { hidePaid = !hidePaid; rerender(); } }, 'Ocultar pagadas')),
    visible.length ? grid : h('div', { class: 'card' }, emptyState('circle-check', 'Todas las casillas están pagadas')),
    status.closed ? null : h('p', { class: 'caption' }, 'Toca una casilla para meter justo ese importe.'));
}

function historySection(piggy, status, look) {
  const moves = [...status.history].reverse();
  if (!moves.length) return null;
  const rows = moves.map((m, i) => {
    const account = look.accounts.get(m.accountId)?.name ?? 'Sin cuenta';
    const what = m.flow === 'in'
      ? (m.boxes.length ? `${plural(m.boxes.length, 'casilla', 'casillas')}: ${groupText(groupBoxes(piggy.boxes, m.boxes))}` : 'Sin completar casillas (queda suelto)')
      : 'Hucha vaciada';
    return row({
      lead: tile({ icon: m.flow === 'in' ? 'plus' : 'download', color: m.flow === 'in' ? 'green' : 'blue' }),
      title: `${shortDate(m.date)} · ${account}`,
      subtitle: what,
      value: m.flow === 'in' ? `+${formatEuros(m.amount)}` : `−${formatEuros(m.amount)}`,
      valueClass: m.flow === 'in' ? 'pos' : '',
      trailing: i === 0
        ? h('button', { type: 'button', class: 'btn-text', onClick: () => undoLast(piggy, m) }, 'Deshacer')
        : null,
    });
  });
  return section({ title: 'Historial', caption: 'Solo se puede deshacer lo último: lo anterior puede depender de ello.' }, list(rows));
}

async function undoLast(piggy, m) {
  const confirmed = await confirmDialog({
    title: m.flow === 'in' ? `¿Deshacer el ingreso de ${formatEuros(m.amount)}?` : '¿Deshacer el vaciado?',
    text: m.flow === 'in'
      ? `${m.boxes.length ? `Se desmarcarán ${plural(m.boxes.length, 'casilla', 'casillas')}. ` : ''}${m.accountId ? 'El dinero vuelve a su cuenta.' : ''}`.trim()
      : 'La hucha vuelve a estar abierta con su dinero.',
    confirmLabel: 'Deshacer',
  });
  if (!confirmed) return;
  store.undoLastPiggyMovement(piggy.id);
  toast('Deshecho');
}

export function piggyDetailView({ id }) {
  const state = store.getState();
  const piggy = state.piggies.find((p) => p.id === id);
  if (!piggy) return null;
  const derived = store.derived();
  const status = derived.piggies.get(id);
  const today = todayISO();
  const a = analyzePiggy(piggy, status, today, moneyContext(state, derived));
  const look = lookups(state);
  const expectedRatio = Math.min(1, a.expected / piggy.goal);

  return {
    title: piggy.name,
    back: { label: 'Huchas', path: '/mas/huchas' },
    actions: [h('button', { type: 'button', class: 'btn-text', onClick: () => openPiggyForm({ piggy }) }, 'Editar')],
    body: [
      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', null,
            h('p', { class: 'hero-label' }, status.closed ? 'Llegaste a ahorrar' : 'Ahorrado'),
            h('p', { class: 'hero-value' }, formatEuros(status.deposited), h('small', { class: 'muted' }, ` de ${formatEuros(piggy.goal)}`))),
          tile(piggy, 'lg')),
        h('div', { class: 'piggy-progress' },
          progress(a.ratio, LEVELS[a.level].bar, `Ahorrado: ${pct(a.ratio)}`),
          a.level === 'ok' || a.level === 'warn' || a.level === 'behind'
            ? h('span', { class: 'piggy-marker', style: { left: `${expectedRatio * 100}%` }, title: 'Dónde deberías ir hoy', 'aria-hidden': 'true' })
            : null),
        h('div', { class: 'budget-meta' },
          h('span', null, pct(a.ratio)),
          h('span', null, a.remaining ? `Faltan ${formatEuros(a.remaining)}` : 'Objetivo conseguido')),
        status.loose > 0 && !status.closed
          ? h('p', { class: 'muted' }, `${formatEuros(status.loose)} sueltos: se usarán en el próximo ingreso.`)
          : null),
      status.closed ? null : h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', onClick: () => openDeposit(piggy) }, icon('plus'), 'Meter dinero'),
        // Conseguida: vaciarla es el paso natural; antes, la opción queda al final (abajo).
        a.level === 'done' ? h('button', { type: 'button', class: 'btn', onClick: () => openEmpty(piggy, status) }, 'Vaciar la hucha') : null),
      analysisCard(piggy, status, a),
      a.level === 'closed' ? null : h('div', { class: 'stats two card' },
        stat('Casillas', `${status.paidCount} / ${piggy.boxes.length}`),
        stat('Días restantes', a.level === 'late' ? '0' : String(a.daysLeft)),
        stat('Por semana', weekly(a.neededWeekly)),
        stat('Por día', formatEuros(a.neededDaily))),
      boxGrid(piggy, status),
      historySection(piggy, status, look),
      !status.closed && status.deposited > 0 && a.level !== 'done'
        ? h('button', { type: 'button', class: 'btn', onClick: () => openEmpty(piggy, status) }, 'Vaciar la hucha antes de tiempo')
        : null,
    ],
  };
}

const stat = (label, value) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, value));

// --- Meter dinero, vaciar ----------------------------------------------------------------------------

function accountField(selected, onSelect, help) {
  const accounts = selectableAccounts(store.getState(), selected);
  return h('div', { class: 'field' },
    h('span', { class: 'field-label' }, 'Sale de la cuenta (opcional)'),
    chipPicker(accounts, selected, onSelect, { label: 'Cuenta', none: 'Ninguna' }),
    h('p', { class: 'help' }, help));
}

/** Meter dinero: un importe libre (tacha las casillas que quepan) o justo el de una casilla. */
export function openDeposit(piggy, { boxIndex = null } = {}) {
  const status = store.piggyInfo(piggy.id);
  const draft = { accountId: null };
  const fixed = boxIndex !== null ? piggy.boxes[boxIndex] : null;
  const amount = fixed === null ? amountInput({ label: '¿Cuánto has metido?' }) : null;
  const preview = h('p', { class: 'help', 'aria-live': 'polite' });
  const error = errorText();

  const current = () => (fixed !== null ? fixed : parseAmount(amount.input.value) ?? 0);
  const updatePreview = () => {
    const value = current();
    if (fixed !== null || value <= 0) {
      preview.textContent = fixed !== null ? `Se marcará esta casilla de ${formatEuros(fixed)}.` : '';
      return;
    }
    const pick = chooseBoxes(piggy.boxes, status.paid, value + status.loose);
    const left = value + status.loose - pick.sum;
    preview.textContent = pick.indexes.length
      ? `✓ Se ${pick.indexes.length === 1 ? 'marcará 1 casilla' : `marcarán ${pick.indexes.length} casillas`}: ${groupText(groupBoxes(piggy.boxes, pick.indexes))}.${left ? ` Quedan ${formatEuros(left)} sueltos para la próxima.` : ''}`
      : `No completa ninguna casilla: se guarda suelto para la próxima${status.loose ? ` (con lo suelto, ${formatEuros(value + status.loose)})` : ''}.`;
  };
  amount?.input.addEventListener('input', updatePreview);

  const quick = fixed === null
    ? h('div', { class: 'quick' },
      [200, 500, 1000, 2000].map((cents) => h('button', {
        type: 'button',
        class: 'chip text-only',
        onClick: () => {
          amount.set((parseAmount(amount.input.value) ?? 0) + cents);
          updatePreview();
        },
      }, `+${formatEuros(cents)}`)),
      h('button', { type: 'button', class: 'chip text-only', onClick: () => { amount.input.value = ''; updatePreview(); } }, 'Borrar'))
    : null;

  const save = () => {
    error.textContent = '';
    const cents = fixed ?? amount.read();
    if (cents === null) return;
    try {
      const created = store.depositToPiggy(piggy.id, { amount: cents, accountId: draft.accountId, boxes: fixed !== null ? [boxIndex] : null });
      sheet.close();
      toast(`+${formatEuros(cents)} en «${piggy.name}»`, {
        action: {
          label: 'Deshacer',
          onClick: () => {
            if (store.piggyInfo(piggy.id).history.at(-1)?.id === created.id) store.deleteMovement(created.id);
          },
        },
      });
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      error.textContent = e.message;
    }
  };

  updatePreview();
  const sheet = openSheet({
    title: fixed !== null ? `Casilla de ${formatEuros(fixed)}` : 'Meter dinero',
    tall: true,
    primary: { label: 'Guardar', onClick: save },
    body: [
      amount ? amount.el : h('p', { class: 'hero-value' }, formatEuros(fixed)),
      quick,
      preview,
      accountField(null, (id) => { draft.accountId = id; }, 'Si el dinero sale de una cuenta, su saldo bajará. Deja «Ninguna» si es una hucha física.'),
      error,
      h('button', { type: 'button', class: 'btn primary', onClick: save }, 'Guardar'),
    ],
  });
}

function openEmpty(piggy, status) {
  const draft = { accountId: null };
  const error = errorText();
  const save = async () => {
    const confirmed = await confirmDialog({
      title: `¿Vaciar «${piggy.name}»?`,
      text: `Sacas los ${formatEuros(status.deposited)} y la hucha queda terminada.`,
      confirmLabel: 'Vaciar',
    });
    if (!confirmed) return;
    try {
      store.emptyPiggy(piggy.id, { accountId: draft.accountId });
      sheet.close();
      toast('Hucha vaciada');
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      error.textContent = e.message;
    }
  };
  const sheet = openSheet({
    title: 'Vaciar la hucha',
    body: [
      h('p', { class: 'help' }, status.deposited >= piggy.goal
        ? `¡Enhorabuena! Sacas los ${formatEuros(status.deposited)} para usarlos.`
        : `Aún no has llegado al objetivo: sacas los ${formatEuros(status.deposited)} que llevas y la hucha se da por terminada.`),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, '¿A qué cuenta va el dinero?'),
        chipPicker(selectableAccounts(store.getState(), null), null, (id) => { draft.accountId = id; }, { label: 'Cuenta', none: 'Ninguna' }),
        h('p', { class: 'help' }, 'Su saldo subirá. Deja «Ninguna» si lo gastas directamente.')),
      error,
      h('button', { type: 'button', class: 'btn primary', onClick: save }, 'Vaciar'),
    ],
  });
}

// --- Crear y editar ------------------------------------------------------------------------------------

/** Nueva hucha (con el reparto de casillas) o cambiar nombre, fecha límite, símbolo y color. */
export function openPiggyForm({ piggy = null } = {}) {
  const editing = piggy !== null;
  const today = todayISO();
  const draft = {
    icon: piggy?.icon ?? 'pig-money',
    color: piggy?.color ?? 'green',
    count: 100,
    denominations: new Set(DEFAULT_DENOMINATIONS),
    plan: null,
  };
  const name = textInput({ value: piggy?.name ?? '', placeholder: 'Por ejemplo: Vacaciones 2027', maxLength: LIMITS.name });
  const deadline = dateInput(piggy?.deadline ?? addYears(today, 1));
  deadline.min = addDays(editing ? piggy.startDate : today, 1);
  const error = errorText();
  const preview = h('div', { class: 'preview' });
  const refreshTile = () => replace(preview, tile({ icon: draft.icon, color: draft.color }, 'lg'));
  const icons = iconPicker(draft.icon, draft.color, (value) => { draft.icon = value; refreshTile(); });
  refreshTile();

  // Reparto de casillas (solo al crear).
  const goal = editing ? null : amountInput({ label: 'Objetivo', compact: true });
  const count = h('input', { class: 'input', type: 'text', inputmode: 'numeric', value: String(draft.count), 'aria-label': 'Número de casillas', autocomplete: 'off' });
  const big = h('input', { class: 'input', type: 'text', inputmode: 'numeric', 'aria-label': 'Casillas del importe más alto', autocomplete: 'off' });
  const presets = h('div', { class: 'chips wrap', role: 'group', 'aria-label': 'Número de casillas habituales' });
  const denominationChips = h('div', { class: 'chips wrap', role: 'group', 'aria-label': 'Importes de las casillas' });
  const bigLabel = h('span', { class: 'field-label' });
  const bigBox = h('div', { class: 'field' }, bigLabel, big, h('p', { class: 'help' }, 'Vacío = automático.'));
  const summary = h('div', { class: 'card piggy-plan', 'aria-live': 'polite' });

  const readInt = (input) => (/^\d{1,4}$/.test(input.value.trim()) ? Number(input.value.trim()) : null);
  const goalCents = () => (goal ? parseAmount(goal.input.value) : null);

  const renderPresets = () => replace(presets, BOX_PRESETS.map((p) => h('button', {
    type: 'button',
    class: 'chip text-only',
    'aria-pressed': String(readInt(count) === p.count),
    onClick: () => {
      count.value = String(p.count);
      recompute();
    },
  }, p.label)));

  const renderDenominations = () => replace(denominationChips, DENOMINATIONS.map((amount) => h('button', {
    type: 'button',
    class: 'chip text-only',
    'aria-pressed': String(draft.denominations.has(amount)),
    onClick: () => {
      if (!draft.denominations.delete(amount)) draft.denominations.add(amount);
      big.value = '';
      recompute();
    },
  }, formatEuros(amount))));

  function recompute() {
    renderPresets();
    renderDenominations();
    const g = goalCents();
    const n = readInt(count);
    const denoms = [...draft.denominations].sort((a, b) => a - b);
    const top = denoms.at(-1);
    bigBox.hidden = denoms.length < 2;
    const auto = g && n && denoms.length ? autoBigCount(g, n, denoms) : null;
    bigLabel.textContent = top ? `¿Cuántas casillas de ${formatEuros(top)}?` : '';
    big.placeholder = auto !== null ? `auto (${auto})` : 'auto';
    draft.plan = null;
    if (!g || g <= 0) return replace(summary, h('p', { class: 'muted' }, 'Escribe el objetivo para ver el reparto de casillas.'));
    if (!n || n < 1 || n > LIMITS.boxes) return replace(summary, h('p', { class: 'warn' }, `El número de casillas va de 1 a ${LIMITS.boxes}.`));
    if (!denoms.length) return replace(summary, h('p', { class: 'warn' }, 'Elige al menos un importe para las casillas.'));
    const range = goalRange(n, denoms);
    if (g < range.min || g > range.max) {
      return replace(summary, h('p', { class: 'warn' }, `Con ${n} casillas de ${formatEuros(denoms[0])} a ${formatEuros(top)}, el objetivo tiene que estar entre ${formatEuros(range.min)} y ${formatEuros(range.max)}.`));
    }
    const bigCount = big.value.trim() === '' ? null : readInt(big);
    const limits = bigRange(g, n, denoms);
    if (bigCount !== null && limits && (bigCount < limits.min || bigCount > limits.max)) {
      return replace(summary, h('p', { class: 'warn' }, `Con estos datos, las casillas de ${formatEuros(top)} tienen que ser entre ${limits.min} y ${limits.max}.`));
    }
    draft.plan = planBoxes({ goal: g, count: n, denominations: denoms, bigCount });
    if (!draft.plan) {
      return replace(summary, h('p', { class: 'warn' }, 'No hay un reparto exacto con esos importes. Cambia un poco el objetivo, el número de casillas o los importes.'));
    }
    const day = readDate(deadline);
    const days = day ? Math.max(1, diffDays(today, day)) : null;
    replace(summary,
      h('p', null, h('strong', null, plural(n, 'casilla', 'casillas')),
        days ? ` · unos ${weekly(Math.round((g * 7) / days))} por semana durante ${plural(days, 'día', 'días')}` : ''),
      h('div', { class: 'chips wrap' }, draft.plan.counts.slice().reverse().map((c) => h('span', { class: 'chip text-only static' }, `${c.count} × ${formatEuros(c.amount)}`))),
      h('button', { type: 'button', class: 'btn-text', onClick: recompute }, icon('refresh'), 'Otra distribución'));
    return null;
  }

  if (!editing) {
    goal.input.addEventListener('input', recompute);
    count.addEventListener('input', recompute);
    big.addEventListener('input', recompute);
    deadline.addEventListener('change', recompute);
    recompute();
  }

  const save = () => {
    error.textContent = '';
    const day = readDate(deadline);
    if (!day || day <= (editing ? piggy.startDate : today)) {
      error.textContent = 'Elige una fecha límite posterior a hoy.';
      return;
    }
    try {
      if (editing) {
        store.updatePiggy(piggy.id, { name: name.value, deadline: day, icon: draft.icon, color: draft.color });
        sheet.close();
        toast('Hucha guardada');
        return;
      }
      if (goal.read() === null) return;
      if (!draft.plan) {
        error.textContent = 'Ajusta el reparto de casillas (mira el aviso de arriba).';
        return;
      }
      const created = store.addPiggy({ name: name.value, icon: draft.icon, color: draft.color, goal: goalCents(), deadline: day, boxes: draft.plan.boxes });
      sheet.close();
      toast('Hucha creada');
      router.navigate(`/mas/huchas/${created.id}`);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      error.textContent = e.message;
    }
  };

  const remove = async () => {
    const info = store.piggyInfo(piggy.id);
    const confirmed = await confirmDialog({
      title: `¿Borrar «${piggy.name}»?`,
      text: info.history.length
        ? `Se borrará con su historial (${plural(info.history.length, 'movimiento', 'movimientos')}). El dinero que salió de tus cuentas volverá a ellas. No se puede deshacer.`
        : 'No se puede deshacer.',
      confirmLabel: 'Borrar',
      danger: true,
    });
    if (!confirmed) return;
    store.deletePiggy(piggy.id);
    sheet.close();
    router.back('/mas/huchas');
    toast('Hucha borrada');
  };

  const sheet = openSheet({
    title: editing ? 'Editar hucha' : 'Nueva hucha',
    tall: true,
    primary: { label: 'Guardar', onClick: save },
    body: [
      preview,
      field('Nombre', name),
      editing ? null : h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Objetivo'), goal.el),
      field('Fecha límite', deadline),
      editing
        ? h('p', { class: 'help' }, `Objetivo: ${formatEuros(piggy.goal)} en ${plural(piggy.boxes.length, 'casilla', 'casillas')}. Para cambiarlo, crea otra hucha.`)
        : [
          field('Número de casillas', count),
          presets,
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Importes de las casillas'), denominationChips),
          bigBox,
          summary,
        ],
      field('Símbolo', icons.el),
      field('Color', colorPicker(draft.color, (value) => { draft.color = value; icons.setColor(value); refreshTile(); })),
      error,
      h('button', { type: 'button', class: 'btn primary', onClick: save }, 'Guardar'),
      editing ? h('button', { type: 'button', class: 'btn danger', onClick: remove }, 'Borrar hucha') : null,
    ],
  });
}
