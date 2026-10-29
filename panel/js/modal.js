// Un solo modal para todo el panel (dialog nativo: atrapa el foco, se cierra con Esc, con Cerrar o con clic
// en el fondo). Mientras se guarda queda "ocupado": no se cierra y sus controles se desactivan.
import { escapar, estadoLargo } from './util.js';

let dialogo = null;
let aperturas = 0;

export function dialogoModal() {
  if (dialogo) return dialogo;
  dialogo = document.createElement('dialog');
  dialogo.className = 'modal';
  dialogo.setAttribute('aria-labelledby', 'modal-titulo');
  dialogo.addEventListener('click', (ev) => {
    if (ev.target === dialogo && !dialogo.dataset.ocupado) dialogo.close();
  });
  dialogo.addEventListener('cancel', (ev) => {
    if (dialogo.dataset.ocupado) ev.preventDefault();
  });
  document.body.append(dialogo);
  return dialogo;
}

/** Cuántas veces se abrió: una respuesta lenta no debe pintar en un modal que ya es otro */
export const aperturaActual = () => aperturas;

/**
 * Abre el modal con un título, el cuerpo (HTML ya escapado) y el pie (botones; los que llevan data-cerrar lo
 * cierran). El foco vuelve al control que lo abrió.
 */
export function abrirModal({ titulo, cuerpo, pie = '', ancho = false }) {
  const d = dialogoModal();
  const origen = document.activeElement;
  aperturas++;
  if (d.open) d.close();
  d.className = `modal${ancho ? ' modal-ancho' : ''}`;
  delete d.dataset.ocupado;
  d.innerHTML = `<div class="modal-caja">
      <div class="modal-cabeza"><h2 id="modal-titulo">${escapar(titulo)}</h2>
        <button type="button" class="boton boton-chico" data-cerrar aria-label="Cerrar">Cerrar</button></div>
      <div class="modal-cuerpo">${cuerpo}</div>
      ${pie ? `<div class="modal-pie">${pie}</div>` : ''}
    </div>`;
  d.querySelectorAll('[data-cerrar]').forEach((b) => b.addEventListener('click', () => !d.dataset.ocupado && d.close()));
  d.addEventListener('close', () => origen?.isConnected && origen.focus(), { once: true });
  d.showModal();
  return d;
}

export function ocupar(ocupado) {
  const d = dialogoModal();
  if (ocupado) d.dataset.ocupado = '1';
  else delete d.dataset.ocupado;
  d.querySelectorAll('button, input, select, textarea').forEach((x) => {
    if (ocupado) {
      x.dataset.estabaActivo = x.disabled ? '' : '1';
      x.disabled = true;
    } else if (x.dataset.estabaActivo) x.disabled = false;
  });
}

/** Mensaje dentro del modal, en el elemento con data-mensaje (vacío lo quita) */
export function mensajeModal(tipo, texto) {
  const m = dialogoModal().querySelector('[data-mensaje]');
  if (m) m.innerHTML = texto ? `<p style="margin-top:12px">${estadoLargo(tipo, texto)}</p>` : '';
}
