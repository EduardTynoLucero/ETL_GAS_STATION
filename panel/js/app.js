// Arranque del panel: pestañas, tema claro/oscuro y estado de la conexión a la base.
import { conexion, bus, preferencia, revisarConexion } from './estado.js';
import { redibujarTodas } from './graficas.js';
import { escapar, ICONOS } from './util.js';
import * as cargar from './cargar.js';
import * as dashboard from './dashboard.js';
import * as historial from './historial.js';
import * as inventario from './inventario.js';
import * as tomas from './tomas.js';

const VISTAS = { cargar, dashboard, inventario, tomas, historial };
const iniciadas = new Set();

function mostrarVista() {
  const nombre = location.hash.slice(1) in VISTAS ? location.hash.slice(1) : 'cargar';
  for (const v of Object.keys(VISTAS)) {
    const activa = v === nombre;
    document.getElementById(`vista-${v}`).hidden = !activa;
    document.getElementById(`tab-${v}`).setAttribute('aria-selected', String(activa));
  }
  const vista = VISTAS[nombre];
  const contenedor = document.getElementById(`vista-${nombre}`);
  if (!iniciadas.has(nombre)) {
    iniciadas.add(nombre);
    vista.iniciar(contenedor);
  }
  vista.mostrar?.();
}

// ---------------------------------------------------------------------------------------------
// Tema: automático (el de Windows), claro u oscuro

const TEMAS = ['auto', 'light', 'dark'];
const NOMBRE_TEMA = { auto: 'Tema automático', light: 'Tema claro', dark: 'Tema oscuro' };
const ICONO_TEMA = { auto: ICONOS.auto, light: ICONOS.sol, dark: ICONOS.luna };

function aplicarTema(tema) {
  if (tema === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = tema;
  const boton = document.getElementById('tema');
  boton.innerHTML = ICONO_TEMA[tema];
  boton.title = `${NOMBRE_TEMA[tema]} (clic para cambiar)`;
  boton.setAttribute('aria-label', boton.title);
  redibujarTodas();
}

function iniciarTema() {
  let tema = preferencia.leer('tema', 'auto');
  if (!TEMAS.includes(tema)) tema = 'auto';
  aplicarTema(tema);
  document.getElementById('tema').addEventListener('click', () => {
    tema = TEMAS[(TEMAS.indexOf(tema) + 1) % TEMAS.length];
    preferencia.guardar('tema', tema === 'auto' ? null : tema);
    aplicarTema(tema);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redibujarTodas);
}

// ---------------------------------------------------------------------------------------------
// Conexión: insignia arriba a la derecha y aviso cuando algo falla

function pintarConexion() {
  const boton = document.getElementById('conexion');
  const texto = boton.querySelector('.conexion-texto');
  const aviso = document.getElementById('aviso-conexion');
  const d = conexion.datos;
  if (conexion.revisando) {
    boton.dataset.estado = 'revisando';
    texto.textContent = 'Revisando conexión…';
    // Mientras revisa, el aviso se queda como estaba pero su Reintentar no se puede volver a presionar
    const reintentar = aviso.querySelector('#reintentar-conexion');
    if (reintentar) reintentar.disabled = true;
    return;
  }
  if (d?.conectado && d.bd?.esquemaInstalado) {
    boton.dataset.estado = 'ok';
    texto.textContent = `Conectado a ${d.bd.baseDeDatos} · ${d.config?.servidor ?? ''}`;
    boton.title = `PostgreSQL ${d.bd.servidor}, usuario ${d.bd.usuario}. ${d.bd.tickets?.toLocaleString('es-GT') ?? 0} tickets en el modelo.`;
    aviso.hidden = true;
    return;
  }
  const sinTablas = d?.conectado && !d.bd?.esquemaInstalado;
  boton.dataset.estado = sinTablas ? 'aviso' : 'error';
  texto.textContent = sinTablas ? 'Base sin tablas del ETL' : 'Sin conexión a la base';
  boton.title = d?.error ?? '';
  aviso.dataset.tipo = sinTablas ? 'aviso' : 'error';
  const titulo =
    d?.tipo === 'configuracion'
      ? 'Falta configurar el archivo .env'
      : d?.tipo === 'panel'
        ? 'El panel no responde'
        : sinTablas
          ? 'La base de datos no tiene las tablas del ETL'
          : 'No hay conexión con la base de datos';
  aviso.innerHTML = `
    <span class="estado estado-${sinTablas ? 'aviso' : 'critico'}">${sinTablas ? ICONOS.aviso : ICONOS.critico}</span>
    <div class="aviso-cuerpo">
      <strong>${escapar(titulo)}</strong>
      <p>${escapar(d?.error ?? '')}</p>
      <p class="nota">Puedes revisar archivos igual: la vista previa no necesita la base. Si cambias el .env, cierra el panel (Ctrl+C) y vuelve a abrirlo con npm run panel.</p>
    </div>
    <button type="button" class="boton boton-chico" id="reintentar-conexion">Reintentar</button>`;
  aviso.hidden = false;
  // Reintentar y la insignia solo revisan la conexión: cada pestaña decide al oír el aviso 'conexion'
  // ya terminado si vuelve a consultar (así sale un solo pedido por clic)
  aviso.querySelector('#reintentar-conexion').addEventListener('click', () => revisarConexion());
}

bus.addEventListener('conexion', pintarConexion);
document.getElementById('conexion').addEventListener('click', () => revisarConexion());

// ---------------------------------------------------------------------------------------------
// Alto del encabezado fijo en --alto-encabezado: con él, scroll-margin-top (estilos.css) deja lo que se
// lleva a la vista con scrollIntoView debajo del encabezado, aunque este ocupe dos renglones en el celular

function seguirAltoEncabezado() {
  const encabezado = document.querySelector('.encabezado');
  const poner = () => document.documentElement.style.setProperty('--alto-encabezado', `${Math.ceil(encabezado.getBoundingClientRect().height)}px`);
  poner();
  new ResizeObserver(poner).observe(encabezado);
}

seguirAltoEncabezado();
iniciarTema();
window.addEventListener('hashchange', mostrarVista);
mostrarVista();
revisarConexion();
