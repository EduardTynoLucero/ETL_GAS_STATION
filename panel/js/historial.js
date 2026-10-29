// Pestaña "Historial de cargas": qué archivos entraron, cuáles se rechazaron y por qué.
import { bus, conexion, pedir, revisarConexion } from './estado.js';
import { tablaHtml } from './graficas.js';
import { escapar, estado, fechaHora, fmt, momento, nombreRegla, plural, SEVERIDAD } from './util.js';

let raiz;
let pendiente = true;
let seleccionada = null;
// La última consulta falló por conexión: el aviso de 'conexion' no la repite sola (si /api/estado sí
// responde, sería un ciclo sin fin). Se vuelve a pedir con Actualizar, al abrir la pestaña o cuando la
// conexión pasa de caída a conectada.
let fallo = false;
let estabaConectado = conexion.conectado;

export function iniciar(contenedor) {
  raiz = contenedor;
  raiz.innerHTML = `<section class="tarjeta"><div class="tarjeta-cabeza"><div><h2>Historial de cargas</h2>
    <p class="tarjeta-sub">Las últimas 100 cargas, hechas desde el panel o desde la consola. Haz clic en una para ver su detalle.</p></div>
    <div class="tarjeta-controles"><button type="button" class="boton boton-chico" id="hist-actualizar">Actualizar</button></div></div>
    <div id="hist-lista"></div></section><div id="hist-detalle"></div>`;
  // Actualizar deja el pedido pendiente: si justo se está revisando la conexión, cargar() espera y el
  // aviso de 'conexion' lo hace al terminar
  raiz.querySelector('#hist-actualizar').addEventListener('click', () => {
    pendiente = true;
    fallo = false;
    cargar();
  });
  bus.addEventListener('carga-terminada', () => (pendiente = true));
  // Solo cuando terminó de revisar: el aviso del inicio de la revisión no dispara nada
  bus.addEventListener('conexion', () => {
    if (conexion.revisando) return;
    const volvio = conexion.conectado && !estabaConectado;
    estabaConectado = conexion.conectado;
    if (volvio) fallo = false;
    // Sin conexión, cargar() solo pinta el aviso (no pide nada)
    if (pendiente && !raiz.hidden && (!conexion.conectado || !fallo)) cargar();
  });
}

export function mostrar() {
  if (pendiente) cargar();
}

const ESTADOS = {
  CARGADO: ['bueno', 'Cargado'],
  RECHAZADO: ['critico', 'Rechazado'],
  DUPLICADO: ['info', 'Repetido'],
  VALIDADO: ['aviso', 'Sin terminar'],
  RECIBIDO: ['aviso', 'Sin terminar'],
};
const estadoCarga = (e) => estado(...(ESTADOS[e] ?? ['info', e]));
const REPORTES = { CONSULTA_TICKETS: 'Tickets', COMPRAS: 'Compras', DESCONOCIDO: 'No reconocido' };
const nombreReporte = (t) => REPORTES[t] ?? t ?? '–';
// '26 oct, 07:55': en el celular la hora puede bajar a otro renglón, pero nunca se parte la fecha
const cuando = (c) => {
  const [dia, hora] = momento(c.iniciado_en, true).split(', ');
  return hora ? `<span class="nowrap">${escapar(dia)},</span> <span class="nowrap">${escapar(hora)}</span>` : escapar(dia);
};
// Nombres de archivo sin espacios: se pueden partir después de '_' o '-' y antes de la extensión
const partible = (nombre) => escapar(nombre).replace(/[_-]/g, '$&<wbr>').replace(/\./g, '<wbr>.');
const estadoCuadre = (c) => (c.cuadra === null ? '–' : c.cuadra ? estado('bueno', 'Cuadra') : estado('critico', 'No cuadra'));

async function cargar() {
  const lista = raiz.querySelector('#hist-lista');
  // En los dos casos la lista queda sin datos: se pide otra vez cuando avise 'conexion'
  if (!conexion.datos || conexion.revisando) {
    pendiente = true;
    lista.innerHTML = `<div class="cargando"><span class="girador"></span>Revisando la conexión…</div>`;
    return;
  }
  if (!conexion.conectado) {
    pendiente = true;
    lista.innerHTML = `<div class="vacio"><strong>El historial está en la base de datos</strong>${escapar(conexion.datos?.error ?? 'Sin conexión.')}</div>`;
    return;
  }
  lista.innerHTML = `<div class="cargando"><span class="girador"></span>Consultando…</div>`;
  fallo = false;
  let cargas;
  try {
    cargas = await pedir('/api/cargas');
  } catch (err) {
    lista.innerHTML = `<p>${estado('critico', err.message)}</p>`;
    // Se revisa la conexión para la insignia de arriba; con fallo = true su aviso no vuelve a pedir
    if (err.tipo === 'conexion') {
      fallo = true;
      revisarConexion();
    }
    return;
  }
  pendiente = false;
  if (!cargas.length) {
    lista.innerHTML = `<div class="vacio"><strong>Todavía no hay cargas</strong>Carga tu primer reporte en la pestaña <a href="#cargar">Cargar reporte</a>.</div>`;
    return;
  }
  // Lo que dice si la carga sirvió va primero. En pantallas angostas (estilos.css) se ocultan las
  // columnas secundarias y el cuadre pasa abajo del resultado, para que se vea sin desplazar la tabla
  lista.innerHTML = tablaHtml(
    [
      { titulo: 'Carga', valor: (c) => c.carga_id, der: true },
      {
        titulo: 'Resultado',
        valor: (c) => `${estadoCarga(c.estado)}${c.cuadra === null ? '' : `<span class="hist-cuadre-abajo">${estadoCuadre(c)}</span>`}`,
        html: true,
      },
      { titulo: 'Cuadre', valor: estadoCuadre, html: true, clase: 'hist-cuadre' },
      { titulo: 'Cuándo', valor: cuando, html: true, clase: 'hist-cuando' },
      { titulo: 'Reporte', valor: (c) => nombreReporte(c.tipo_reporte), clase: 'hist-secundaria' },
      { titulo: 'Archivo', valor: (c) => partible(c.archivo_nombre), html: true, clase: 'hist-archivo' },
      { titulo: 'Usuario', valor: (c) => c.usuario ?? '–', clase: 'hist-secundaria' },
      { titulo: 'Periodo', valor: (c) => (c.fecha_min ? `${fechaHora(c.fecha_min, false)} a ${fechaHora(c.fecha_max)}` : '–'), clase: 'hist-periodo' },
      { titulo: 'Turnos', valor: (c) => (c.turno_min ? `${c.turno_min} a ${c.turno_max}` : '–'), clase: 'hist-secundaria nowrap' },
      { titulo: 'Filas', valor: (c) => fmt.entero(c.filas_detalle), der: true },
      { titulo: 'Nuevos', valor: (c) => fmt.entero(c.insertadas), der: true },
      { titulo: 'Actualizados', valor: (c) => fmt.entero(c.actualizadas), der: true },
      { titulo: 'Sin cambio', valor: (c) => fmt.entero(c.sin_cambio), der: true, clase: 'hist-secundaria' },
      { titulo: 'Errores', valor: (c) => fmt.entero(c.errores), der: true },
      { titulo: 'Advertencias', valor: (c) => fmt.entero(c.advertencias), der: true, clase: 'hist-secundaria' },
    ],
    cargas,
  );
  // Cada fila abre el detalle de su carga, también con Enter o Espacio. Toda la lista es una sola parada
  // de Tab (la carga abierta, o la primera) y las flechas recorren las filas
  const filas = [...lista.querySelectorAll('tbody tr')];
  const activa = Math.max(0, cargas.findIndex((c) => c.carga_id === seleccionada));
  const enfocar = (tr) => {
    filas.forEach((x) => (x.tabIndex = x === tr ? 0 : -1));
    tr.focus();
  };
  filas.forEach((tr, i) => {
    const c = cargas[i];
    tr.classList.add('seleccionable');
    tr.tabIndex = i === activa ? 0 : -1;
    tr.setAttribute('aria-selected', String(c.carga_id === seleccionada));
    tr.title = c.mensaje ?? '';
    const abrir = (conTeclado) => {
      filas.forEach((x) => {
        x.setAttribute('aria-selected', String(x === tr));
        x.tabIndex = x === tr ? 0 : -1;
      });
      verDetalle(c.carga_id, conTeclado);
    };
    tr.addEventListener('click', () => abrir(false));
    tr.addEventListener('keydown', (ev) => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        abrir(true);
        return;
      }
      const destino = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: filas.length - 1 }[ev.key];
      if (destino === undefined) return;
      ev.preventDefault();
      enfocar(filas[Math.min(filas.length - 1, Math.max(0, destino))]);
    });
  });
  if (seleccionada) verDetalle(seleccionada);
}

/** Muestra el detalle de una carga; con enfocarTitulo (se abrió con teclado) el foco pasa a su título */
async function verDetalle(id, enfocarTitulo = false) {
  seleccionada = id;
  const cont = raiz.querySelector('#hist-detalle');
  cont.innerHTML = `<div class="tarjeta cargando"><span class="girador"></span>Leyendo la carga ${id}…</div>`;
  let d;
  try {
    d = await pedir(`/api/cargas/${id}`);
  } catch (err) {
    cont.innerHTML = `<div class="tarjeta"><p>${estado('critico', err.message)}</p></div>`;
    return;
  }
  if (seleccionada !== id) return;
  const c = d.carga;
  const compras = c.tipo_reporte === 'COMPRAS';
  // Lo de las columnas que se ocultan en pantallas angostas (turnos, sin cambio, advertencias) también va aquí
  const conteo = [
    nombreReporte(c.tipo_reporte),
    c.turno_min ? `Turnos ${c.turno_min} a ${c.turno_max}` : null,
    c.filas_detalle === null
      ? null
      : compras
        ? `${plural(c.filas_detalle, 'compra', 'compras')}: ${plural(c.insertadas, 'nueva', 'nuevas')}, ${plural(c.actualizadas, 'actualizada', 'actualizadas')}, ${fmt.entero(c.sin_cambio)} sin cambio`
        : `${plural(c.filas_detalle, 'ticket', 'tickets')}: ${plural(c.insertadas, 'nuevo', 'nuevos')}, ${plural(c.actualizadas, 'actualizado', 'actualizados')}, ${fmt.entero(c.sin_cambio)} sin cambio`,
    c.errores === null ? null : `${plural(c.errores, 'error', 'errores')}, ${plural(c.advertencias, 'advertencia', 'advertencias')}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const MEDIDAS = {
    cantidad: compras ? 'Cantidad' : 'Galones',
    iva: 'IVA',
    idp: 'IDP',
    descuento: 'Descuento',
    total: 'Total',
    total_neto: 'Total neto',
    costo_total: 'Costo',
    utilidad: 'Utilidad',
    fob_total: 'Costo FOB',
    cif_total: 'CIF',
  };
  cont.innerHTML = `
    <section class="tarjeta">
      <div class="tarjeta-cabeza"><div><h3 tabindex="-1">Carga ${c.carga_id}: ${escapar(c.archivo_nombre)}</h3>
        <p class="tarjeta-sub">${escapar(momento(c.iniciado_en))} · ${escapar(c.usuario ?? 'sin usuario')}${c.segundos !== null ? ` · ${escapar(fmt.numero(c.segundos, 1))} s` : ''}</p>
        ${conteo ? `<p class="tarjeta-sub">${escapar(conteo)}</p>` : ''}</div>
        <div class="tarjeta-controles">${estadoCarga(c.estado)}</div></div>
      ${c.mensaje ? `<p style="margin-bottom:12px">${escapar(c.mensaje)}</p>` : ''}
      <div class="rejilla">
        <div class="col-6">
          <h4 style="margin-bottom:8px">Revisión de calidad</h4>
          ${
            d.incidencias.length
              ? `<ul class="lista-incidencias">${d.incidencias
                  .map((g) => {
                    const s = SEVERIDAD[g.severidad];
                    return `<li><details><summary>${estado(s.tipo, s.texto)}<span>${escapar(nombreRegla(g.regla))}</span><span class="cuenta">${fmt.entero(g.cantidad)}</span></summary>
                      <ul>${g.ejemplos.map((m) => `<li>${escapar(m)}</li>`).join('')}${g.cantidad > g.ejemplos.length ? `<li class="apagado">… y ${fmt.entero(g.cantidad - g.ejemplos.length)} más (tabla etl.incidencia)</li>` : ''}</ul></details></li>`;
                  })
                  .join('')}</ul>`
              : `<p>${estado('bueno', 'Sin observaciones')}</p>`
          }
          ${
            d.cambios.length
              ? `<h4 style="margin:16px 0 8px">Qué cambió en ${compras ? 'compras' : 'tickets'} que ya estaban</h4>${tablaHtml(
                  [
                    { titulo: 'Entidad', valor: (x) => ({ TICKET: 'Ticket', CLIENTE: 'Cliente', COMPRA: 'Compra' })[x.entidad] ?? x.entidad },
                    { titulo: 'Campo', valor: (x) => x.campo },
                    { titulo: 'Cantidad', valor: (x) => fmt.entero(x.cantidad), der: true },
                  ],
                  d.cambios,
                )}<p class="nota" style="margin-top:6px">El valor anterior y el nuevo de cada cambio están en la tabla etl.cambio.</p>`
              : ''
          }
        </div>
        <div class="col-6">
          <h4 style="margin-bottom:8px">Cuadre contra el reporte</h4>
          ${
            d.cuadre.length
              ? `<p style="margin-bottom:8px">${
                  d.cuadre.every((q) => q.cuadra) ? estado('bueno', `Todo cuadra (${plural(d.cuadre.length, 'comparación', 'comparaciones')})`) : estado('critico', `${d.cuadre.filter((q) => !q.cuadra).length} comparaciones no cuadran`)
                }</p><div style="max-height:340px;overflow:auto">${tablaHtml(
                  [
                    { titulo: 'Grupo', valor: (q) => q.grupo },
                    { titulo: 'Medida', valor: (q) => MEDIDAS[q.medida] ?? q.medida },
                    { titulo: compras ? 'Suma compras' : 'Suma tickets', valor: (q) => fmt.numero(Number(q.suma), 2), der: true },
                    { titulo: 'Reporte', valor: (q) => fmt.numero(Number(q.reporte), 2), der: true },
                    { titulo: '', valor: (q) => (q.cuadra ? estado('bueno', 'Cuadra') : estado('critico', 'No cuadra')), html: true },
                  ],
                  d.cuadre,
                )}</div>`
              : `<p class="nota">Esta carga no llegó a cuadrarse (el archivo se rechazó antes o era repetido).</p>`
          }
        </div>
      </div>
    </section>`;
  if (enfocarTitulo) cont.querySelector('h3').focus({ preventScroll: true });
  // scroll-margin-top de #hist-detalle (estilos.css) lo deja debajo del encabezado fijo
  cont.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

