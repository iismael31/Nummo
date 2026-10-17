// Presupuestos mensuales: el total del mes y presupuestos de una o varias categorías de gasto.
// Cada presupuesto tiene su pantalla con dos pestañas: sus movimientos mes a mes y su configuración.

import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  section, list, field, textInput, amountInput, errorText, categoryGrid, emptyState, monthNav, segmented,
} from '../ui/components.js';
import { lookups, monthLabel } from '../ui/format.js';
import { openSheet, confirmDialog } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { rerender } from '../ui/shell.js';
import { registerViewReset } from '../ui/session.js';
import * as router from '../ui/router.js';
import * as store from '../core/store.js';
import { ValidationError, LIMITS } from '../core/model.js';
import { formatMoney, centsToInput } from '../core/money.js';
import { currentMonthKey, monthBounds } from '../core/dates.js';
import { BUDGET_WARN_RATIO } from '../core/finance.js';
import { budgetItem, budgetName, compareNewest, movementRow } from './shared.js';
import { openCategoryForm } from './categories.js';

// Pantalla de un presupuesto: cuál, pestaña, mes y el borrador de la configuración (que sobrevive a
// los repintados, p. ej. al crear una categoría desde el formulario).
let detail = null;
registerViewReset(() => {
  detail = null;
});

/** Abre la pantalla de un presupuesto (en «Movimientos», en el mes indicado). */
export function showBudget(id, month = currentMonthKey()) {
  detail = { id, tab: 'movements', month, draft: null };
  router.navigate(`/mas/presupuestos/${id}`);
}

export function budgetsView() {
  const look = lookups(store.getState());
  const monthKey = currentMonthKey();
  const statuses = store.derived().budgets(monthKey);
  const total = statuses.find((b) => b.categoryIds === null);
  const byCategories = statuses.filter((b) => b.categoryIds !== null);
  const item = (b) => budgetItem(b, look, { onClick: () => showBudget(b.id) });

  return {
    title: 'Presupuestos',
    back: { label: 'Más', path: '/mas' },
    body: [
      h('p', { class: 'caption' }, `Límites que se reinician cada mes. Datos de ${monthLabel(monthKey)}. Te aviso al llegar al ${Math.round(BUDGET_WARN_RATIO * 100)} %. Toca uno para ver sus gastos.`),
      section({ title: 'Total del mes' },
        total
          ? list([item(total)])
          : h('button', { type: 'button', class: 'btn', onClick: () => openBudgetForm({ total: true }) }, icon('plus'), 'Fijar un límite total')),
      section({ title: 'Por categorías', caption: byCategories.length ? 'Cada presupuesto suma lo gastado en sus categorías.' : null },
        byCategories.length
          ? list(byCategories.map(item))
          : h('div', { class: 'card' }, emptyState('target', 'Sin presupuestos por categorías', 'Por ejemplo: «Ocio» con Restaurantes y Cine, 150 € al mes.')),
        h('button', { type: 'button', class: 'btn', onClick: () => openBudgetForm() }, icon('plus'), 'Añadir presupuesto')),
    ],
  };
}

// --- Formulario (hoja para crear y pestaña «Configuración» para cambiar) ----------------------------

const newDraft = (budget = null) => ({
  name: budget?.name ?? '',
  amount: budget ? centsToInput(budget.amount) : '',
  categoryIds: new Set(budget?.categoryIds ?? []),
});

/** Campos sobre un borrador. payload() devuelve los datos a guardar o null (y muestra qué falta). */
function budgetFields(draft, { isTotal }) {
  const name = isTotal ? null : textInput({ value: draft.name, placeholder: 'Opcional, por ejemplo: Ocio', maxLength: LIMITS.name });
  name?.addEventListener('input', () => { draft.name = name.value; });
  const amount = amountInput({ label: 'Límite mensual' });
  amount.input.value = draft.amount;
  amount.input.addEventListener('input', () => { draft.amount = amount.input.value; });
  const categoriesBox = h('div');
  const error = errorText();

  const renderCategories = () => {
    // Las archivadas solo aparecen si ya estaban en este presupuesto.
    const options = store.getState().categories.filter((c) => c.kind === 'expense' && (!c.archived || draft.categoryIds.has(c.id)));
    replace(categoriesBox, categoryGrid(options, draft.categoryIds, (ids) => {
      draft.categoryIds = ids;
      error.textContent = '';
    }, {
      label: 'Categorías del presupuesto',
      multiple: true,
      onCreate: () => openCategoryForm({
        kind: 'expense',
        onCreated: (category) => {
          draft.categoryIds.add(category.id);
          renderCategories();
        },
      }),
    }));
  };
  if (!isTotal) renderCategories();

  return {
    nodes: [
      isTotal ? null : field('Nombre', name),
      h('p', { class: 'help' }, isTotal ? '¿Cuánto quieres gastar como mucho al mes en total?' : '¿Cuánto quieres gastar como mucho al mes entre estas categorías?'),
      amount.el,
      isTotal ? null : field('Categorías', categoriesBox, { help: 'Elige una o varias. Una categoría puede estar en más de un presupuesto.' }),
      error,
    ],
    payload() {
      error.textContent = '';
      if (!isTotal && draft.categoryIds.size === 0) {
        error.textContent = 'Elige al menos una categoría.';
        return null;
      }
      const cents = amount.read();
      if (cents === null) return null;
      return { name: draft.name, categoryIds: isTotal ? null : [...draft.categoryIds], amount: cents };
    },
    showError(message) {
      error.textContent = message;
    },
  };
}

/** Hoja para crear un presupuesto. `total`: el límite de todo el gasto del mes (sin categorías). */
function openBudgetForm({ total = false } = {}) {
  const form = budgetFields(newDraft(), { isTotal: total });
  const save = () => {
    const data = form.payload();
    if (!data) return;
    try {
      store.saveBudget(data);
      sheet.close();
      toast('Presupuesto guardado');
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      form.showError(e.message);
    }
  };
  const sheet = openSheet({
    title: total ? 'Total del mes' : 'Nuevo presupuesto',
    tall: !total,
    primary: { label: 'Guardar', onClick: save },
    body: [...form.nodes, h('button', { type: 'button', class: 'btn primary', onClick: save }, 'Guardar')],
  });
}

// --- Pantalla de un presupuesto ---------------------------------------------------------------------

function movementsTab(budget, look) {
  const { month } = detail;
  const status = store.derived().budgets(month).find((b) => b.id === budget.id);
  const { start, end } = monthBounds(month);
  const movements = store.getState().movements
    .filter((m) => m.type === 'expense' && m.date >= start && m.date <= end && (budget.categoryIds === null || budget.categoryIds.includes(m.categoryId)))
    .sort(compareNewest);
  return [
    monthNav(month, (key) => { detail.month = key; rerender(); }),
    status ? list([budgetItem(status, look)]) : null,
    movements.length
      ? section({ title: 'Gastos', caption: `${movements.length === 1 ? '1 gasto' : `${movements.length} gastos`} · ${formatMoney(status?.spent ?? 0)}` },
        list(movements.map((m) => movementRow(m, look))))
      : h('div', { class: 'card' }, emptyState('receipt', 'Sin gastos este mes', budget.categoryIds === null ? 'Aún no has apuntado ningún gasto.' : 'Nada apuntado en las categorías de este presupuesto.')),
  ];
}

function settingsTab(budget, look) {
  detail.draft ??= newDraft(budget);
  const form = budgetFields(detail.draft, { isTotal: budget.categoryIds === null });
  const save = () => {
    const data = form.payload();
    if (!data) return;
    try {
      store.saveBudget({ id: budget.id, ...data });
      detail.draft = null; // el próximo repintado parte de lo guardado
      toast('Presupuesto guardado');
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      form.showError(e.message);
    }
  };
  const remove = async () => {
    const confirmed = await confirmDialog({
      title: `¿Quitar «${budgetName(budget, look)}»?`,
      text: 'Tus movimientos no cambian.',
      confirmLabel: 'Quitar',
      danger: true,
    });
    if (!confirmed) return;
    store.deleteBudget(budget.id);
    detail = null;
    router.back('/mas/presupuestos');
    toast('Presupuesto quitado');
  };
  return [h('div', { class: 'form' },
    ...form.nodes,
    h('button', { type: 'button', class: 'btn primary', onClick: save }, 'Guardar cambios'),
    h('button', { type: 'button', class: 'btn danger', onClick: remove }, 'Quitar presupuesto'))];
}

export function budgetDetailView({ id }) {
  const state = store.getState();
  const budget = state.budgets.find((b) => b.id === id);
  if (!budget) return null;
  if (detail?.id !== id) detail = { id, tab: 'movements', month: currentMonthKey(), draft: null };
  const look = lookups(state);
  return {
    title: budgetName(budget, look),
    back: { label: 'Presupuestos', path: '/mas/presupuestos' },
    body: [
      segmented([{ value: 'movements', label: 'Movimientos' }, { value: 'settings', label: 'Configuración' }], detail.tab, (value) => {
        detail.tab = value;
        rerender();
      }, { label: 'Vista del presupuesto' }),
      ...(detail.tab === 'movements' ? movementsTab(budget, look) : settingsTab(budget, look)),
    ],
  };
}
