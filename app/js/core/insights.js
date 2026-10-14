// Comentarios automáticos sobre los gastos, el ahorro y los presupuestos (como los consejos de las
// huchas). Funciones puras: devuelven datos ({ kind, level, … }) y la vista pone el texto.
// level: 'warn' (conviene mirarlo), 'good' (buena noticia) o 'info'. Primero van los 'warn'.

import { addMonthKey, daysInMonth, monthKey } from './dates.js';
import { budgetStatus } from './finance.js';

const AVG_MONTHS = 3; // meses anteriores con los que se compara un mes
const UNUSUAL_MONTHS = 6; // meses anteriores para saber cuánto sueles gastar en cada categoría
const STREAK_MONTHS = 12; // como mucho se cuentan 12 meses seguidos ahorrando
const CHANGE = 0.1; // ±10 % para decir que gastas más o menos que tu media
const CATEGORY_CHANGE = 0.3; // ±30 % y…
const CATEGORY_MIN_DIFF = 2000; // …al menos 20 € de diferencia para comentar una categoría
const YEAR_CATEGORY_MIN_DIFF = 10000; // 100 € en la comparación anual
const SMALL_EXPENSE = 1000; // un gasto «hormiga» es de 10 € o menos
const SMALL_MIN_COUNT = 8;
const UNUSUAL_FACTOR = 3; // un gasto 3 veces mayor de lo habitual en su categoría…
const UNUSUAL_MIN = 5000; // …y de al menos 50 €
const UNUSUAL_MIN_SAMPLES = 5;
const MIN_DAYS = 5; // los primeros días del mes hay muy poco para comparar o prever
const MIN_AVERAGE = 1000; // no se comparan porcentajes sobre medias de menos de 10 €
const LEVELS = { warn: 0, good: 1, info: 2 };

const parts = (key) => [Number(key.slice(0, 4)), Number(key.slice(5, 7))];
const lengthOf = (key) => daysInMonth(...parts(key));
const day = (iso) => Number(iso.slice(8, 10));
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const byLevel = (list) => list.sort((a, b) => LEVELS[a.level] - LEVELS[b.level]);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Gastos (movimientos) e ingresos (total) de cada mes pedido, en una sola pasada. */
function groupByMonth(state, keys) {
  const months = new Map(keys.map((k) => [k, { expenses: [], income: 0 }]));
  for (const m of state.movements) {
    if (m.type !== 'expense' && m.type !== 'income') continue;
    const month = months.get(monthKey(m.date));
    if (!month) continue;
    if (m.type === 'expense') month.expenses.push(m);
    else month.income += m.amount;
  }
  return months;
}

/** Total y reparto por categoría de unos gastos hasta un día del mes (incluido). */
function spending(expenses, upToDay = 31) {
  const byCategory = new Map();
  let total = 0;
  for (const m of expenses) {
    if (day(m.date) > upToDay) continue;
    total += m.amount;
    byCategory.set(m.categoryId, (byCategory.get(m.categoryId) ?? 0) + m.amount);
  }
  return { total, byCategory };
}

const hasData = (month) => month.income > 0 || month.expenses.length > 0;
const resultOf = (month) => month.income - spending(month.expenses).total;

/** Meses seguidos (hacia atrás desde `fromKey`) con más ingresos que gastos. */
function savingStreak(months, fromKey) {
  let streak = 0;
  for (let key = fromKey; streak < STREAK_MONTHS; key = addMonthKey(key, -1)) {
    const month = months.get(key);
    if (!month || !hasData(month) || resultOf(month) <= 0) break;
    streak += 1;
  }
  return streak;
}

/** Categoría que más sube y la que más baja respecto a una referencia (mapas categoría → céntimos). */
function categoryChanges(current, reference, minDiff) {
  let up = null;
  let down = null;
  for (const id of new Set([...current.keys(), ...reference.keys()])) {
    const now = current.get(id) ?? 0;
    const before = reference.get(id) ?? 0;
    const diff = now - before;
    if (diff >= minDiff && (before === 0 || diff / before >= CATEGORY_CHANGE) && diff > (up?.diff ?? 0)) {
      up = { categoryId: id, spent: now, average: before, diff, ratio: before ? diff / before : null };
    }
    if (-diff >= minDiff && before > 0 && -diff / before >= CATEGORY_CHANGE && diff < (down?.diff ?? 0)) {
      down = { categoryId: id, spent: now, average: before, diff, ratio: diff / before };
    }
  }
  return { up, down };
}

/**
 * Comentarios de un mes 'AAAA-MM' visto el día `today`. Si es el mes en curso, se compara «a estas
 * alturas»: lo de este mes hasta hoy con lo de los meses anteriores hasta el mismo día.
 */
export function monthInsights(state, key, today) {
  const current = monthKey(today) === key;
  if (key > monthKey(today)) return [];
  const upTo = current ? day(today) : lengthOf(key);
  const previous = Array.from({ length: Math.max(UNUSUAL_MONTHS, STREAK_MONTHS) }, (_, i) => addMonthKey(key, -(i + 1)));
  const months = groupByMonth(state, [key, ...previous]);
  const month = months.get(key);
  if (!hasData(month)) return [];
  const insights = [];

  // --- Gastos: el mes frente a la media de los anteriores (solo meses en los que ya usabas la app).
  const now = spending(month.expenses, upTo);
  const referenceKeys = previous.slice(0, AVG_MONTHS).filter((k) => hasData(months.get(k)));
  if (referenceKeys.length && upTo >= MIN_DAYS) {
    const limit = (k) => (current ? Math.min(upTo, lengthOf(k)) : lengthOf(k));
    const past = referenceKeys.map((k) => spending(months.get(k).expenses, limit(k)));
    const average = Math.round(mean(past.map((p) => p.total)));
    if (average >= MIN_AVERAGE) {
      const ratio = (now.total - average) / average;
      insights.push({ kind: 'spend-vs-average', level: ratio >= CHANGE ? 'warn' : ratio <= -CHANGE ? 'good' : 'info', spent: now.total, average, ratio, months: past.length, current });
    }
    const averageBy = new Map();
    for (const p of past) for (const [id, amount] of p.byCategory) averageBy.set(id, (averageBy.get(id) ?? 0) + amount / past.length);
    for (const [id, amount] of averageBy) averageBy.set(id, Math.round(amount));
    const { up, down } = categoryChanges(now.byCategory, averageBy, CATEGORY_MIN_DIFF);
    if (up) insights.push({ kind: 'category-up', level: 'warn', ...up, current });
    if (down) insights.push({ kind: 'category-down', level: 'good', ...down, current });
  }

  // --- Gastos hormiga: muchos gastos pequeños en una misma categoría.
  const small = new Map();
  for (const m of month.expenses) {
    if (m.amount > SMALL_EXPENSE || day(m.date) > upTo) continue;
    const s = small.get(m.categoryId) ?? { count: 0, total: 0 };
    s.count += 1;
    s.total += m.amount;
    small.set(m.categoryId, s);
  }
  const ant = [...small].filter(([, s]) => s.count >= SMALL_MIN_COUNT).sort((a, b) => b[1].total - a[1].total)[0];
  if (ant) insights.push({ kind: 'small-expenses', level: 'info', categoryId: ant[0], count: ant[1].count, total: ant[1].total });

  // --- Un gasto fuera de lo normal para su categoría.
  const samples = new Map();
  for (const k of previous.slice(0, UNUSUAL_MONTHS)) {
    for (const m of months.get(k).expenses) {
      if (!samples.has(m.categoryId)) samples.set(m.categoryId, []);
      samples.get(m.categoryId).push(m.amount);
    }
  }
  let unusual = null;
  for (const m of month.expenses) {
    const list = samples.get(m.categoryId);
    if (day(m.date) > upTo || m.amount < UNUSUAL_MIN || !list || list.length < UNUSUAL_MIN_SAMPLES) continue;
    const typical = median(list);
    if (m.amount >= typical * UNUSUAL_FACTOR && (!unusual || m.amount / typical > unusual.amount / unusual.typical)) {
      unusual = { kind: 'unusual', level: 'info', movementId: m.id, categoryId: m.categoryId, amount: m.amount, date: m.date, note: m.note, typical };
    }
  }
  if (unusual) insights.push(unusual);

  // --- Ahorro del mes (ingresos − gastos) y racha de meses ahorrando. En el mes en curso solo si ya
  // ha entrado algún ingreso: quien cobra a final de mes no debe ver una alarma cada mes.
  const saved = month.income - now.total;
  const judgeSaving = !current || month.income > 0;
  if (judgeSaving && saved < 0) {
    insights.push({ kind: 'overspending', level: current ? 'info' : 'warn', saved, income: month.income, expense: now.total, current });
  } else if (judgeSaving && month.income > 0) {
    const rates = previous.slice(0, AVG_MONTHS).map((k) => months.get(k)).filter((p) => p.income > 0).map((p) => resultOf(p) / p.income);
    const rate = saved / month.income;
    const averageRate = rates.length ? mean(rates) : null;
    const good = averageRate === null ? rate >= 0.2 : rate >= averageRate;
    insights.push({ kind: 'saving-rate', level: good && !current ? 'good' : 'info', saved, rate, averageRate, current });
  }
  const streak = savingStreak(months, current ? previous[0] : key);
  if (streak >= 2) insights.push({ kind: 'saving-streak', level: 'good', months: streak });

  // --- Presupuestos: en el mes en curso, a qué ritmo vas; en uno pasado, cuántos cumpliste.
  const budgets = budgetStatus(state, key);
  if (budgets.length && current) {
    const alerts = [];
    for (const b of budgets) {
      if (b.spent > b.amount) {
        alerts.push({ kind: 'budget-over', level: 'warn', budget: b, over: b.spent - b.amount, urgency: 0 });
        continue;
      }
      const perDay = b.spent / upTo;
      const projected = Math.round(perDay * lengthOf(key));
      if (upTo >= MIN_DAYS && perDay > 0 && projected > b.amount) {
        const crossing = Math.min(lengthOf(key), Math.max(upTo + 1, Math.ceil(b.amount / perDay)));
        alerts.push({ kind: 'budget-forecast', level: 'warn', budget: b, day: crossing, projected, urgency: crossing });
      }
    }
    alerts.sort((a, b) => a.urgency - b.urgency);
    if (alerts.length) insights.push(...alerts.slice(0, 2).map(({ urgency, ...a }) => a));
    else insights.push({ kind: 'budgets-ok', level: 'good', count: budgets.length });
  } else if (budgets.length) {
    const over = budgets.filter((b) => b.spent > b.amount).length;
    insights.push({ kind: 'budgets-past', level: over ? 'info' : 'good', over, total: budgets.length });
  }

  return byLevel(insights);
}

/** Comentarios de un año 'AAAA' visto el día `today` (el año en curso, hasta hoy). */
export function yearInsights(state, year, today) {
  const thisYear = today.slice(0, 4);
  if (year > thisYear) return [];
  const current = year === thisYear;
  const elapsed = current ? Number(today.slice(5, 7)) : 12; // meses del año con algo que mirar
  const keysOf = (y, count) => Array.from({ length: count }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  const lastYear = String(Number(year) - 1);
  const keys = keysOf(year, elapsed);
  // El año anterior entero: para comparar el mismo periodo y para que la racha pueda venir de atrás.
  const months = groupByMonth(state, [...keys, ...keysOf(lastYear, 12)]);
  const withData = keys.filter((k) => hasData(months.get(k)));
  if (!withData.length) return [];
  const insights = [];

  // Mismo periodo del año anterior: los meses ya cerrados y el actual hasta el mismo día.
  const lastDay = (k) => (current && k === keys.at(-1) ? day(today) : 31);
  const sumYear = (y) => {
    let income = 0;
    let expense = 0;
    const byCategory = new Map();
    for (const k of keysOf(y, elapsed)) {
      const month = months.get(k);
      const s = spending(month.expenses, lastDay(`${year}-${k.slice(5)}`));
      income += month.income;
      expense += s.total;
      for (const [id, amount] of s.byCategory) byCategory.set(id, (byCategory.get(id) ?? 0) + amount);
    }
    return { income, expense, byCategory };
  };
  const now = sumYear(year);
  const before = sumYear(lastYear);
  const saved = now.income - now.expense;

  // --- Ahorro: lo que llevas y cómo acabarás el año, o el total del año. La previsión suma lo de los
  // meses cerrados y, para los que quedan (el actual incluido), tu media de esos meses.
  if (current) {
    const closed = keys.slice(0, -1).filter((k) => hasData(months.get(k)));
    if (closed.length) {
      const closedSum = closed.reduce((sum, k) => sum + resultOf(months.get(k)), 0);
      const projected = Math.round(closedSum + (closedSum / closed.length) * (12 - elapsed + 1));
      insights.push({ kind: 'year-projection', level: projected >= 0 ? 'good' : 'warn', saved, projected, months: closed.length });
    }
  } else {
    insights.push({ kind: 'year-saved', level: saved >= 0 ? 'good' : 'warn', saved, rate: now.income > 0 ? saved / now.income : null });
  }

  // --- Gastos frente al mismo periodo del año anterior, y la categoría que más sube.
  if (before.expense > 0) {
    const ratio = (now.expense - before.expense) / before.expense;
    insights.push({ kind: 'year-vs-last', level: ratio >= CHANGE ? 'warn' : ratio <= -CHANGE ? 'good' : 'info', spent: now.expense, previous: before.expense, ratio, current });
    const { up } = categoryChanges(now.byCategory, before.byCategory, YEAR_CATEGORY_MIN_DIFF);
    if (up && up.average > 0) insights.push({ kind: 'category-up-year', level: 'warn', ...up });
  }

  // --- Dónde más gastas en el año.
  const top = [...now.byCategory].sort((a, b) => b[1] - a[1])[0];
  if (top && now.expense > 0) insights.push({ kind: 'top-category-year', level: 'info', categoryId: top[0], amount: top[1], share: top[1] / now.expense });

  // --- Mejor mes (más ahorro) y el de más gasto, si hay al menos 3 meses con datos.
  if (withData.length >= 3) {
    const stats = withData.map((k) => ({ month: k, result: resultOf(months.get(k)), expense: spending(months.get(k).expenses).total }));
    const best = stats.reduce((a, b) => (b.result > a.result ? b : a));
    const priciest = stats.reduce((a, b) => (b.expense > a.expense ? b : a));
    insights.push({ kind: 'best-worst', level: 'info', best, priciest });
  }

  // --- Racha de meses ahorrando hasta el último mes cerrado del año.
  const streak = savingStreak(months, current ? addMonthKey(keys.at(-1), -1) : keys.at(-1));
  if (streak >= 2) insights.push({ kind: 'saving-streak', level: 'good', months: streak });

  return byLevel(insights);
}
