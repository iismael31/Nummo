// Análisis de un mes o de un año: resumen, reparto por categoría, presupuestos (mes), mes a mes (año)
// y evolución de ingresos, gastos y patrimonio.

import { h } from '../ui/dom.js';
import { section, list, row, monthNav, yearNav, segmented, emptyState } from '../ui/components.js';
import { lookups, monthLabel } from '../ui/format.js';
import { incomeExpenseChart, netWorthChart } from '../ui/charts.js';
import { rerender } from '../ui/shell.js';
import { registerViewReset } from '../ui/session.js';
import * as router from '../ui/router.js';
import * as store from '../core/store.js';
import { formatMoney, formatSigned } from '../core/money.js';
import { currentMonthKey, isYearKey } from '../core/dates.js';
import { showMovementsFor } from './movements.js';
import { budgetItem, categoryShare } from './shared.js';

let mode = 'month'; // 'month' | 'year'
let monthKey = currentMonthKey();
let year = monthKey.slice(0, 4);
let breakdown = 'expense';
registerViewReset(() => {
  mode = 'month';
  monthKey = currentMonthKey();
  year = monthKey.slice(0, 4);
  breakdown = 'expense';
});

/** Abre Análisis en un mes 'AAAA-MM' o en un año 'AAAA' (p. ej. desde Inicio). */
export function showStatsFor(key = currentMonthKey()) {
  if (isYearKey(key)) {
    mode = 'year';
    year = key;
  } else {
    mode = 'month';
    monthKey = key;
  }
  router.navigate('/analisis', { replace: true });
}

const stat = (label, value, className = '') => h('div', { class: 'stat' },
  h('span', { class: 'stat-label' }, label),
  h('span', { class: ['stat-value', className] }, value));

/** Meses del año que cuentan para la media: hasta el actual si es este año, los 12 si ya pasó. */
function monthsElapsed(y) {
  const current = currentMonthKey();
  if (y < current.slice(0, 4)) return 12;
  if (y > current.slice(0, 4)) return 0;
  return Number(current.slice(5, 7));
}

function summaryCard(summary, { monthsForAverage = 0 } = {}) {
  const saved = summary.income - summary.expense;
  const savingsRate = summary.income > 0 ? Math.round((saved / summary.income) * 100) : null;
  return h('section', { class: 'card' },
    h('div', { class: 'stats two' },
      stat('Ingresos', formatMoney(summary.income)),
      stat('Gastos', formatMoney(summary.expense)),
      stat('Ahorro', formatSigned(saved), saved < 0 ? 'neg' : ''),
      savingsRate !== null ? stat('Tasa de ahorro', `${savingsRate} %`) : null),
    monthsForAverage > 0
      ? h('p', { class: 'help' }, `Media al mes: ${formatMoney(Math.round(summary.income / monthsForAverage))} de ingresos y ${formatMoney(Math.round(summary.expense / monthsForAverage))} de gastos (${monthsForAverage === 1 ? '1 mes' : `${monthsForAverage} meses`}).`)
      : null,
    summary.debtNet ? h('p', { class: 'help' }, `Además, pagos y cobros de deudas: ${formatSigned(summary.debtNet)} (no cuentan como gasto ni ingreso).`) : null);
}

function categoryCard(key, look, derived) {
  const totals = derived.byCategory(key, breakdown);
  const switcher = segmented([{ value: 'expense', label: 'Gastos' }, { value: 'income', label: 'Ingresos' }], breakdown, (value) => {
    breakdown = value;
    rerender();
  }, { label: 'Reparto de' });
  const when = isYearKey(key) ? 'este año' : 'este mes';
  if (!totals.length) {
    return h('section', { class: 'card' }, switcher,
      emptyState('chart-pie', breakdown === 'expense' ? `Sin gastos ${when}` : `Sin ingresos ${when}`));
  }
  // En un mes, cada categoría lleva a sus movimientos (la lista de movimientos es mensual).
  const onSelect = isYearKey(key) ? null : (categoryId) => showMovementsFor({ categoryId }, key);
  return h('section', { class: 'card' },
    switcher,
    categoryShare(totals, look, { centerLabel: breakdown === 'expense' ? 'gastado' : 'ingresado', onSelect }));
}

function budgetsCard(look, derived) {
  const budgets = derived.budgets(monthKey);
  if (!budgets.length) {
    return h('section', { class: 'card' },
      emptyState('target', 'Sin presupuestos', 'Pon un límite mensual a tus categorías y te avisaré al acercarte.', {
        label: 'Crear presupuesto', onClick: () => router.navigate('/mas/presupuestos'),
      }));
  }
  return list(budgets.map((b) => budgetItem(b, look)));
}

const modeSwitch = () => segmented([{ value: 'month', label: 'Mes' }, { value: 'year', label: 'Año' }], mode, (value) => {
  if (value === 'year') year = monthKey.slice(0, 4);
  mode = value;
  rerender();
}, { label: 'Periodo' });

function monthBody(look, derived) {
  return [
    monthNav(monthKey, (key) => { monthKey = key; rerender(); }),
    summaryCard(derived.period(monthKey)),
    section({ title: 'Por categoría' }, categoryCard(monthKey, look, derived)),
    section({ title: 'Presupuestos', action: { label: 'Gestionar', onClick: () => router.navigate('/mas/presupuestos') } }, budgetsCard(look, derived)),
    section({ title: 'Ingresos y gastos', caption: 'Últimos 12 meses hasta el mes elegido. Toca una columna para ver sus cifras.' },
      h('div', { class: 'card' }, incomeExpenseChart(derived.monthly(monthKey, 12)))),
    section({ title: 'Patrimonio neto', caption: 'Cuentas incluidas en el total − lo que debes + lo que te deben, a final de cada mes.' },
      h('div', { class: 'card' }, netWorthChart(derived.netWorth(monthKey, 12)))),
  ];
}

function yearBody(look, derived) {
  const elapsed = monthsElapsed(year);
  const months = derived.monthly(`${year}-12`, 12);
  const active = months.filter((m) => m.income || m.expense);
  // El patrimonio solo hasta el mes actual: los meses futuros no tienen cierre.
  const lastMonth = elapsed === 12 ? `${year}-12` : `${year}-${String(Math.max(elapsed, 1)).padStart(2, '0')}`;
  const openMonth = (key) => {
    mode = 'month';
    monthKey = key;
    rerender();
  };
  return [
    yearNav(year, (next) => { year = next; rerender(); }),
    summaryCard(derived.period(year), { monthsForAverage: elapsed }),
    section({ title: 'Por categoría' }, categoryCard(year, look, derived)),
    section({ title: 'Ingresos y gastos', caption: `De enero a diciembre de ${year}. Toca una columna para ver sus cifras.` },
      h('div', { class: 'card' }, incomeExpenseChart(months))),
    section({ title: 'Mes a mes', caption: active.length ? 'Toca un mes para ver su análisis.' : null },
      active.length
        ? list(active.map((m) => row({
          title: monthLabel(m.month),
          subtitle: `Ingresos ${formatMoney(m.income)} · Gastos ${formatMoney(m.expense)}`,
          value: formatSigned(m.income - m.expense),
          valueClass: m.income - m.expense < 0 ? 'neg' : 'pos',
          chevron: true,
          onClick: () => openMonth(m.month),
        })))
        : h('div', { class: 'card' }, emptyState('calendar', `Sin ingresos ni gastos en ${year}`))),
    elapsed > 0
      ? section({ title: 'Patrimonio neto', caption: 'A final de cada mes del año.' },
        h('div', { class: 'card' }, netWorthChart(derived.netWorth(lastMonth, Math.max(elapsed, 1)))))
      : null,
  ];
}

export function statsView() {
  const look = lookups(store.getState());
  const derived = store.derived();
  return {
    title: 'Análisis',
    body: [modeSwitch(), ...(mode === 'year' ? yearBody(look, derived) : monthBody(look, derived))],
  };
}
