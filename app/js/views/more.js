// «Más»: acceso a cuentas, categorías, presupuestos, programados, seguridad, copias y ajustes.

import { h } from '../ui/dom.js';
import { section, list, row, tile, notice } from '../ui/components.js';
import { ago, monthLabel, dayMonth } from '../ui/format.js';
import { openSheet, confirmDialog } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { lockNow, resetApp, resetViews } from '../ui/session.js';
import { pwa, promptInstall, applyUpdate } from '../ui/pwa.js';
import * as router from '../ui/router.js';
import * as store from '../core/store.js';
import * as vault from '../core/vault.js';
import { AUTO_LOCK_OPTIONS } from '../core/catalog.js';
import { getAppearance, colorLabel, MODE_OPTIONS } from '../ui/theme.js';
import { currentPeriodKey, periodBounds, MONTH_START_DAYS } from '../core/dates.js';

/** Elegir el día en que empieza el mes de la app (p. ej. el de cobro). */
function openMonthStart() {
  let chosen = store.getState().settings.monthStartDay;
  const preview = h('p', { class: 'help', 'aria-live': 'polite' });
  const days = h('div', { class: 'day-grid', role: 'group', 'aria-label': 'Día en que empieza el mes' });
  const refresh = () => {
    for (const button of days.children) button.setAttribute('aria-pressed', String(Number(button.dataset.day) === chosen));
    const key = currentPeriodKey(chosen);
    const { start, end } = periodBounds(key, chosen);
    preview.textContent = chosen === 1
      ? `Meses de calendario: este mes es ${monthLabel(key).toLowerCase()}, del 1 al ${Number(end.slice(8))}.`
      : `Este mes será «${monthLabel(key)}»: del ${dayMonth(start)} al ${dayMonth(end)}.${chosen > 28 ? ' Si un mes no tiene ese día, empieza el último día de ese mes.' : ''}`;
  };
  for (let day = 1; day <= MONTH_START_DAYS; day += 1) {
    days.append(h('button', { type: 'button', class: 'day', dataset: { day: String(day) }, 'aria-label': `Día ${day}`, onClick: () => { chosen = day; refresh(); } }, String(day)));
  }
  refresh();
  const save = () => {
    store.updateSettings({ monthStartDay: chosen });
    resetViews(); // Análisis, Movimientos… vuelven al mes actual con el nuevo inicio
    sheet.close();
    toast(chosen === 1 ? 'El mes empieza el día 1' : `El mes empieza el día ${chosen}`);
  };
  const sheet = openSheet({
    title: 'Inicio del mes',
    tall: true,
    primary: { label: 'Guardar', onClick: save },
    body: [
      h('p', { class: 'help' }, 'Elige el día en que empieza tu mes, por ejemplo el día que cobras. Inicio, Análisis, Movimientos, los presupuestos y los comentarios usarán ese mes. Se llama como el mes en que empieza: con el día 24, «Noviembre» va del 24 de noviembre al 23 de diciembre.'),
      days,
      preview,
      h('button', { type: 'button', class: 'btn primary', onClick: save }, 'Guardar'),
    ],
  });
}

async function deleteEverything() {
  const confirmed = await confirmDialog({
    title: '¿Borrar todos los datos?',
    text: 'Se borrará todo lo guardado en este dispositivo: cuentas, movimientos, deudas y ajustes. Sin una copia de seguridad no podrás recuperarlo. Escribe BORRAR para confirmar.',
    confirmLabel: 'Borrar todo',
    danger: true,
    requireText: 'BORRAR',
  });
  if (!confirmed) return;
  try {
    await vault.destroy();
  } catch (error) {
    console.error(error);
    toast('No se han podido borrar los datos. Inténtalo de nuevo.', { kind: 'error' });
    return;
  }
  resetApp();
  toast('Se han borrado todos los datos.');
}

export function moreView() {
  const state = store.getState();
  const go = (path) => () => router.navigate(path);
  const autoLock = AUTO_LOCK_OPTIONS.find((o) => o.seconds === state.settings.autoLockSec)?.label ?? '';
  const lastBackup = state.settings.lastBackupAt;
  const count = (n) => (n ? String(n) : null);
  const appearance = getAppearance();
  const modeLabel = MODE_OPTIONS.find((o) => o.value === appearance.mode)?.label ?? '';

  return {
    title: 'Más',
    body: [
      pwa.updateReady ? notice({
        iconName: 'refresh',
        title: 'Hay una versión nueva',
        text: 'Actualiza para tener las últimas mejoras.',
        actions: [{ label: 'Actualizar', primary: true, onClick: () => store.flush().finally(applyUpdate) }],
      }) : null,
      section({ title: 'Tus datos' }, list([
        row({ lead: tile({ icon: 'building-bank', color: 'blue' }), title: 'Cuentas', value: count(state.accounts.filter((a) => !a.archived).length), chevron: true, onClick: go('/mas/cuentas') }),
        row({ lead: tile({ icon: 'tag', color: 'orange' }), title: 'Categorías', chevron: true, onClick: go('/mas/categorias') }),
        row({ lead: tile({ icon: 'target', color: 'green' }), title: 'Presupuestos', value: count(state.budgets.length), chevron: true, onClick: go('/mas/presupuestos') }),
        row({ lead: tile({ icon: 'pig-money', color: 'pink' }), title: 'Huchas', subtitle: 'Ahorra casilla a casilla', value: count(state.piggies.length), chevron: true, onClick: go('/mas/huchas') }),
        row({ lead: tile({ icon: 'repeat', color: 'purple' }), title: 'Programados', subtitle: 'Alquiler, nómina, suscripciones…', value: count(state.recurring.filter((r) => r.active).length), chevron: true, onClick: go('/mas/programados') }),
      ])),
      section({ title: 'Seguridad y copias' }, list([
        row({ lead: tile({ icon: 'shield-lock', color: 'graphite' }), title: 'Seguridad', subtitle: `PIN · bloqueo ${autoLock.toLowerCase()}`, chevron: true, onClick: go('/mas/seguridad') }),
        row({ lead: tile({ icon: 'download', color: 'teal' }), title: 'Copia de seguridad', subtitle: lastBackup ? `Última: ${ago(lastBackup)}` : 'Aún no has hecho ninguna', chevron: true, onClick: go('/mas/copias') }),
        row({ lead: tile({ icon: 'lock', color: 'gray' }), title: 'Bloquear ahora', onClick: () => lockNow() }),
      ])),
      section({ title: 'App' }, list([
        row({ lead: tile({ icon: 'brush', color: 'pink' }), title: 'Apariencia', subtitle: `${modeLabel} · ${colorLabel(appearance.color)}`, chevron: true, onClick: go('/mas/apariencia') }),
        row({ lead: tile({ icon: 'calendar', color: 'orange' }), title: 'Inicio del mes', subtitle: 'Por ejemplo, el día que cobras', value: `Día ${state.settings.monthStartDay}`, chevron: true, onClick: openMonthStart }),
        !pwa.isStandalone && pwa.canPromptInstall
          ? row({ lead: tile({ icon: 'device-mobile', color: 'indigo' }), title: 'Instalar la app', onClick: () => promptInstall() })
          : null,
        row({ lead: tile({ icon: 'info-circle', color: 'cyan' }), title: 'Acerca de y privacidad', chevron: true, onClick: go('/mas/acerca') }),
      ])),
      section({ caption: 'Borra todas las cuentas, movimientos, deudas y ajustes de este dispositivo.' },
        list([row({ title: 'Borrar todos los datos', className: 'danger', onClick: deleteEverything })], { plain: true })),
    ],
  };
}
