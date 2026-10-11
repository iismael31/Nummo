// Inicio: los avisos importantes (versión nueva, copia de seguridad, instalación) y, debajo, los
// paneles que elija la persona en el orden que quiera (Editar). La lista está en settings.homePanels.

import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { section, list, row, tile, notice, emptyState } from '../ui/components.js';
import { lookups, monthLabel, ago, shortDate, frequencyLabel, describeMovement } from '../ui/format.js';
import { incomeExpenseChart, netWorthChart } from '../ui/charts.js';
import { openSheet } from '../ui/sheet.js';
import { focusKey, restoreFocus } from '../ui/focus.js';
import * as router from '../ui/router.js';
import { pwa, promptInstall, applyUpdate } from '../ui/pwa.js';
import * as store from '../core/store.js';
import { formatMoney, formatSigned } from '../core/money.js';
import { currentMonthKey, todayISO, addDays, addMonthKey, daysInMonth } from '../core/dates.js';
import { nextDate, isFinished } from '../core/recurring.js';
import { HOME_PANELS, DEFAULT_HOME_PANELS } from '../core/catalog.js';
import { openMovementForm } from './movement-form.js';
import { compareNewest, movementRow, accountRow, debtRow, budgetItem, categoryShare, moveButtons } from './shared.js';
import { showMovementsFor } from './movements.js';
import { showStatsFor } from './stats.js';

const BACKUP_REMINDER_DAYS = 30;

const stat = (label, value, className = '') => h('div', { class: 'stat' },
  h('span', { class: 'stat-label' }, label),
  h('span', { class: ['stat-value', className] }, value));

const kv = (label, value, className = '') => [h('dt', { class: className }, label), h('dd', { class: className }, value)];

function notices(state) {
  const items = [];
  if (pwa.updateReady) {
    items.push(notice({
      iconName: 'refresh',
      title: 'Hay una versión nueva',
      text: 'Actualiza para tener las últimas mejoras. Tendrás que volver a poner el PIN.',
      actions: [{ label: 'Actualizar', primary: true, onClick: () => store.flush().finally(applyUpdate) }],
    }));
  }
  const lastBackup = state.settings.lastBackupAt;
  if (state.movements.length > 0 && (!lastBackup || Date.now() - lastBackup > BACKUP_REMINDER_DAYS * 86_400_000)) {
    items.push(notice({
      iconName: 'alert-triangle',
      kind: 'warn',
      title: 'Haz una copia de seguridad',
      text: lastBackup
        ? `Tu última copia es de ${ago(lastBackup)}.`
        : 'Aún no tienes ninguna. Si borras la app o cambias de móvil, perderías tus datos.',
      actions: [{ label: 'Hacer copia', primary: true, onClick: () => router.navigate('/mas/copias') }],
    }));
  }
  if (!pwa.isStandalone && !state.settings.installHintDismissed && (pwa.isIOS || pwa.canPromptInstall)) {
    const dismiss = { label: 'Ahora no', onClick: () => store.updateSettings({ installHintDismissed: true }) };
    items.push(pwa.canPromptInstall
      ? notice({ iconName: 'device-mobile', title: 'Instala la app', text: 'Tendrás su icono en la pantalla de inicio y se abrirá a pantalla completa. Tus datos se mantienen.', actions: [{ label: 'Instalar', primary: true, onClick: () => promptInstall() }, dismiss] })
      : notice({ iconName: 'device-mobile', title: 'Úsala como app', text: 'En Safari, pulsa Compartir y «Añadir a pantalla de inicio». La app instalada empieza vacía: antes haz una copia de seguridad aquí y restáurala allí.', actions: [dismiss] }));
  }
  return items;
}

// --- Paneles --------------------------------------------------------------------------------------
// Cada panel recibe el contexto (estado, cálculos, mes actual…) y devuelve un nodo o null.

const PANELS = {
  networth({ derived }) {
    const { totalBalance, totalOwe, totalOwed, netWorth } = derived.summary;
    return h('section', { class: 'card', 'aria-label': 'Patrimonio neto' },
      h('div', null,
        h('p', { class: 'hero-label' }, 'Patrimonio neto'),
        h('p', { class: ['hero-value', netWorth < 0 && 'neg'] }, formatMoney(netWorth))),
      h('div', { class: 'stats' },
        stat('En cuentas', formatMoney(totalBalance)),
        stat('Debes', formatMoney(totalOwe)),
        stat('Te deben', formatMoney(totalOwed))));
  },

  month({ derived, monthKey }) {
    const month = derived.period(monthKey);
    return h('button', { type: 'button', class: 'card', onClick: () => showStatsFor(monthKey) },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-title' }, `Este mes · ${monthLabel(monthKey)}`),
        icon('chevron-right', { className: 'icon chev' })),
      h('dl', { class: 'kv' },
        kv('Ingresos', formatSigned(month.income), month.income ? 'pos' : ''),
        kv('Gastos', formatSigned(-month.expense)),
        month.debtNet ? kv('Deudas (pagos y cobros)', formatSigned(month.debtNet)) : null,
        kv('Resultado', formatSigned(month.result), `total ${month.result < 0 ? 'neg' : ''}`)));
  },

  pace({ state, derived, monthKey, today }) {
    const day = Number(today.slice(8, 10));
    const days = daysInMonth(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)));
    let spent = 0;
    for (const m of state.movements) if (m.type === 'expense' && m.date.startsWith(monthKey) && m.date <= today) spent += m.amount;
    const perDay = Math.round(spent / day);
    const lastMonth = derived.period(addMonthKey(monthKey, -1)).expense;
    return section({ title: 'Ritmo de gasto' },
      h('div', { class: 'card' },
        h('div', { class: 'stats' },
          stat('Llevas', formatMoney(spent)),
          stat('Al día', formatMoney(perDay)),
          stat('A fin de mes', `≈ ${formatMoney(perDay * days)}`)),
        h('p', { class: 'help' }, lastMonth
          ? `El mes pasado gastaste ${formatMoney(lastMonth)}. La previsión supone que sigues gastando como hasta hoy.`
          : 'La previsión supone que sigues gastando como hasta hoy.')));
  },

  budgets({ derived, monthKey, look }) {
    const statuses = derived.budgets(monthKey);
    return section({ title: 'Presupuestos', action: { label: statuses.length ? 'Ver todos' : 'Crear', onClick: () => router.navigate('/mas/presupuestos') } },
      statuses.length
        ? list(statuses.slice(0, 3).map((b) => budgetItem(b, look)))
        : h('div', { class: 'card' }, emptyState('target', 'Sin presupuestos', 'Pon un límite al mes y te avisaré al acercarte.')));
  },

  accounts({ state, derived }) {
    const accounts = state.accounts.filter((a) => !a.archived);
    const { balances } = derived.summary;
    return section({ title: 'Cuentas', action: { label: 'Gestionar', onClick: () => router.navigate('/mas/cuentas') } },
      accounts.length
        ? list(accounts.map((a) => accountRow(a, balances.get(a.id) ?? 0, { chevron: true, onClick: () => showMovementsFor({ accountId: a.id }) })))
        : emptyState('building-bank', 'Sin cuentas', 'Añade tu banco, tarjeta o efectivo.', { label: 'Añadir cuenta', onClick: () => router.navigate('/mas/cuentas') }));
  },

  debts({ state, derived }) {
    const { debtTotals, totalOwe, totalOwed } = derived.summary;
    const pending = state.debts.filter((d) => debtTotals.get(d.id).pending > 0)
      // Primero las que tienen fecha límite (la más cercana), luego las de más importe.
      .sort((a, b) => (a.dueDate && b.dueDate ? a.dueDate.localeCompare(b.dueDate) : a.dueDate ? -1 : b.dueDate ? 1 : debtTotals.get(b.id).pending - debtTotals.get(a.id).pending))
      .slice(0, 3);
    return section({ title: 'Deudas', action: { label: 'Ver', onClick: () => router.navigate('/deudas') } },
      h('div', { class: 'card' },
        h('div', { class: 'stats two' },
          stat('Debes', formatMoney(totalOwe), totalOwe ? 'neg' : ''),
          stat('Te deben', formatMoney(totalOwed)))),
      pending.length
        ? list(pending.map((d) => debtRow(d, debtTotals.get(d.id), { onClick: () => router.navigate(`/deudas/${d.id}`) })))
        : null);
  },

  categories({ derived, monthKey, look }) {
    const totals = derived.byCategory(monthKey, 'expense');
    return section({ title: 'Gastos por categoría', action: { label: 'Análisis', onClick: () => showStatsFor(monthKey) } },
      h('div', { class: 'card' }, totals.length
        ? categoryShare(totals, look, { centerLabel: 'gastado', limit: 5, onSelect: (categoryId) => showMovementsFor({ categoryId }, monthKey) })
        : emptyState('chart-pie', 'Sin gastos este mes')));
  },

  cashflow({ derived, monthKey }) {
    return section({ title: 'Ingresos y gastos', caption: 'Últimos 6 meses. Toca una columna para ver sus cifras.' },
      h('div', { class: 'card' }, incomeExpenseChart(derived.monthly(monthKey, 6))));
  },

  networthChart({ derived, monthKey }) {
    return section({ title: 'Evolución del patrimonio', caption: 'A final de cada mes, últimos 12 meses.' },
      h('div', { class: 'card' }, netWorthChart(derived.netWorth(monthKey, 12))));
  },

  year({ derived, monthKey }) {
    const year = monthKey.slice(0, 4);
    const summary = derived.period(year);
    const saved = summary.income - summary.expense;
    return h('button', { type: 'button', class: 'card', onClick: () => showStatsFor(year) },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-title' }, `Este año · ${year}`),
        icon('chevron-right', { className: 'icon chev' })),
      h('dl', { class: 'kv' },
        kv('Ingresos', formatSigned(summary.income), summary.income ? 'pos' : ''),
        kv('Gastos', formatSigned(-summary.expense)),
        kv('Ahorro', formatSigned(saved), `total ${saved < 0 ? 'neg' : ''}`)));
  },

  topExpenses({ state, monthKey, look }) {
    const top = state.movements.filter((m) => m.type === 'expense' && m.date.startsWith(monthKey))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
    return section({ title: 'Mayores gastos del mes' },
      top.length ? list(top.map((m) => movementRow(m, look))) : h('div', { class: 'card' }, emptyState('receipt', 'Sin gastos este mes')));
  },

  upcoming({ state, look, today }) {
    const upcoming = state.recurring
      .filter((r) => r.active && !isFinished(r))
      .map((r) => ({ rule: r, date: nextDate(r) }))
      .filter((x) => x.date <= addDays(today, 14))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 3);
    return section({ title: 'Próximos programados', action: { label: 'Ver', onClick: () => router.navigate('/mas/programados') } },
      upcoming.length
        ? list(upcoming.map(({ rule, date }) => {
          const info = describeMovement({ ...rule.template, date }, look);
          return row({
            lead: tile({ icon: info.icon, color: info.tone }),
            title: info.title,
            subtitle: `${shortDate(date)} · ${frequencyLabel(rule.frequency, rule.interval)}`,
            value: info.amount,
            valueClass: info.amountClass,
          });
        }))
        : h('p', { class: 'caption' }, 'Nada programado en los próximos 14 días.'));
  },

  recent({ state, look }) {
    const recent = [...state.movements].sort(compareNewest).slice(0, 6);
    return section({ title: 'Últimos movimientos', action: recent.length ? { label: 'Ver todos', onClick: () => showMovementsFor({}) } : null },
      recent.length
        ? list(recent.map((m) => movementRow(m, look)))
        : h('div', { class: 'card' }, emptyState('plus', 'Apunta tu primer gasto', 'Pulsa el botón + para añadir gastos, ingresos o transferencias.', { label: 'Añadir', onClick: () => openMovementForm() })));
  },

  quick() {
    const add = (type, label, iconName) => h('button', { type: 'button', class: 'btn', onClick: () => openMovementForm({ preset: { type } }) }, icon(iconName), label);
    return section({ title: 'Accesos rápidos' },
      h('div', { class: 'quick-actions' },
        add('expense', 'Gasto', 'receipt'),
        add('income', 'Ingreso', 'cash'),
        add('transfer', 'Transferencia', 'arrows-exchange')));
  },
};

// --- Editar Inicio ----------------------------------------------------------------------------------

function openHomeEditor() {
  const content = h('div', { class: 'form' });
  const save = (keys) => {
    const focused = focusKey(document.activeElement); // tras repintar, el foco sigue en el mismo botón
    store.updateSettings({ homePanels: keys });
    render();
    restoreFocus(content, focused);
  };
  const render = () => {
    const shown = store.getState().settings.homePanels;
    const info = (key) => HOME_PANELS.find((p) => p.key === key);
    const items = shown.map((key) => ({ id: key, name: info(key).label }));
    const hidden = HOME_PANELS.filter((p) => !shown.includes(p.key));
    replace(content,
      section({ title: 'En Inicio', caption: shown.length ? 'Ordénalos con las flechas.' : null },
        shown.length
          ? list(shown.map((key, i) => row({
            title: info(key).label,
            subtitle: info(key).help,
            trailing: h('span', { class: 'toolbar' },
              moveButtons(items, i, save),
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Quitar ${info(key).label} de Inicio`, onClick: () => save(shown.filter((k) => k !== key)) }, icon('x'))),
          })))
          : h('p', { class: 'caption' }, 'No hay ningún panel. Añade alguno de abajo.')),
      hidden.length
        ? section({ title: 'Más paneles' },
          list(hidden.map((p) => row({
            title: p.label,
            subtitle: p.help,
            trailing: h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Añadir ${p.label} a Inicio`, onClick: () => save([...shown, p.key]) }, icon('plus')),
          }))))
        : null,
      h('button', { type: 'button', class: 'btn', onClick: () => save([...DEFAULT_HOME_PANELS]) }, icon('refresh'), 'Volver a los paneles de siempre'));
  };
  render();
  openSheet({ title: 'Personalizar Inicio', tall: true, body: content });
}

export function homeView() {
  const state = store.getState();
  const ctx = { state, derived: store.derived(), look: lookups(state), monthKey: currentMonthKey(), today: todayISO() };
  const panels = state.settings.homePanels.map((key) => PANELS[key](ctx)).filter(Boolean);
  return {
    title: 'Inicio',
    actions: [h('button', { type: 'button', class: 'btn-text', onClick: openHomeEditor }, 'Editar')],
    body: [
      ...notices(state),
      ...(panels.length ? panels : [h('div', { class: 'card' }, emptyState('home', 'Inicio está vacío', 'Elige qué quieres ver aquí.', { label: 'Elegir paneles', onClick: openHomeEditor }))]),
    ],
    fab: { label: 'Añadir movimiento', onClick: () => openMovementForm() },
  };
}
