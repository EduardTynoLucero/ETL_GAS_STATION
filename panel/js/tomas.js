// Pestaña "Tomas físicas": una tabla con búsqueda, orden por columna y páginas. Registrar, editar, anular,
// restaurar y ver la bitácora se hacen en un modal (dialog nativo: atrapa el foco y se cierra con Esc). Nada
// se borra: una toma equivocada se anula y se puede restaurar. El inventario usa solo las tomas vigentes.
import { bus, conexion, pedir, preferencia, revisarConexion } from './estado.js';
import { conPunto, conectarSegmentado, ordenarProductos, segmentado, tablaHtml, varProducto } from './graficas.js';
import { abrirModal, aperturaActual, dialogoModal, mensajeModal, ocupar } from './modal.js';
import { escapar, estado, estadoLargo, fecha, fechaHora, fmt, ICONOS, insignia, momento, plural } from './util.js';

let raiz;
let opciones = null;
let filtros = null;
let lista = [];
const tabla = { buscar: '', orden: 'fecha_hora', direccion: 'desc', pagina: 1, porPagina: 25 };
let pedido = 0;
let pedidoLista = 0;
let pendiente = true;
let modal = null; // el <dialog> compartido del panel (modal.js)

export function iniciar(contenedor) {
  raiz = contenedor;
  raiz.innerHTML = `<div id="tf-filtros"></div><div id="tf-cuerpo" class="pila"></div>`;
  modal = dialogoModal();
  bus.addEventListener('conexion', () => {
    if (pendiente && !conexion.revisando && !raiz.hidden) cargar();
  });
}

export function mostrar() {
  pendiente = true;
  cargar();
}

const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const masDias = (t, n) => new Date(new Date(`${t}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const conSigno = (n) => (n > 0 ? `+${fmt.galones(n)}` : fmt.galones(n));

/** Faltante o sobrante contra lo que debía haber, con palabra (el color nunca va solo) */
function diferencia(n) {
  if (n === null || n === undefined) return '<span class="apagado">–</span>';
  if (Math.abs(n) < 0.0005) return estado('bueno', 'Cuadra');
  return estado(n < 0 ? 'aviso' : 'info', `${n < 0 ? 'Faltante' : 'Sobrante'} ${conSigno(n)}`);
}

async function cargar() {
  const cuerpo = raiz.querySelector('#tf-cuerpo');
  if (!conexion.datos || conexion.revisando) {
    cuerpo.innerHTML = `<div class="tarjeta cargando"><span class="girador"></span>Revisando la conexión…</div>`;
    return;
  }
  if (!conexion.conectado) {
    pendiente = true;
    raiz.querySelector('#tf-filtros').innerHTML = '';
    cuerpo.innerHTML = `<div class="tarjeta vacio"><strong>Las tomas físicas están en la base de datos</strong>${escapar(conexion.datos?.error ?? 'Sin conexión.')}
      <p style="margin-top:12px"><button type="button" class="boton" id="tf-reintentar">Reintentar</button></p></div>`;
    cuerpo.querySelector('#tf-reintentar').addEventListener('click', (ev) => {
      ev.target.disabled = true;
      revisarConexion();
    });
    return;
  }
  const yo = ++pedido;
  try {
    const nuevas = await pedir('/api/tomas/opciones');
    if (yo !== pedido) return;
    opciones = nuevas;
    if (!opciones.instalado) {
      pendiente = false;
      raiz.querySelector('#tf-filtros').innerHTML = '';
      const scripts =
        opciones.falta === 'tomas'
          ? '<span class="ruta">sql/actualizar_compras_inventario.sql</span> y después <span class="ruta">sql/actualizar_tomas_fisicas.sql</span>'
          : '<span class="ruta">sql/actualizar_tomas_fisicas.sql</span>';
      cuerpo.innerHTML = `<div class="veredicto veredicto-aviso" role="status">${ICONOS.aviso}<div>
        <h2>Falta actualizar la base de datos</h2>
        <p>Para registrar, editar y restaurar tomas físicas con su bitácora, ejecuta ${scripts} en pgAdmin (Query Tool sobre gas_station_db, F5), o en la consola <span class="ruta">npm run instalar-bd</span>. No borra ni cambia nada de lo que ya está guardado.</p>
        </div><div class="veredicto-acciones"><button type="button" class="boton" id="tf-actualizar">Ya la actualicé</button></div></div>`;
      cuerpo.querySelector('#tf-actualizar').addEventListener('click', mostrar);
      return;
    }
    if (!opciones.estaciones.length) {
      pendiente = false;
      raiz.querySelector('#tf-filtros').innerHTML = '';
      cuerpo.innerHTML = `<div class="tarjeta vacio"><strong>Todavía no hay estaciones</strong>Carga primero la Consulta de Tickets o el Reporte de compras en <a href="#cargar">Cargar reporte</a>.</div>`;
      return;
    }
    if (!filtros || !opciones.estaciones.some((e) => e.codigo === filtros.estacion)) {
      const guardada = preferencia.leer('inventario-estacion', '');
      const codigos = opciones.estaciones.map((e) => e.codigo);
      filtros = { estacion: codigos.includes(guardada) ? guardada : codigos[0], desde: masDias(hoy(), -60), hasta: hoy(), producto: '', estado: 'vigentes' };
    }
    pintarFiltros();
    if (!cuerpo.querySelector('#tf-tabla')) pintarTarjeta();
    await consultarLista();
    pendiente = false;
  } catch (err) {
    if (yo !== pedido) return;
    pendiente = true;
    cuerpo.innerHTML = `<div class="veredicto veredicto-critico">${ICONOS.critico}<div><h2>No se pudieron leer las tomas físicas</h2><p>${escapar(err.message)}</p></div>
      <div class="veredicto-acciones"><button type="button" class="boton" id="tf-reintentar">Reintentar</button></div></div>`;
    cuerpo.querySelector('#tf-reintentar').addEventListener('click', (ev) => {
      ev.target.disabled = true;
      if (err.tipo === 'conexion') revisarConexion();
      else cargar();
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Filtros que van al servidor

const ESTADOS = [
  { valor: 'vigentes', texto: 'Vigentes' },
  { valor: 'anuladas', texto: 'Anuladas' },
  { valor: 'todas', texto: 'Todas' },
];

function pintarFiltros() {
  const cont = raiz.querySelector('#tf-filtros');
  cont.innerHTML = `
    <div class="filtros" role="search" aria-label="Filtros de las tomas físicas">
      <label class="campo">Estación<select id="tf-estacion">${opciones.estaciones
        .map((e) => `<option value="${escapar(e.codigo)}">${escapar(`${e.codigo} · ${e.nombre}`)}</option>`)
        .join('')}</select></label>
      <label class="campo">Desde<input type="date" id="tf-desde" /></label>
      <label class="campo">Hasta<input type="date" id="tf-hasta" /></label>
      <label class="campo">Producto<select id="tf-producto"><option value="">Todos</option>${ordenarProductos(opciones.productos)
        .map((p) => `<option value="${escapar(p)}">${escapar(p)}</option>`)
        .join('')}</select></label>
      <div class="campo">Estado${segmentado('tf-estado', ESTADOS, filtros.estado)}</div>
      <span class="separador"></span>
      <button type="button" class="boton boton-chico" id="tf-recargar">Actualizar</button>
    </div>`;
  cont.querySelector('#tf-estacion').value = filtros.estacion;
  cont.querySelector('#tf-desde').value = filtros.desde ?? '';
  cont.querySelector('#tf-hasta').value = filtros.hasta ?? '';
  cont.querySelector('#tf-producto').value = filtros.producto;
  const aplicar = () => {
    let desde = cont.querySelector('#tf-desde').value;
    const hasta = cont.querySelector('#tf-hasta').value;
    // Desde después de Hasta: se busca solo ese día
    if (desde && hasta && desde > hasta) desde = hasta;
    filtros = { ...filtros, estacion: cont.querySelector('#tf-estacion').value, desde, hasta, producto: cont.querySelector('#tf-producto').value };
    preferencia.guardar('inventario-estacion', filtros.estacion);
    tabla.pagina = 1;
    consultarLista().catch(pintarErrorLista);
  };
  for (const id of ['#tf-estacion', '#tf-desde', '#tf-hasta', '#tf-producto']) cont.querySelector(id).addEventListener('change', aplicar);
  conectarSegmentado(cont, 'tf-estado', (v) => {
    filtros.estado = v;
    aplicar();
  });
  cont.querySelector('#tf-recargar').addEventListener('click', mostrar);
}

// ---------------------------------------------------------------------------------------------
// La tabla: búsqueda, orden y páginas en el navegador (son a lo más 500 tomas)

function pintarTarjeta() {
  const cuerpo = raiz.querySelector('#tf-cuerpo');
  cuerpo.innerHTML = `
    <section class="tarjeta">
      <div class="tarjeta-cabeza"><div><h2 id="tf-titulo">Tomas físicas</h2><p class="tarjeta-sub" id="tf-sub"></p></div>
        <div class="tarjeta-controles"><button type="button" class="boton boton-principal" id="tf-nueva">Nueva toma física</button></div></div>
      <div id="tf-aviso" role="status"></div>
      <div class="tabla-barra">
        <input type="search" class="entrada" id="tf-buscar" placeholder="Buscar producto, observación, quién…" aria-label="Buscar en la tabla" />
        <label class="campo" style="flex-direction:row;align-items:center;gap:6px">Filas por página
          <select id="tf-por-pagina">${[10, 25, 50, 100].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></label>
      </div>
      <div id="tf-tabla"></div>
      <div class="paginacion" id="tf-paginas"></div>
    </section>`;
  cuerpo.querySelector('#tf-nueva').addEventListener('click', () => abrirFormulario(null));
  const buscar = cuerpo.querySelector('#tf-buscar');
  buscar.value = tabla.buscar;
  let espera;
  buscar.addEventListener('input', () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      tabla.buscar = buscar.value;
      tabla.pagina = 1;
      pintarTabla();
    }, 200);
  });
  const porPagina = cuerpo.querySelector('#tf-por-pagina');
  porPagina.value = String(tabla.porPagina);
  porPagina.addEventListener('change', () => {
    tabla.porPagina = Number(porPagina.value);
    tabla.pagina = 1;
    pintarTabla();
  });
}

async function consultarLista() {
  if (!raiz.querySelector('#tf-tabla')) return;
  // Contador propio: un cambio de filtro mientras llega otra lista no debe pintar la vieja
  const yo = ++pedidoLista;
  const q = new URLSearchParams({ estacion: filtros.estacion, estado: filtros.estado });
  for (const k of ['desde', 'hasta', 'producto']) if (filtros[k]) q.set(k, filtros[k]);
  const datos = await pedir(`/api/tomas?${q}`);
  if (yo !== pedidoLista) return;
  lista = datos;
  pintarTabla();
}

function pintarErrorLista(err) {
  const cont = raiz.querySelector('#tf-tabla');
  if (cont) cont.innerHTML = `<p>${estadoLargo('critico', err.message)}</p>`;
  if (err.tipo === 'conexion') revisarConexion();
}

/** Aviso breve arriba de la tabla (lo que hizo el último modal) */
function avisar(tipo, texto) {
  const a = raiz.querySelector('#tf-aviso');
  if (a) a.innerHTML = texto ? `<p style="margin-bottom:10px">${estadoLargo(tipo, texto)}</p>` : '';
}

const COLUMNAS = [
  { clave: 'fecha_hora', titulo: 'Fecha y hora', ordena: (m) => m.fecha_hora, valor: (m) => `<span class="nowrap">${escapar(fechaHora(m.fecha_hora))}</span>` },
  { clave: 'producto', titulo: 'Producto', ordena: (m) => m.producto, valor: (m) => conPunto(m.producto, varProducto(m.producto)) },
  { clave: 'galones', titulo: 'Medido', der: true, ordena: (m) => m.galones, valor: (m) => escapar(fmt.galones(m.galones)) },
  { clave: 'teorico', titulo: 'Debía haber', der: true, ordena: (m) => (m.anulada ? null : m.teorico), valor: (m) => (m.anulada || m.teorico === null ? '–' : escapar(fmt.galones(m.teorico))) },
  {
    clave: 'diferencia',
    titulo: 'Diferencia',
    ordena: (m) => (m.anulada ? null : m.diferencia),
    valor: (m) => (m.anulada ? '' : m.teorico === null ? '<span class="apagado">Primera toma</span>' : diferencia(m.diferencia)),
  },
  { clave: 'observaciones', titulo: 'Observaciones', clase: 'tf-secundaria', valor: (m) => escapar(m.observaciones ?? '') },
  { clave: 'usuario', titulo: 'Registró', clase: 'tf-secundaria', ordena: (m) => m.usuario ?? '', valor: (m) => escapar(`${m.usuario ?? 'sin nombre'} · ${momento(m.registrada_en, true)}`) },
  { clave: 'estado', titulo: 'Estado', ordena: (m) => (m.anulada ? 2 : m.modificada_en ? 1 : 0), valor: estadoToma },
  { clave: 'acciones', titulo: 'Acciones', valor: acciones },
];

function filasVisibles() {
  const b = tabla.buscar.trim().toLowerCase();
  const filtradas = !b
    ? lista
    : lista.filter((m) =>
        [m.producto, m.fecha_hora, fechaHora(m.fecha_hora), m.observaciones, m.usuario, m.modificada_por, m.anulada_por, String(m.galones)]
          .map((v) => String(v ?? '').toLowerCase())
          .join(' ')
          .includes(b),
      );
  const col = COLUMNAS.find((c) => c.clave === tabla.orden) ?? COLUMNAS[0];
  const signo = tabla.direccion === 'asc' ? 1 : -1;
  // Los vacíos van siempre al final; los empates, por fecha más nueva
  return [...filtradas].sort((x, y) => {
    const a = col.ordena(x);
    const z = col.ordena(y);
    if (a === null || a === undefined) return z === null || z === undefined ? 0 : 1;
    if (z === null || z === undefined) return -1;
    const r = typeof a === 'number' ? a - z : String(a).localeCompare(String(z));
    return r * signo || y.fecha_hora.localeCompare(x.fecha_hora);
  });
}

function pintarTabla() {
  const cont = raiz.querySelector('#tf-tabla');
  if (!cont) return;
  const periodo = [filtros.desde && `desde el ${fecha(filtros.desde, true)}`, filtros.hasta && `hasta el ${fecha(filtros.hasta, true)}`].filter(Boolean).join(' ');
  const nombreEstado = { vigentes: 'vigentes', anuladas: 'anuladas', todas: '' }[filtros.estado];
  raiz.querySelector('#tf-titulo').textContent = `Tomas físicas de ${filtros.estacion}`;
  raiz.querySelector('#tf-sub').textContent =
    `${plural(lista.length, 'toma', 'tomas')}${nombreEstado ? ` ${nombreEstado}` : ''}${periodo ? ` ${periodo}` : ''}. ` +
    '"Debía haber" sale de la toma anterior del mismo producto, más las compras y menos las ventas de en medio.';

  const filas = filasVisibles();
  const paginas = Math.max(1, Math.ceil(filas.length / tabla.porPagina));
  tabla.pagina = Math.min(Math.max(1, tabla.pagina), paginas);
  const pagina = filas.slice((tabla.pagina - 1) * tabla.porPagina, tabla.pagina * tabla.porPagina);

  if (!filas.length) {
    cont.innerHTML = `<div class="vacio"><strong>${escapar(lista.length ? 'Ninguna toma coincide con la búsqueda' : filtros.estado === 'anuladas' ? 'No hay tomas anuladas con estos filtros' : 'No hay tomas físicas con estos filtros')}</strong>${
      lista.length ? '' : 'Registra una con el botón "Nueva toma física".'
    }</div>`;
    raiz.querySelector('#tf-paginas').innerHTML = '';
    return;
  }
  const th = (c) => {
    const clases = [c.der ? 'der' : '', c.clase ?? ''].filter(Boolean).join(' ');
    if (!c.ordena) return `<th scope="col" class="${clases}">${escapar(c.titulo)}</th>`;
    const sort = tabla.orden === c.clave ? (tabla.direccion === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" class="${clases}" aria-sort="${sort}"><button type="button" class="ordenar" data-orden="${c.clave}">${escapar(c.titulo)}</button></th>`;
  };
  const td = (c, m) => `<td class="${[c.der ? 'der' : '', c.clase ?? ''].filter(Boolean).join(' ')}">${c.valor(m)}</td>`;
  cont.innerHTML = `<div class="tabla-contenedor"><table class="tabla"><thead><tr>${COLUMNAS.map(th).join('')}</tr></thead>
    <tbody>${pagina.map((m) => `<tr>${COLUMNAS.map((c) => td(c, m)).join('')}</tr>`).join('')}</tbody></table></div>`;

  cont.querySelectorAll('[data-orden]').forEach((b) =>
    b.addEventListener('click', () => {
      const clave = b.dataset.orden;
      // La primera vez que se ordena por una columna: fecha y números de mayor a menor, textos de A a Z
      if (tabla.orden === clave) tabla.direccion = tabla.direccion === 'asc' ? 'desc' : 'asc';
      else tabla.direccion = ['producto', 'usuario'].includes(clave) ? 'asc' : 'desc';
      tabla.orden = clave;
      pintarTabla();
      raiz.querySelector(`[data-orden="${clave}"]`)?.focus();
    }),
  );
  cont.querySelectorAll('[data-accion]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = lista.find((x) => String(x.toma_id) === b.dataset.toma);
      if (!m) return;
      if (b.dataset.accion === 'editar') abrirFormulario(m);
      else if (b.dataset.accion === 'historial') abrirBitacora(m);
      else abrirConfirmacion(m, b.dataset.accion);
    }),
  );

  const desde = (tabla.pagina - 1) * tabla.porPagina + 1;
  const hasta = Math.min(tabla.pagina * tabla.porPagina, filas.length);
  const pie = raiz.querySelector('#tf-paginas');
  pie.innerHTML = `<span>Mostrando ${fmt.entero(desde)} a ${fmt.entero(hasta)} de ${fmt.entero(filas.length)}${filas.length < lista.length ? ` (de ${fmt.entero(lista.length)})` : ''}</span>
    <div><button type="button" class="boton boton-chico" data-pagina="-1" ${tabla.pagina <= 1 ? 'disabled' : ''}>Anterior</button>
    <span class="paginacion-pagina" style="align-self:center">Página ${fmt.entero(tabla.pagina)} de ${fmt.entero(paginas)}</span>
    <button type="button" class="boton boton-chico" data-pagina="1" ${tabla.pagina >= paginas ? 'disabled' : ''}>Siguiente</button></div>`;
  pie.querySelectorAll('[data-pagina]').forEach((b) =>
    b.addEventListener('click', () => {
      tabla.pagina += Number(b.dataset.pagina);
      pintarTabla();
    }),
  );
}

function estadoToma(m) {
  if (m.anulada) return insignia('aviso', `Anulada${m.anulada_por ? ` por ${m.anulada_por}` : ''}`);
  if (m.modificada_en) return `<span class="apagado" title="${escapar(`Editada por ${m.modificada_por ?? 'sin nombre'} el ${momento(m.modificada_en)}`)}">Editada ${escapar(momento(m.modificada_en, true))}</span>`;
  return '<span class="apagado">Vigente</span>';
}

function acciones(m) {
  const nombre = `${m.producto} del ${fechaHora(m.fecha_hora)}`;
  const b = (accion, texto) =>
    `<button type="button" class="boton boton-chico" data-accion="${accion}" data-toma="${escapar(m.toma_id)}" aria-label="${escapar(`${texto}: toma de ${nombre}`)}">${texto}</button>`;
  return `<span class="nowrap" style="display:inline-flex;gap:6px">${m.anulada ? b('restaurar', 'Restaurar') : `${b('editar', 'Editar')}${b('anular', 'Anular')}`}${b('historial', 'Bitácora')}</span>`;
}

// ---------------------------------------------------------------------------------------------
// Crear y editar

function abrirFormulario(e) {
  const combustibles = ordenarProductos(opciones.productos);
  const titulo = e ? `Editar toma de ${e.producto} · ${fechaHora(e.fecha_hora)}` : 'Nueva toma física';
  const ayuda = e
    ? 'Corrige la fecha, la hora, los galones o las observaciones. El cambio queda en la bitácora con el valor anterior. Para cambiar el producto o la estación, anula esta toma y registra una nueva.'
    : 'Lo que marcan los tanques a una hora. Escribe la fecha y la hora en que se midió (no la de ahora) y solo los productos que mediste; cada uno queda como una medición.';
  const cuerpo = `
    <form id="tf-form" novalidate>
      <p class="nota" style="margin-bottom:12px">${escapar(ayuda)}</p>
      <div class="carga-opciones">
        <label class="campo">Estación<select name="estacion" ${e ? 'disabled' : ''}>${opciones.estaciones
          .map((x) => `<option value="${escapar(x.codigo)}">${escapar(`${x.codigo} · ${x.nombre}`)}</option>`)
          .join('')}</select></label>
      </div>
      <div class="carga-opciones">
        <label class="campo">Fecha de la medición<input type="date" name="fecha" max="${escapar(hoy())}" required /></label>
        <label class="campo">Hora de la medición<input type="time" name="hora" required /></label>
      </div>
      <p class="nota" style="margin-top:6px">Al cierre del día va con la hora del cierre (por ejemplo 23:59): las ventas del día cuentan antes. Al abrir, con la hora de apertura: las ventas del día cuentan después.</p>
      <div class="carga-opciones">
        ${(e ? [e.producto] : combustibles)
          .map(
            (p) =>
              `<label class="campo">${conPunto(p, varProducto(p))} (galones)<input type="number" name="gal" data-producto="${escapar(p)}" min="0" step="0.001" inputmode="decimal" placeholder="Ejemplo: 2331.5" /></label>`,
          )
          .join('')}
      </div>
      <div class="carga-opciones">
        <label class="campo">Observaciones (opcional)<input type="text" name="observaciones" maxlength="300" placeholder="Ejemplo: varilla al cierre, después del último despacho" /></label>
        <label class="campo">Tu nombre<input type="text" name="usuario" maxlength="60" autocomplete="name" /></label>
      </div>
      <div data-mensaje role="status"></div>
    </form>`;
  const pie = `<button type="button" class="boton" data-cerrar>Cancelar</button>
    <button type="submit" form="tf-form" class="boton boton-principal">${e ? 'Guardar cambios' : 'Guardar toma física'}</button>`;
  abrirModal({ titulo, cuerpo, pie });
  const form = modal.querySelector('#tf-form');
  form.elements.estacion.value = filtros.estacion;
  form.elements.usuario.value = preferencia.leer('usuario', '');
  if (e) {
    form.elements.fecha.value = e.fecha;
    form.elements.hora.value = e.hora;
    form.querySelector('input[name="gal"]').value = String(e.galones);
    form.elements.observaciones.value = e.observaciones ?? '';
  }
  form.elements.fecha.focus();
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guardar(form, e);
  });
}

async function guardar(form, editada) {
  if (modal.dataset.ocupado) return;
  const fechaToma = form.elements.fecha.value;
  const horaToma = form.elements.hora.value;
  if (!fechaToma || !horaToma) {
    (fechaToma ? form.elements.hora : form.elements.fecha).focus();
    return mensajeModal('aviso', 'Escribe la fecha y la hora en que se midieron los tanques.');
  }
  if (fechaToma > hoy()) return mensajeModal('aviso', 'La toma no puede ser de una fecha futura.');
  const lecturas = [];
  for (const input of form.querySelectorAll('input[name="gal"]')) {
    const texto = input.value.trim();
    if (texto === '') continue;
    const galones = Number(texto);
    if (!Number.isFinite(galones) || galones < 0) {
      input.focus();
      return mensajeModal('aviso', `Los galones de ${input.dataset.producto} tienen que ser un número de 0 en adelante.`);
    }
    lecturas.push({ producto: input.dataset.producto, galones });
  }
  if (!lecturas.length) {
    form.querySelector('input[name="gal"]').focus();
    return mensajeModal('aviso', editada ? 'Escribe los galones medidos.' : 'Escribe los galones de al menos un producto.');
  }
  const quien = form.elements.usuario.value.trim();
  preferencia.guardar('usuario', quien);
  const observaciones = form.elements.observaciones.value.trim() || undefined;
  mensajeModal('info', 'Guardando…');
  ocupar(true);
  try {
    let texto;
    if (editada) {
      await pedir(`/api/tomas/${encodeURIComponent(editada.toma_id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fecha: fechaToma, hora: horaToma, galones: lecturas[0].galones, observaciones, usuario: quien || undefined }),
      });
      texto = `Se guardaron los cambios de la toma de ${editada.producto} (ahora ${fecha(fechaToma, true)} a las ${horaToma}).`;
    } else {
      const r = await pedir('/api/tomas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estacion: form.elements.estacion.value, fecha: fechaToma, hora: horaToma, usuario: quien || undefined, observaciones, lecturas }),
      });
      texto = `Se ${r.guardadas === 1 ? 'guardó 1 medición' : `guardaron ${r.guardadas} mediciones`} del ${fecha(fechaToma, true)} a las ${horaToma}.`;
    }
    ocupar(false);
    modal.close();
    avisar('bueno', texto);
    await consultarLista().catch(pintarErrorLista);
  } catch (err) {
    ocupar(false);
    mensajeModal('critico', err.message);
    if (err.tipo === 'conexion') revisarConexion();
  }
}

// ---------------------------------------------------------------------------------------------
// Anular y restaurar

function abrirConfirmacion(m, accion) {
  const anular = accion === 'anular';
  const cuerpo = `
    <dl class="datos" style="margin-bottom:12px">
      <div class="dato"><dt>Producto</dt><dd>${conPunto(m.producto, varProducto(m.producto))}</dd></div>
      <div class="dato"><dt>Fecha y hora</dt><dd>${escapar(fechaHora(m.fecha_hora))}</dd></div>
      <div class="dato"><dt>Medido</dt><dd>${escapar(fmt.galones(m.galones))}</dd></div>
    </dl>
    <p>${escapar(
      anular
        ? 'No se borra: queda como anulada, con tu nombre, y deja de contar en el inventario. Se puede restaurar cuando quieras.'
        : 'Vuelve a contar en el inventario. Si ya hay otra toma vigente del mismo producto a esa hora, primero hay que anular esa.',
    )}</p>
    <label class="campo" style="margin-top:12px">Tu nombre<input type="text" name="usuario" maxlength="60" autocomplete="name" /></label>
    <div data-mensaje role="status"></div>`;
  const pie = `<button type="button" class="boton" data-cerrar>Cancelar</button>
    <button type="button" class="boton ${anular ? 'boton-peligro' : 'boton-principal'}" data-confirmar>${anular ? 'Anular toma' : 'Restaurar toma'}</button>`;
  abrirModal({ titulo: anular ? '¿Anular esta toma física?' : '¿Restaurar esta toma física?', cuerpo, pie });
  const nombre = modal.querySelector('input[name="usuario"]');
  nombre.value = preferencia.leer('usuario', '');
  modal.querySelector('[data-confirmar]').focus();
  modal.querySelector('[data-confirmar]').addEventListener('click', async () => {
    const quien = nombre.value.trim();
    preferencia.guardar('usuario', quien);
    ocupar(true);
    try {
      await pedir(`/api/tomas/${encodeURIComponent(m.toma_id)}/${accion}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: quien || undefined }),
      });
      ocupar(false);
      modal.close();
      avisar('bueno', `${anular ? 'Se anuló' : 'Se restauró'} la toma de ${m.producto} del ${fechaHora(m.fecha_hora)}.`);
      await consultarLista().catch(pintarErrorLista);
    } catch (err) {
      ocupar(false);
      mensajeModal('critico', err.message);
      if (err.tipo === 'conexion') revisarConexion();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Bitácora

const ACCIONES = { CREADA: ['bueno', 'Creada'], MODIFICADA: ['info', 'Editada'], ANULADA: ['aviso', 'Anulada'], RESTAURADA: ['bueno', 'Restaurada'] };
const CAMPOS = { fecha_hora: 'Fecha y hora', galones: 'Galones', observaciones: 'Observaciones', producto: 'Producto', estacion: 'Estación' };

async function abrirBitacora(m) {
  abrirModal({
    titulo: `Bitácora · ${m.producto} del ${fechaHora(m.fecha_hora)}`,
    cuerpo: `<div class="cargando" style="padding:0"><span class="girador"></span>Leyendo la bitácora…</div>`,
    pie: '<button type="button" class="boton" data-cerrar>Cerrar</button>',
    ancho: true,
  });
  const cuerpo = modal.querySelector('.modal-cuerpo');
  const esta = aperturaActual();
  // Si mientras se leía se cerró el modal o se abrió otro, no se pinta
  const vigente = () => modal.open && esta === aperturaActual();
  let filas;
  try {
    filas = await pedir(`/api/tomas/${encodeURIComponent(m.toma_id)}/historial`);
  } catch (err) {
    if (vigente()) cuerpo.innerHTML = `<p>${estadoLargo('critico', err.message)}</p>`;
    return;
  }
  if (!vigente()) return;
  cuerpo.innerHTML = `<p class="nota" style="margin-bottom:10px">Cada alta, cambio, anulación y restauración, con el valor anterior y el nuevo.</p>${tablaHtml(
    [
      { titulo: 'Cuándo', valor: (h) => `<span class="nowrap">${escapar(momento(h.en))}</span>`, html: true },
      { titulo: 'Qué pasó', valor: (h) => estado(...(ACCIONES[h.accion] ?? ['info', h.accion])), html: true },
      { titulo: 'Campo', valor: (h) => CAMPOS[h.campo] ?? h.campo ?? '' },
      { titulo: 'Antes', valor: (h) => h.valor_anterior ?? '' },
      { titulo: 'Después', valor: (h) => h.valor_nuevo ?? '' },
      { titulo: 'Quién', valor: (h) => h.usuario ?? 'sin nombre' },
    ],
    filas,
    { vacio: 'Sin movimientos en la bitácora' },
  )}`;
}
