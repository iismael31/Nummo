import { test, assert } from './runner.js';
import { sampleState } from './fixtures.js';
import { monthInsights, yearInsights } from '../app/js/core/insights.js';

let seq = 0;
const mov = (date, type, amount, categoryId, note = '') => ({
  id: `mvIns${String(seq++).padStart(4, '0')}`, date, type, amount, accountId: 'accountAAA', categoryId, note, ts: seq,
});

/** Marzo–mayo: nómina de 2.000 €, comida 3 × 100 € (días 5, 15 y 25) y ocio 100 € (día 12). */
function history() {
  const state = sampleState();
  state.movements = state.movements.filter((m) => m.date >= '2026-09-01'); // los de septiembre y octubre
  for (const month of ['03', '04', '05']) {
    state.movements.push(
      mov(`2026-${month}-01`, 'income', 200000, 'catSalary'),
      mov(`2026-${month}-05`, 'expense', 10000, 'catFoodXX'),
      mov(`2026-${month}-15`, 'expense', 10000, 'catFoodXX'),
      mov(`2026-${month}-25`, 'expense', 10000, 'catFoodXX'),
      mov(`2026-${month}-12`, 'expense', 10000, 'catFunXXX'),
    );
  }
  // Junio: una compra de comida de 300 € (3 veces lo normal), ocio que se dispara y 9 cafés.
  state.movements.push(
    mov('2026-06-01', 'income', 200000, 'catSalary'),
    mov('2026-06-20', 'expense', 30000, 'catFoodXX', 'Compra grande'),
    mov('2026-06-12', 'expense', 22300, 'catFunXXX'),
    ...Array.from({ length: 9 }, (_, i) => mov(`2026-06-${String(2 + i * 3).padStart(2, '0')}`, 'expense', 300, 'catFunXXX', 'Café')),
  );
  return state;
}

const find = (list, kind) => list.find((i) => i.kind === kind);

test('insights: un mes cerrado frente a la media, gastos hormiga, gasto raro, ahorro y presupuestos', () => {
  const list = monthInsights(history(), '2026-06', '2026-10-11');
  const spend = find(list, 'spend-vs-average');
  assert.equal(spend.level, 'warn');
  assert.equal(spend.spent, 55000);
  assert.equal(spend.average, 40000);
  assert.equal(spend.months, 3);
  assert.deepEqual([find(list, 'category-up').categoryId, find(list, 'category-up').spent, find(list, 'category-up').average], ['catFunXXX', 25000, 10000]);
  assert.deepEqual([find(list, 'small-expenses').count, find(list, 'small-expenses').total], [9, 2700]);
  assert.deepEqual([find(list, 'unusual').amount, find(list, 'unusual').typical, find(list, 'unusual').note], [30000, 10000, 'Compra grande']);
  assert.equal(find(list, 'saving-rate').level, 'info', 'ahorra menos que su media (72,5 % frente a 80 %)');
  assert.equal(find(list, 'saving-streak').months, 4, 'marzo a junio');
  assert.deepEqual([find(list, 'budgets-past').over, find(list, 'budgets-past').total], [2, 2]);
  assert.equal(list[0].level, 'warn', 'los avisos van primero');
});

test('insights: el mes en curso (a estas alturas, sin alarmas si aún no has cobrado y con previsión)', () => {
  const state = history();
  state.budgets = [{ id: 'budgetFood', name: '', categoryIds: ['catFoodXX'], amount: 15000 }];
  for (const d of ['02', '05', '08']) state.movements.push(mov(`2026-07-${d}`, 'expense', 2000, 'catFoodXX'));
  const early = monthInsights(state, '2026-07', '2026-07-03');
  assert.ok(!find(early, 'spend-vs-average') && !find(early, 'budget-forecast'), 'los primeros días no se compara ni se prevé');
  const list = monthInsights(state, '2026-07', '2026-07-10');
  assert.ok(!find(list, 'overspending') && !find(list, 'saving-rate'), 'sin ingresos todavía no se juzga el ahorro');
  const forecast = find(list, 'budget-forecast');
  assert.equal(forecast.day, 25, '15.000 / (6.000 / 10 días)');
  assert.equal(forecast.projected, 18600);
  const spend = find(list, 'spend-vs-average');
  assert.equal(spend.current, true);
  // Hasta el día 10: abril y mayo 100 € de comida; junio, 3 cafés (9 €) → media 69,67 €.
  assert.equal(spend.average, 6967, 'la media de los meses anteriores hasta el día 10');
  assert.equal(spend.level, 'good', '60 € frente a 69,67 €: un 14 % menos');
  assert.equal(find(list, 'saving-streak').months, 4, 'la racha cuenta hasta el mes pasado');
  assert.deepEqual(monthInsights(state, '2026-08', '2026-07-10'), [], 'un mes futuro no tiene comentarios');
});

test('insights: el año (previsión de ahorro, categoría principal, mejor mes y racha)', () => {
  const state = history();
  state.movements.push(mov('2026-07-08', 'expense', 6000, 'catFoodXX'));
  const list = yearInsights(state, '2026', '2026-07-10');
  const projection = find(list, 'year-projection');
  assert.equal(projection.months, 4, 'marzo a junio son los meses cerrados con datos');
  // 6.250 € de marzo a junio + 1.562,50 € de media × 6 meses que quedan (julio a diciembre).
  assert.equal(projection.projected, 1562500);
  assert.equal(find(list, 'top-category-year').categoryId, 'catFoodXX');
  assert.deepEqual([find(list, 'best-worst').best.month, find(list, 'best-worst').priciest.month], ['2026-03', '2026-06']);
  assert.equal(find(list, 'saving-streak').months, 4);
  assert.ok(!find(list, 'year-vs-last'), 'sin datos del año anterior no se compara');
  assert.deepEqual(yearInsights(state, '2025', '2026-07-10'), []);
  assert.deepEqual(yearInsights(state, '2027', '2026-07-10'), []);
});
