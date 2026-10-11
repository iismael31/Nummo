// Presupuestos mensuales: el total del mes y presupuestos de una o varias categorías de gasto.

import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { section, list, field, textInput, amountInput, errorText, categoryGrid, emptyState } from '../ui/components.js';
import { lookups, monthLabel } from '../ui/format.js';
import { openSheet, confirmDialog } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import * as store from '../core/store.js';
import { ValidationError, LIMITS } from '../core/model.js';
import { currentMonthKey } from '../core/dates.js';
import { BUDGET_WARN_RATIO } from '../core/finance.js';
import { budgetItem, budgetName } from './shared.js';
import { openCategoryForm } from './categories.js';

export function budgetsView() {
  const look = lookups(store.getState());
  const monthKey = currentMonthKey();
  const statuses = store.derived().budgets(monthKey);
  const total = statuses.find((b) => b.categoryIds === null);
  const byCategories = statuses.filter((b) => b.categoryIds !== null);
  const editable = (b) => budgetItem(b, look, { onClick: () => openBudgetForm({ budget: b }) });

  return {
    title: 'Presupuestos',
    back: { label: 'Más', path: '/mas' },
    body: [
      h('p', { class: 'caption' }, `Límites que se reinician cada mes. Datos de ${monthLabel(monthKey)}. Te aviso al llegar al ${Math.round(BUDGET_WARN_RATIO * 100)} %.`),
      section({ title: 'Total del mes' },
        total
          ? list([editable(total)])
          : h('button', { type: 'button', class: 'btn', onClick: () => openBudgetForm({ total: true }) }, icon('plus'), 'Fijar un límite total')),
      section({ title: 'Por categorías', caption: byCategories.length ? 'Cada presupuesto suma lo gastado en sus categorías.' : null },
        byCategories.length
          ? list(byCategories.map(editable))
          : h('div', { class: 'card' }, emptyState('target', 'Sin presupuestos por categorías', 'Por ejemplo: «Ocio» con Restaurantes y Cine, 150 € al mes.')),
        h('button', { type: 'button', class: 'btn', onClick: () => openBudgetForm() }, icon('plus'), 'Añadir presupuesto')),
    ],
  };
}

/** Crea o edita un presupuesto. `total`: el límite de todo el gasto del mes (sin categorías). */
function openBudgetForm({ budget = null, total = false } = {}) {
  const editing = budget !== null;
  const isTotal = editing ? budget.categoryIds === null : total;
  const draft = { categoryIds: new Set(budget?.categoryIds ?? []) };
  const name = isTotal ? null : textInput({ value: budget?.name ?? '', placeholder: 'Opcional, por ejemplo: Ocio', maxLength: LIMITS.name });
  const input = amountInput({ value: budget?.amount ?? null, label: 'Límite mensual' });
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

  const save = () => {
    error.textContent = '';
    if (!isTotal && draft.categoryIds.size === 0) {
      error.textContent = 'Elige al menos una categoría.';
      return;
    }
    const cents = input.read();
    if (cents === null) return;
    try {
      store.saveBudget({ id: budget?.id ?? null, name: name?.value ?? '', categoryIds: isTotal ? null : [...draft.categoryIds], amount: cents });
      sheet.close();
      toast('Presupuesto guardado');
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      error.textContent = e.message;
    }
  };

  const remove = async () => {
    const confirmed = await confirmDialog({
      title: `¿Quitar «${budgetName(budget, lookups(store.getState()))}»?`,
      text: 'Tus movimientos no cambian.',
      confirmLabel: 'Quitar',
      danger: true,
    });
    if (!confirmed) return;
    store.deleteBudget(budget.id);
    sheet.close();
    toast('Presupuesto quitado');
  };

  const sheet = openSheet({
    title: isTotal ? 'Total del mes' : editing ? 'Editar presupuesto' : 'Nuevo presupuesto',
    tall: !isTotal,
    primary: { label: 'Guardar', onClick: save },
    body: [
      isTotal ? null : field('Nombre', name),
      h('p', { class: 'help' }, isTotal ? '¿Cuánto quieres gastar como mucho al mes en total?' : '¿Cuánto quieres gastar como mucho al mes entre estas categorías?'),
      input.el,
      isTotal ? null : field('Categorías', categoriesBox, { help: 'Elige una o varias. Una categoría puede estar en más de un presupuesto.' }),
      error,
      h('button', { type: 'button', class: 'btn primary', onClick: save }, 'Guardar'),
      editing ? h('button', { type: 'button', class: 'btn danger', onClick: remove }, 'Quitar presupuesto') : null,
    ],
  });
}
