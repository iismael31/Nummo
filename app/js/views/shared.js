// Piezas compartidas entre vistas: filas de movimiento, de cuenta y de deuda.

import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { row, tile, progress } from '../ui/components.js';
import { describeMovement, dueText } from '../ui/format.js';
import { donutChart } from '../ui/charts.js';
import { formatMoney } from '../core/money.js';
import { accountTypeInfo, COLOR_KEYS } from '../core/catalog.js';
import { openMovementForm } from './movement-form.js';

/** Más reciente primero (fecha y, dentro del mismo día, hora de creación). */
export const compareNewest = (a, b) => (a.date === b.date ? b.ts - a.ts : a.date < b.date ? 1 : -1);

export function movementRow(movement, look, { onClick = () => openMovementForm({ movement }) } = {}) {
  const info = describeMovement(movement, look);
  return row({
    lead: tile({ icon: info.icon, color: info.tone }),
    title: info.title,
    subtitle: info.subtitle,
    value: info.amount,
    valueClass: info.amountClass,
    onClick,
  });
}

export function accountRow(account, balance, { onClick = null, chevron = false } = {}) {
  const details = [accountTypeInfo(account.type).label];
  if (!account.includeInTotal) details.push('no suma al total');
  if (account.archived) details.push('archivada');
  return row({
    lead: tile(account),
    title: account.name,
    subtitle: details.join(' · '),
    value: formatMoney(balance),
    valueClass: balance < 0 ? 'neg' : '',
    onClick,
    chevron,
  });
}

/** Iniciales y color estables para identificar a cada persona o entidad de una deuda. */
export function debtBadge(debt) {
  const words = debt.name.split(/\s+/).filter(Boolean);
  const first = (word) => Array.from(word)[0];
  const letters = (words.length > 1 ? first(words[0]) + first(words[1]) : Array.from(words[0] ?? '?').slice(0, 2).join('')).toUpperCase();
  let hash = 0;
  for (const ch of debt.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { letters, color: COLOR_KEYS[hash % COLOR_KEYS.length] };
}

export function debtRow(debt, totals, { onClick }) {
  const due = totals.pending > 0 ? dueText(debt.dueDate) : null;
  const paidRatio = totals.added > 0 ? totals.paid / totals.added : 0;
  const settled = totals.pending <= 0;
  const subtitle = settled ? 'Saldada' : due?.text ?? (debt.note || `${Math.round(paidRatio * 100)} % ${debt.kind === 'owe' ? 'pagado' : 'cobrado'}`);
  return h('button', { type: 'button', class: 'row', onClick },
    tile(debtBadge(debt)),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, debt.name),
      h('span', { class: ['row-sub', due?.level === 'danger' && 'neg', due?.level === 'warn' && 'warn'] }, subtitle),
      settled ? null : progress(paidRatio, '', 'Parte pagada')),
    h('span', { class: 'row-value' }, formatMoney(Math.max(totals.pending, 0)), h('small', null, `de ${formatMoney(totals.added)}`)));
}

/** Nombre de un presupuesto: el que le pusiste o, si no, sus categorías («Comida, Ocio»). */
export function budgetName(b, look) {
  if (b.categoryIds === null) return b.name || 'Total del mes';
  return b.name || b.categoryIds.map((id) => look.categories.get(id)?.name ?? '').filter(Boolean).join(', ');
}

/**
 * Presupuesto con su barra: nivel (bien / al 80 % / superado), gastado, límite y lo que queda.
 * Con `onClick` es un botón (para editarlo).
 */
export function budgetItem(b, look, { onClick = null } = {}) {
  const pct = `${Math.round(b.ratio * 100)} %`;
  const name = budgetName(b, look);
  const categories = (b.categoryIds ?? []).map((id) => look.categories.get(id)).filter(Boolean);
  const lead = categories.length === 1 ? tile(categories[0], 'sm') : tile({ icon: 'target', color: categories.length ? 'blue' : 'graphite' }, 'sm');
  // Con nombre propio y varias categorías, se dice cuáles incluye.
  const detail = b.name && categories.length ? categories.map((c) => c.name).join(', ') : null;
  return h(onClick ? 'button' : 'div', { type: onClick ? 'button' : null, class: ['budget', onClick && 'row'], onClick },
    h('span', { class: 'row-main' },
      h('span', { class: 'budget-top' },
        lead,
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, name), detail ? h('span', { class: 'row-sub' }, detail) : null),
        h('span', { class: ['badge', b.level === 'over' ? 'danger' : b.level === 'warn' ? 'warn' : 'ok'] }, b.level === 'over' ? 'Superado' : pct)),
      progress(b.ratio, b.level, `Gastado del presupuesto de ${name}: ${pct}`),
      h('span', { class: 'budget-meta' },
        h('span', null, `${formatMoney(b.spent)} de ${formatMoney(b.amount)}`),
        h('span', { class: b.remaining < 0 ? 'neg' : '' }, b.remaining < 0 ? `${formatMoney(-b.remaining)} de más` : `Quedan ${formatMoney(b.remaining)}`))));
}

/** Botones subir/bajar para ordenar una lista (accesibles, sin arrastrar; nombran el elemento). */
export function moveButtons(items, index, reorder) {
  const name = items[index].name;
  const move = (delta) => {
    const ids = items.map((x) => x.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    reorder(ids);
  };
  return h('span', { class: 'toolbar' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Subir ${name}`, disabled: index === 0, onClick: () => move(-1) }, icon('arrow-up')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Bajar ${name}`, disabled: index === items.length - 1, onClick: () => move(1) }, icon('arrow-down')));
}

const MAX_SEGMENTS = 6; // 5 categorías + «Otras»

/**
 * Reparto por categoría: gráfico circular y lista con importe y porcentaje.
 * totals: [{ categoryId, amount }] de mayor a menor. Con `onSelect(categoryId)` cada fila es un botón.
 * `limit`: cuántas filas mostrar en la lista (por defecto, todas).
 */
export function categoryShare(totals, look, { centerLabel, onSelect = null, limit = Infinity }) {
  const total = totals.reduce((sum, x) => sum + x.amount, 0);
  const info = (id) => look.categories.get(id) ?? { name: 'Sin categoría', icon: 'tag', color: 'gray' };
  const top = totals.slice(0, MAX_SEGMENTS - 1);
  const rest = totals.slice(MAX_SEGMENTS - 1);
  const segments = top.map((x) => ({ label: info(x.categoryId).name, value: x.amount, tone: info(x.categoryId).color }));
  if (rest.length) segments.push({ label: 'Otras', value: rest.reduce((sum, x) => sum + x.amount, 0), tone: 'gray' });
  const pct = (value) => `${Math.round((value / total) * 100)} %`;
  const legend = h('ul', { class: 'share-list' }, totals.slice(0, limit).map((x) => {
    const category = info(x.categoryId);
    const content = [tile(category, 'sm'), h('span', { class: 'name' }, category.name), h('span', { class: 'val' }, `${formatMoney(x.amount)} · ${pct(x.amount)}`)];
    return h('li', null, onSelect
      ? h('button', { type: 'button', onClick: () => onSelect(x.categoryId), 'aria-label': `${category.name}: ${formatMoney(x.amount)}, ${pct(x.amount)}. Ver movimientos` }, content)
      : h('div', { class: 'share-row' }, content));
  }));
  return [
    h('div', { class: 'donut-wrap' },
      donutChart(segments, { total, centerLabel }),
      rest.length ? h('p', { class: 'help' }, `Las ${rest.length} categorías más pequeñas se agrupan en «Otras» (gris).`) : null),
    legend,
  ];
}
