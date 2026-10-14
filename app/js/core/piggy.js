// Huchas: retos de ahorro con casillas de importes fijos (por ejemplo, 100 casillas de 2 a 20 € que
// suman 1.000 €). Aquí está la lógica pura, sin DOM: el reparto de las casillas, qué casillas tacha
// cada ingreso, el estado de cada hucha y el análisis del ritmo. Importes en céntimos.
//
// El dinero de una hucha son sus movimientos de tipo 'piggy': 'in' (meter, con las casillas que
// tacha) y 'out' (vaciarla al terminar). Lo que se mete y aún no completa una casilla queda «suelto»
// y se usa en el siguiente ingreso.

import { diffDays, addDays } from './dates.js';
import { LIMITS } from './model.js';

/** Importes posibles de las casillas (1 € a 1.000 €). */
export const DENOMINATIONS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].map((euros) => euros * 100);
export const DEFAULT_DENOMINATIONS = [5, 10, 20, 50, 100, 200].map((euros) => euros * 100);
export const BOX_PRESETS = [
  { count: 52, label: '52 · semanal' },
  { count: 100, label: '100' },
  { count: 200, label: '200' },
  { count: 365, label: '365 · diaria' },
];
/** Parte del objetivo que va, por defecto, en las casillas más grandes. */
const BIG_SHARE = 0.12;

const sortedUnique = (values) => [...new Set(values)].sort((a, b) => a - b);

/**
 * Cuántas casillas del importe más alto caben como mínimo y como máximo para que el resto se pueda
 * repartir entre los demás importes. null si el objetivo no cabe en ese número de casillas.
 */
export function bigRange(goal, count, denominations) {
  const d = sortedUnique(denominations);
  if (!d.length || count < 1) return null;
  const top = d[d.length - 1];
  if (d.length === 1) return count * top === goal ? { min: count, max: count } : null;
  const low = d[0];
  const second = d[d.length - 2];
  const min = Math.max(0, Math.ceil((goal - count * second) / (top - second)));
  const max = Math.min(count, Math.floor((goal - count * low) / (top - low)));
  return min <= max ? { min, max } : null;
}

/** Casillas grandes por defecto: alrededor del 12 % del objetivo, dentro de lo posible. */
export function autoBigCount(goal, count, denominations) {
  const range = bigRange(goal, count, denominations);
  if (!range) return null;
  const top = Math.max(...denominations);
  const wanted = Math.max(1, Math.round((goal * BIG_SHARE) / top));
  return Math.min(range.max, Math.max(range.min, wanted));
}

/** Objetivo mínimo y máximo posibles con ese número de casillas e importes. */
export function goalRange(count, denominations) {
  const d = sortedUnique(denominations);
  return { min: count * d[0], max: count * d[d.length - 1] };
}

/**
 * Reparte `count` casillas entre los importes `rest` (de menor a mayor) para que sumen `goal`.
 * Empieza con todas en el importe menor y las va subiendo: primero al azar (para que haya de todo)
 * y luego ajustando lo que falte. Devuelve las cantidades por importe o null si no cuadra.
 */
function splitRest(goal, count, rest, random) {
  if (!rest.length) return goal === 0 && count === 0 ? [] : null;
  const counts = rest.map(() => 0);
  counts[0] = count;
  let missing = goal - count * rest[0];
  if (missing < 0) return null;
  for (let i = rest.length - 1; i >= 1 && missing > 0; i -= 1) {
    const step = rest[i] - rest[0];
    const share = 0.25 + random() * 0.35;
    const n = Math.min(counts[0], Math.floor((share * missing) / step));
    counts[i] += n;
    counts[0] -= n;
    missing -= n * step;
  }
  // Ajuste fino: el mayor salto entre dos importes que todavía quepa.
  for (let guard = 0; missing > 0 && guard < 10_000; guard += 1) {
    let best = null;
    for (let i = 0; i < rest.length; i += 1) {
      if (!counts[i]) continue;
      for (let j = i + 1; j < rest.length; j += 1) {
        const step = rest[j] - rest[i];
        if (step <= missing && (!best || step > best.step)) best = { i, j, step };
      }
    }
    if (!best) break;
    const n = Math.min(counts[best.i], Math.floor(missing / best.step));
    counts[best.i] -= n;
    counts[best.j] += n;
    missing -= n * best.step;
  }
  return missing === 0 ? counts : null;
}

export function shuffle(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Reparto de las casillas de una hucha nueva. `bigCount`: casillas del importe más alto (null =
 * automático). Devuelve { counts: [{ amount, count }], boxes: [importe…] mezcladas } o null si con
 * esos datos no hay un reparto exacto. Cada llamada da una distribución distinta.
 */
export function planBoxes({ goal, count, denominations, bigCount = null, random = Math.random }) {
  const d = sortedUnique(denominations);
  if (!d.length || !Number.isSafeInteger(goal) || goal < 1 || !Number.isSafeInteger(count) || count < 1 || count > LIMITS.boxes) return null;
  const range = bigRange(goal, count, d);
  if (!range) return null;
  const big = bigCount ?? autoBigCount(goal, count, d);
  if (!Number.isSafeInteger(big) || big < range.min || big > range.max) return null;
  const top = d[d.length - 1];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const rest = d.length === 1 ? [] : splitRest(goal - big * top, count - big, d.slice(0, -1), random);
    if (!rest) continue;
    const counts = d.map((amount, i) => ({ amount, count: i === d.length - 1 ? big : rest[i] }));
    const boxes = counts.flatMap(({ amount, count: n }) => Array(n).fill(amount));
    return { counts: counts.filter((c) => c.count > 0), boxes: shuffle(boxes, random) };
  }
  return null;
}

/**
 * Casillas que tacha un ingreso: de las que quedan, las más grandes que quepan en `available`
 * (lo que se mete más lo suelto). Devuelve { indexes, sum }; lo que sobra queda suelto.
 */
export function chooseBoxes(boxes, paid, available) {
  const pending = boxes
    .map((amount, index) => ({ amount, index }))
    .filter((b) => !paid.has(b.index))
    .sort((a, b) => b.amount - a.amount || a.index - b.index);
  let left = available;
  const indexes = [];
  for (const box of pending) {
    if (box.amount <= left) {
      indexes.push(box.index);
      left -= box.amount;
    }
  }
  return { indexes, sum: available - left };
}

/** Resumen «10 × 20 € y 1 × 5 €» de unas casillas: [{ amount, count }] de mayor a menor. */
export function groupBoxes(boxes, indexes) {
  const counts = new Map();
  for (const i of indexes) counts.set(boxes[i], (counts.get(boxes[i]) ?? 0) + 1);
  return [...counts].map(([amount, count]) => ({ amount, count })).sort((a, b) => b.amount - a.amount);
}

/**
 * Estado de una hucha a partir de sus movimientos: casillas pagadas, lo metido, lo suelto y si ya se
 * vació. `movements`: solo los de esta hucha.
 */
export function piggyStatus(piggy, movements) {
  const history = [...movements].sort((a, b) => a.ts - b.ts || (a.date < b.date ? -1 : 1));
  const paid = new Map(); // casilla → movimiento que la pagó
  let deposited = 0;
  let withdrawn = 0;
  let paidAmount = 0;
  for (const m of history) {
    if (m.flow === 'in') {
      deposited += m.amount;
      for (const i of m.boxes) {
        paid.set(i, m);
        paidAmount += piggy.boxes[i];
      }
    } else {
      withdrawn += m.amount;
    }
  }
  return {
    paid,
    paidCount: paid.size,
    deposited,
    withdrawn,
    saved: deposited - withdrawn,
    loose: deposited - paidAmount,
    closed: withdrawn > 0,
    history,
    lastIn: history.filter((m) => m.flow === 'in').at(-1) ?? null,
  };
}

/** Estado de todas las huchas en una sola pasada por los movimientos. Map id → estado. */
export function piggyStatuses(state) {
  const byPiggy = new Map((state.piggies ?? []).map((p) => [p.id, []]));
  for (const m of state.movements) if (m.type === 'piggy') byPiggy.get(m.piggyId)?.push(m);
  return new Map((state.piggies ?? []).map((p) => [p.id, piggyStatus(p, byPiggy.get(p.id))]));
}

const AVG_DAYS_PER_MONTH = 30.44;

/**
 * Análisis de una hucha en una fecha: si vas bien según el plan (ahorro repartido por igual hasta la
 * fecha límite), cuánto te falta por semana y al día, cuándo acabarás a tu ritmo y la racha de
 * semanas metiendo dinero. Con `money` (lo que sueles ahorrar al mes, lo que llevas este mes y tu
 * mayor gasto) añade consejos que cruzan la hucha con tus cuentas.
 */
export function analyzePiggy(piggy, status, today, money = null) {
  const totalDays = Math.max(1, diffDays(piggy.startDate, piggy.deadline));
  const elapsed = Math.min(totalDays, Math.max(0, diffDays(piggy.startDate, today)));
  // Días que quedan contando hoy (hoy todavía se puede meter dinero).
  const daysLeft = today > piggy.deadline ? 0 : diffDays(today, piggy.deadline) + 1;
  const saved = status.deposited;
  const remaining = Math.max(0, piggy.goal - saved);
  const expected = Math.round((piggy.goal * elapsed) / totalDays);
  const diff = saved - expected;
  const planWeekly = Math.round((piggy.goal * 7) / totalDays);
  const neededDaily = daysLeft > 0 ? Math.round(remaining / daysLeft) : remaining;
  const neededWeekly = daysLeft > 0 ? Math.round((remaining * 7) / daysLeft) : remaining;

  let level;
  if (status.closed) level = 'closed';
  else if (remaining === 0) level = 'done';
  else if (today > piggy.deadline) level = 'late';
  else if (saved === 0 && elapsed === 0) level = 'start'; // recién creada: aún no hay ritmo que juzgar
  else if (diff >= 0) level = 'ok';
  else if (diff >= -planWeekly) level = 'warn';
  else level = 'behind';

  // Ritmo real desde el primer día: ¿cuándo se acabaría siguiendo igual?
  let projection = null;
  if (remaining > 0 && saved > 0 && elapsed > 0) {
    const perDay = saved / elapsed;
    const finish = addDays(today, Math.ceil(remaining / perDay));
    projection = { perWeek: Math.round(perDay * 7), finish, daysVsDeadline: diffDays(piggy.deadline, finish) };
  }

  // Racha: semanas seguidas (contando hacia atrás desde esta o la anterior) con algún ingreso.
  const weekOf = (date) => Math.floor(diffDays(piggy.startDate, date) / 7);
  const weeks = new Set(status.history.filter((m) => m.flow === 'in').map((m) => weekOf(m.date)));
  let week = weekOf(today);
  if (!weeks.has(week)) week -= 1;
  let streak = 0;
  while (weeks.has(week)) {
    streak += 1;
    week -= 1;
  }

  const tips = [];
  if (money && remaining > 0 && daysLeft > 0 && !status.closed) {
    const neededMonthly = Math.round((remaining * AVG_DAYS_PER_MONTH) / daysLeft);
    if (money.avgMonthlySaving > 0) {
      if (money.avgMonthlySaving >= neededMonthly) {
        tips.push({ kind: 'saving-ok', avgMonthlySaving: money.avgMonthlySaving, neededMonthly });
      } else {
        const months = remaining / money.avgMonthlySaving;
        tips.push({ kind: 'saving-short', avgMonthlySaving: money.avgMonthlySaving, neededMonthly, reachable: addDays(today, Math.ceil(months * AVG_DAYS_PER_MONTH)) });
      }
    }
    if (money.monthNet > 0) {
      tips.push({ kind: 'month-left', monthNet: money.monthNet, suggestion: Math.min(remaining, neededWeekly, money.monthNet) });
    }
    if (money.topCategory && money.topCategory.amount > 0) {
      const cut = Math.round(money.topCategory.amount * 0.1);
      const pace = projection ? projection.perWeek / 7 : neededDaily;
      tips.push({ kind: 'cut', category: money.topCategory.name, amount: money.topCategory.amount, cut, daysSooner: pace > 0 ? Math.floor(cut / pace) : 0 });
    }
  }

  return {
    level,
    saved,
    remaining,
    ratio: saved / piggy.goal,
    timeRatio: elapsed / totalDays,
    expected,
    diff,
    planWeekly,
    neededWeekly,
    neededDaily,
    daysLeft,
    totalDays,
    projection,
    streak,
    tips,
  };
}
