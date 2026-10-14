// Texto de los comentarios automáticos (core/insights.js): una frase por comentario, con un icono
// según si conviene mirarlo (aviso), es una buena noticia o es solo un dato curioso.

import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { monthLabel, shortDate } from '../ui/format.js';
import { formatEuros } from '../core/money.js';
import { budgetName } from './shared.js';

const ICONS = { warn: 'alert-triangle', good: 'circle-check', info: 'bulb' };
const pct = (ratio) => `${Math.round(Math.abs(ratio) * 100)} %`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** «mayo» (dentro del análisis de un año, el año ya se sabe). */
const monthName = (key) => monthLabel(key).replace(/ \d{4}$/, '').toLowerCase();

/** La frase de un comentario. `look`: mapas de categorías, etc. (ui/format lookups). */
export function insightText(i, look) {
  const category = (id) => look.categories.get(id)?.name ?? 'Sin categoría';
  switch (i.kind) {
    case 'spend-vs-average': {
      const base = i.current ? 'Llevas' : 'Gastaste';
      const when = i.current ? 'este mes' : 'ese mes';
      const media = `tu media de los ${plural(i.months, 'mes', 'meses')} anteriores${i.current ? ' a estas alturas' : ''} (${formatEuros(i.average)})`;
      if (i.level === 'info') return `${base} ${formatEuros(i.spent)} ${when}, en línea con ${media}.`;
      return `${base} ${formatEuros(i.spent)} ${when}, un ${pct(i.ratio)} ${i.ratio > 0 ? 'más' : 'menos'} que ${media}.`;
    }
    case 'category-up':
      return i.average
        ? `${category(i.categoryId)} sube: ${formatEuros(i.spent)} frente a ${formatEuros(i.average)} de media (+${pct(i.ratio)}).`
        : `${category(i.categoryId)}: ${formatEuros(i.spent)} ${i.current ? 'este mes' : 'ese mes'}, cuando en los meses anteriores no gastabas nada.`;
    case 'category-down':
      if (!i.spent) {
        return i.current
          ? `Aún no has gastado en ${category(i.categoryId)} este mes (a estas alturas sueles llevar ${formatEuros(i.average)}).`
          : `Ese mes no gastaste nada en ${category(i.categoryId)} (tu media es de ${formatEuros(i.average)}).`;
      }
      return `${category(i.categoryId)} baja: ${formatEuros(i.spent)} frente a ${formatEuros(i.average)} de media (−${pct(i.ratio)}).`;
    case 'small-expenses':
      return `${plural(i.count, 'gasto pequeño', 'gastos pequeños')} (de 10 € o menos) en ${category(i.categoryId)} suman ${formatEuros(i.total)}. Los «gastos hormiga» también cuentan.`;
    case 'unusual':
      return `Gasto poco habitual: ${formatEuros(i.amount)} en ${category(i.categoryId)} el ${shortDate(i.date)}${i.note ? ` («${i.note}»)` : ''}. Normalmente gastas unos ${formatEuros(i.typical)} cada vez.`;
    case 'overspending':
      return i.current
        ? `Por ahora este mes llevas ${formatEuros(-i.saved)} más de gastos que de ingresos.`
        : `Ese mes gastaste ${formatEuros(-i.saved)} más de lo que ingresaste.`;
    case 'saving-rate': {
      const average = i.averageRate !== null ? ` Tu media es del ${pct(i.averageRate)}.` : '';
      return i.current
        ? `Por ahora ahorras el ${pct(i.rate)} de tus ingresos de este mes (${formatEuros(i.saved)}).${average}`
        : `Ese mes ahorraste ${formatEuros(i.saved)}, el ${pct(i.rate)} de tus ingresos.${average}`;
    }
    case 'saving-streak':
      return `Llevas ${plural(i.months, 'mes', 'meses')} seguidos ahorrando (más ingresos que gastos).`;
    case 'budget-over':
      return `Ya te has pasado de «${budgetName(i.budget, look)}» en ${formatEuros(i.over)}.`;
    case 'budget-forecast':
      return `A este ritmo superarás «${budgetName(i.budget, look)}» hacia el día ${i.day} (acabarías el mes en unos ${formatEuros(i.projected)} de ${formatEuros(i.budget.amount)}).`;
    case 'budgets-ok':
      return i.count === 1 ? 'Vas bien con tu presupuesto: a este ritmo no te pasarás.' : `Vas bien con tus ${i.count} presupuestos: a este ritmo no te pasarás de ninguno.`;
    case 'budgets-past':
      return i.over ? `Te pasaste en ${i.over} de tus ${plural(i.total, 'presupuesto', 'presupuestos')}.` : `Cumpliste ${i.total === 1 ? 'tu presupuesto' : `tus ${i.total} presupuestos`}.`;
    case 'year-projection':
      return i.projected >= 0
        ? `Llevas ${formatEuros(Math.max(i.saved, 0))} ahorrados este año. A tu ritmo (${plural(i.months, 'mes cerrado', 'meses cerrados')}) acabarás el año con unos ${formatEuros(i.projected)} ahorrados.`
        : `A tu ritmo de los ${plural(i.months, 'mes cerrado', 'meses cerrados')}, acabarías el año con ${formatEuros(-i.projected)} más de gastos que de ingresos.`;
    case 'year-saved':
      return i.saved >= 0
        ? `Ese año ahorraste ${formatEuros(i.saved)}${i.rate !== null ? `, el ${pct(i.rate)} de tus ingresos` : ''}.`
        : `Ese año gastaste ${formatEuros(-i.saved)} más de lo que ingresaste.`;
    case 'year-vs-last': {
      const what = i.current ? 'Este año llevas' : 'Ese año gastaste';
      const period = i.current ? 'en el mismo periodo del año anterior' : 'el año anterior';
      if (i.level === 'info') return `${what} ${formatEuros(i.spent)} de gastos, parecido a ${period} (${formatEuros(i.previous)}).`;
      return `${what} ${formatEuros(i.spent)} de gastos, un ${pct(i.ratio)} ${i.ratio > 0 ? 'más' : 'menos'} que ${period} (${formatEuros(i.previous)}).`;
    }
    case 'category-up-year':
      return `${category(i.categoryId)} sube un ${pct(i.ratio)} respecto al año anterior (${formatEuros(i.spent)} frente a ${formatEuros(i.average)}).`;
    case 'top-category-year':
      return `Donde más gastas es en ${category(i.categoryId)}: ${formatEuros(i.amount)}, el ${pct(i.share)} de tus gastos del año.`;
    case 'best-worst': {
      const best = `Tu mejor mes fue ${monthName(i.best.month)} (${i.best.result >= 0 ? `${formatEuros(i.best.result)} ahorrados` : 'el que menos perdiste'})`;
      return i.best.month === i.priciest.month
        ? `${best} y también el de más gasto.`
        : `${best} y el de más gasto, ${monthName(i.priciest.month)} (${formatEuros(i.priciest.expense)}).`;
    }
    default:
      return null;
  }
}

/** Lista de comentarios (o nada si no hay). */
export function insightList(insights, look) {
  const items = insights.map((i) => ({ i, text: insightText(i, look) })).filter((x) => x.text);
  if (!items.length) return null;
  return h('ul', { class: 'insights' }, items.map(({ i, text }) => h('li', { class: ['insight', `is-${i.level}`] },
    icon(i.kind === 'saving-streak' ? 'flame' : ICONS[i.level]),
    h('span', null, text))));
}
