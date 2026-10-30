# A16: reducir el radio de daño de los secrets de `toolsnap-mcp`

Fecha: 2026-10-30. Plan de seguridad, acción A16. Decisiones de Unai del 30-10:
tope del relayer 50 $ (lo mueve él), token de Polar con scopes mínimos y
caducidad a 12 meses, rotación de todo cada 6 meses.

Problema: quien despliega o lee el Worker `toolsnap-mcp` tiene todos sus
secrets a la vez, y valen cosas muy distintas (una wallet, la cuenta personal
de X de Unai, cobros, cuotas de terceros). Esta acción hace tres cosas:

1. Saca los tokens de la cuenta personal de X (@icosaedro_one) a un Worker
   propio, `toolsnap-x-personal`, al que `toolsnap-mcp` solo llega por un
   service binding con tres verbos.
2. Vigila el saldo del relayer contra el mínimo de 5 $ y el tope de 50 $.
3. Quita `POLAR_ACCESS_TOKEN` de este Worker (no lo usa desde F21.2) y deja el
   procedimiento para rotar el del portal con scopes mínimos.

## 1. Inventario de secrets

Rutas de entrada: `POST /mcp` y `/mcp/oauth` (MCP), `/x402/tools/*` y
`/v1/tools/*` (HTTP), y el cron (`scheduled`). "Atacante" = quien obtiene el
valor del secret (leyendo el Worker, un `.dev.vars`, un log).

| Secret | Código que lo usa | Rutas | Qué haría un atacante con él | Tipo de daño |
|---|---|---|---|---|
| `RELAYER_PRIVATE_KEY` | `src/x402/middleware.ts` (`settlePayment`) | `account_deposit` por `/mcp`; pago por llamada cuando CDP no liquida | Vaciar la wallet (ETH de gas y el USDC que tenga) y firmar cualquier transacción como ella | Dinero, acotado al tope de 50 $ |
| `X402_PAY_TO_ADDRESS` | `middleware.ts`, `mcp/server.ts`, `x402/http-door.ts`, `x402/discovery.ts`, `x402/cdp.ts` | Todos los 402 | Nada al leerlo: es una dirección pública que sale en cada 402. El riesgo es quien pueda **cambiarla** (desplegar), que desviaría los cobros | Dinero (solo con permiso de deploy) |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | `src/x402/cdp.ts` | Pago por llamada (liquidación CDP y Bazaar) | Usar la cuenta de Coinbase Developer Platform como nosotros; el alcance depende de los permisos de la clave en el portal de CDP (pregunta abierta 4) | Cuota de terceros, posible dinero |
| `POLAR_ACCESS_TOKEN` | **Ninguno desde A16.** Antes `src/fiat/polar.ts` (`createCheckoutSession`, `getCheckout`), sin llamadas desde F21.2 | — | Hoy: lo que permitan sus scopes (si es amplio, leer clientes y pedidos, crear productos o descuentos). Por eso se borra de aquí y se rota en el portal | Cobros, datos de clientes |
| `POLAR_WEBHOOK_SECRET` | `src/index.ts` → `verifyPolarSignature` | `POST /webhooks/polar` | Forjar `order.paid` y acreditarse saldo: uso gratis de tools de pago, que nos cuestan (fal, DataForSEO…) | Dinero indirecto |
| `POLAR_WEBHOOK_SECRET_SANDBOX_TEST` | `src/index.ts` | `POST /webhooks/polar-sandbox-test` (temporal del 09-07, no acredita) | Casi nada; ruta de diagnóstico olvidada (seguimiento 2) | Ninguno |
| `ADMIN_API_KEY` | `src/index.ts` | `/mcp` (tools de pago gratis), `/admin/keys/issue|revoke`, `/x-api/*`, `/x-api/telegram/*` | Tools de pago gratis, emitir y revocar API keys, leer y cargar la cola de X de **las dos cuentas** | Dinero indirecto, publicar en X |
| `ANALYTICS_READ_TOKEN` | `src/index.ts` | `GET /reports/analytics`, `GET /reports/relayer-balance` | Leer analítica (wallets, superficies) y el saldo del relayer | Datos, bajo |
| `ANALYTICS_HASH_SALT` | `src/mcp/server.ts`, `src/rest-tools.ts` | `/mcp`, `/v1/tools/*` | Revertir por fuerza bruta los seudónimos de IP | Privacidad, bajo |
| `TOOLSNAP_INTERNAL_TOKEN` | `src/index.ts`, `src/rest-tools.ts` | `/mcp`, `/v1/tools/*` | Marcar su tráfico como interno y ensuciar la analítica | Bajo |
| `REST_API_TOKEN` | `src/rest-tools.ts` | `POST /v1/tools/*` | Usar la puerta REST de tools gratis | Cuota, bajo |
| `SCREENSHOT_API_KEY` | `src/tools/screenshot-url.ts` | tool `screenshot_url` | Gastar la cuota de ScreenshotOne | Cuota de terceros |
| `CF_ACCOUNT_ID` + `BROWSER_RENDERING_API_TOKEN` | `src/tools/fetch-rendered.ts` | tool `fetch_rendered` | Gastar Browser Rendering de la cuenta. Es token de **usuario sin caducidad**: rotar con caducidad (pendiente de A2) | Cuota de Cloudflare |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | `src/tools/keyword-research.ts` | tool `keyword_research` | Gastar el saldo prepago de DataForSEO | Dinero |
| `FAL_API_KEY` | `src/fal/*`, `src/tools/{image-*,audio-*,text-to-speech,video-generate,remove-background}.ts` | tools de media | Gastar el saldo de fal.ai sin pasar por nuestro freno diario (`FAL_DAILY_BUDGET_USD` solo frena nuestro código) | Dinero |
| `XAI_API_KEY` | `src/x-agent/xai.ts` | cron (reply-guy) | Gastar el crédito de xAI (límite de 20 $/mes en la consola, según `wrangler.jsonc`) | Dinero, acotado |
| `SMITHERY_API_KEY` / `GLAMA_API_KEY` | `src/analytics/directory-stats.ts` | cron diario | Lo que permitan esas claves en sus paneles (pregunta abierta 5: si dejan editar las fichas) | Reputación |
| `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_CHAT_ID`) | `src/alerts/telegram.ts` | alertas | Escribir a Unai como el bot de alertas (phishing por un canal de confianza) o leer sus updates | Cuenta, medio |
| `X_TG_BOT_TOKEN` | `src/x-agent/telegram.ts` | cron, `/x-api/telegram/*` | Escribir como el bot del X Agent: tarjetas de aprobación falsas | Cuenta, medio |
| `X_TG_WEBHOOK_SECRET` | `src/index.ts` | `POST /webhooks/telegram` | Con el chat id, forjar pulsaciones de "aprobar": publica lo que haya en cola, **también en @icosaedro_one** (el binding no lo impide, ver §2) | Publicar en X |
| `VAPID_PRIVATE_KEY` (+ `VAPID_PUBLIC_KEY`) | `src/x-agent/push.ts` | `/x-api/push/*` | Mandar notificaciones push a los navegadores suscritos al panel (necesita además las suscripciones de D1) | Bajo |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | `src/cms-auth.ts` | `/admin/auth`, `/admin/callback` | Hacerse pasar por la OAuth App del CMS para pedir a Unai un token de GitHub | Cuenta (GitHub), medio |
| `X_API_KEY` / `X_API_SECRET` | `src/x-agent/client.ts` (y ahora también `toolsnap-x-personal`) | cron, aprobaciones | Solo, nada que publicar: hace falta además un token de usuario. Sí permite montar un flujo de autorización "como la app" | Bajo solo |
| `X_ACCESS_TOKEN_PRODUCT` / `_SECRET_PRODUCT`, `X_USER_ID_PRODUCT` | `src/x-agent/client.ts` | cron, aprobaciones, panel | Actuar como @ToolSnapMCP con los permisos de la app (publicar, borrar, seguir; DMs si la app los tiene) | Cuenta de producto |
| ~~`X_ACCESS_TOKEN_PERSONAL` / `_SECRET_PERSONAL`, `X_USER_ID_PERSONAL`~~ | **Salen a `toolsnap-x-personal`** | — | Antes: actuar como @icosaedro_one con todo lo que permita la app | Cuenta personal de Unai |

Bindings sin secret pero con el mismo alcance para quien despliegue: `PREPAID_DB`
(saldos y libro de dinero), `X402_NONCES`, `SCREENSHOTS_BUCKET`.

### Scopes de Polar que usa el código

`toolsnap-mcp` **no llama a la API de Polar**: solo verifica la firma del
webhook con `POLAR_WEBHOOK_SECRET`, que no es un token de API. Las dos llamadas
que había (`POST /v1/checkouts/` y `GET /v1/checkouts/{id}`) se fueron a
`toolsnap-portal` en F21.2 y aquí eran código muerto; A16 las borra junto con
`POLAR_ACCESS_TOKEN`.

El portal (`toolsnap-portal/src/vendor/polar.ts`) llama exactamente a:

| Llamada | Para qué | Scope |
|---|---|---|
| `POST /v1/checkouts/` | Crear la sesión de pago (producto PWYW y tramos) | `checkouts:write` |
| `GET /v1/checkouts/{id}` | Estado del checkout en `/welcome` | `checkouts:read` (la documentación también la acepta con `checkouts:write`) |

Token nuevo: **`checkouts:read` + `checkouts:write`, nada más**, solo en el
portal.

## 2. Tokens personales de X en un Worker propio

```
toolsnap-mcp ── service binding X_PERSONAL (entrypoint XPersonal, RPC) ──▶ toolsnap-x-personal
   (tokens de @ToolSnapMCP)                                                  (tokens de @icosaedro_one)
```

- Reparto en el código, sin ambigüedad: `src/x-agent/client.ts` elegía el
  token por `account` (`"product"` = @ToolSnapMCP, `"personal"` =
  @icosaedro_one). Las métricas (`fetchTweetMetrics`) solo usan el de producto.
  `X_API_KEY`/`X_API_SECRET` son la app compartida: hacen falta en los dos
  Workers porque OAuth1.0a firma con ellas, y por sí solas no publican nada.
- `toolsnap-x-personal` (`workers/x-personal/`) guarda `X_API_KEY`,
  `X_API_SECRET`, `X_ACCESS_TOKEN_PERSONAL`, `X_ACCESS_TOKEN_SECRET_PERSONAL` y
  `X_USER_ID_PERSONAL`, y expone por RPC solo `publish`, `uploadMedia` y
  `repost`, con la entrada validada (ids numéricos, máximo 4 medias, imágenes
  de los tipos del panel y hasta 5 MB).
- Autenticación = el binding. El entrypoint con nombre `XPersonal` solo lo
  pueden invocar Workers con un service binding a él; el Worker no tiene ruta,
  ni `workers.dev`, ni preview URLs, y su `fetch` contesta 404 a todo. No hay
  token compartido que robar.
- `toolsnap-mcp` deja de tener esos tres secrets: ni `src/` ni el `Env` los
  nombran, y aunque siguieran puestos en Cloudflare el cliente no los lee (lo
  comprueba `test/x-personal-boundary.ts`). `X_DRY_RUN=1` sigue funcionando en
  local sin binding.
- Lo que **no** cambia: quien controle `toolsnap-mcp` (desplegarlo, la
  `ADMIN_API_KEY`, el secret del webhook de Telegram, el panel) puede seguir
  **publicando** en @icosaedro_one a través del binding, que es justo lo que
  hace el X Agent. Lo que ya no puede es llevarse el token, ni usarlo para
  otra cosa (DMs, seguir, borrar, perfil), ni seguir usándolo cuando se le
  quite el acceso. Pregunta abierta 2 por si se quiere un tope diario dentro
  de `toolsnap-x-personal`.

Tests: `test/x-personal-boundary.ts`.

## 3. Relayer: saldo mínimo y tope

- Tope **50 $** (ETH + USDC de la wallet): es lo máximo que pierde quien lea
  `RELAYER_PRIVATE_KEY`. Mínimo **5 $** de ETH: por debajo, los depósitos x402
  y la liquidación sin CDP pueden fallar por gas. **El saldo lo gestiona
  Unai**; Claude no mueve fondos ni toca la clave.
- `src/alerts/relayer-balance.ts` lee por el RPC público (`BASE_RPC_URL`) el
  ETH y el USDC de `RELAYER_ADDRESS` (variable pública en `wrangler.jsonc`, no
  se deriva de la clave) y el precio ETH/USD del feed de Chainlink en Base
  (`0x7104…Bb70`, comprobado: "ETH / USD", 8 decimales). Un precio con más
  de 2 h (el heartbeat es de unos 20 min) cuenta como lectura fallida. Fuera
  de rango avisa por el bot de alertas (`TELEGRAM_BOT_TOKEN`), una vez al día
  por estado; la marca se pone solo si Telegram aceptó el mensaje, así que un
  envío fallido no compra 24 h de silencio.
- Cómo se invoca, sin cron (la otra sesión está tocando `scheduled`):
  - después de cada transacción que paga el relayer (depósito, o pago por
    llamada sin CDP), en `ctx.waitUntil`, como mucho una vez por hora y sin
    poder romper el pago;
  - `GET /reports/relayer-balance` con `Authorization: Bearer
    <ANALYTICS_READ_TOKEN>`, que devuelve el JSON y avisa si toca. Las
    lecturas se reutilizan 60 s para no castigar el RPC público que también
    usa la liquidación x402.
- Si se quiere también una lectura diaria aunque no haya pagos, basta añadir
  `ctx.waitUntil(maybeCheckRelayerBalance(env))` en la rama diaria de
  `scheduled()`; lo dejo para la sesión que lleva el cron.
- Estado el 30-10: 0,00114 ETH (2,55 $) + 0,48 USDC. **Está por debajo del
  mínimo**: el primer chequeo en producción avisará.

Tests: `test/relayer-balance.ts`.

## 4. Rotación del token de Polar (la hace Unai)

El token vive solo en `toolsnap-portal` a partir de ahora.

1. En Polar (organización de ToolSnap, Settings → Developers, "Organization Access Tokens" → New token):
   nombre `toolsnap-portal checkouts AAAA-MM`, **caducidad 12 meses**, scopes
   **`checkouts:read` y `checkouts:write`** y ninguno más.
2. Subirlo al Worker del portal desde el repo `toolsnap-portal`:
   `npx wrangler secret put POLAR_ACCESS_TOKEN` (pega el valor en el prompt,
   nunca en el chat ni en un fichero).
3. Comprobar una llamada real: abrir `https://portal.toolsnap.app`, empezar una
   recarga del tramo de 5 $ hasta que cargue la página de pago de Polar (no
   hace falta pagar) y volver. Si la página de Polar carga, el `POST
   /v1/checkouts/` funciona con el token nuevo.
4. Revocar el token viejo en Polar (misma pantalla).
5. Borrar la copia que sobra en este Worker:
   `npx wrangler secret delete POLAR_ACCESS_TOKEN` desde `toolsnap-mcp`
   (después de desplegar este cambio).
6. Apuntar la caducidad. La tabla de caducidades del 27-10 **no está en el
   vault** (`~/coding_area/unai-brain`): está en
   `~/coding_area/reestructuracion/01-PLAN-TRASLADO.md`, en el Registro del
   27-10 (noche). Añadir una fila con el mismo formato:

   `| toolsnap-portal checkouts AAAA-MM | Polar (org ToolSnap) | **Creado** | A16: solo checkouts:read y checkouts:write; vive en el Worker toolsnap-portal; el viejo revocado | DD-MM, caduca DD-MM-AAAA |`

   y un aviso en el calendario un mes antes de la fecha.

## 5. Deploy del Worker nuevo

Job `deploy-x-personal` en `.github/workflows/deploy.yml`, entre `build` y
`deploy` (este pasa a `needs: [build, deploy-x-personal]`): el binding de
`toolsnap-mcp` apunta a él, así que va primero. Instala con
`--ignore-scripts` como el principal (A12) y despliega con
`npx wrangler deploy --config workers/x-personal/wrangler.jsonc`. Sin smoke
test HTTP a propósito (contesta 404 a todo): la prueba es el smoke test del
deploy principal, que arranca `toolsnap-mcp` con el binding.

Token propio: token de cuenta ToolSnap, Editor solo sobre el Worker
`toolsnap-x-personal`, sin permisos de zona (no tiene ruta, ni dominio, ni
`workers.dev`), caducidad 6 meses, como `CLOUDFLARE_API_TOKEN_X_PERSONAL` en
el environment `production`. Cada job lee solo su token.

Convive con el paso de registro de A14, que ahora también está en este job: la
vigilancia mira `toolsnap-x-personal` (está en `VIGIA_WORKERS`) y el job
registra su deployment con `scripts/registrar-deploy.sh toolsnap-x-personal`
(`continue-on-error`). Para que el registro funcione, el token de este job
(Editor de un solo Worker) necesita además `Workers KV Storage: Edit`; hasta
que lo tenga, ese paso falla sin cortar el deploy y cada deploy del Worker
avisa por Telegram.

**Tope diario (2026-10-30, decisión de Unai).** `publish` y `repost` suman
a un contador por día UTC antes de llamar a X y se niegan a partir de 15
(`uploadMedia` no cuenta). Vive en un Durable Object con SQLite
(`PublicationLimiter`, `workers/x-personal/src/limiter.ts`, una sola instancia
de nombre fijo `global`, migración `v1` en `wrangler.jsonc`): el Worker no
tiene otro almacenamiento, el DO se despliega con el mismo token (Editor del
Worker) y es atómico sin más; KV habría pedido otro permiso en el token, no es
atómico (leer y escribir son dos operaciones) y su cuota de puts diarios ya es
un cuello de botella.

- **El DO no es exclusivo de este Worker.** Wrangler admite
  `durable_objects.bindings[].script_name`, así que cualquier Worker de la
  cuenta con permiso de deploy (también un `toolsnap-mcp` redesplegado por un
  adversario) puede enlazar `PublicationLimiter` y llamar a sus dos métodos. El
  diseño no cuenta con lo contrario: `reservar` desde fuera solo gasta cupo
  (no publica nada; como mucho agota el tope del día, que ya es el límite de
  daño) y `liberar` exige el `nonce` de una reserva concreta y de un solo uso,
  así que un tercero solo puede devolver lo que él mismo reservó y nunca bajar
  el contador de las reservas de otros. El DO no tiene `fetch` (no hay URL).
- Si X rechaza con un **4xx** (no se publicó nada) la reserva se devuelve por
  su nonce. Un fallo de red y un **5xx** no se devuelven: un 502/504 puede
  llegar con el tweet ya creado. Sin el binding falla cerrado (reintentable).
- Al pasar el tope devuelve `limite-diario` (429, `retryable: false`) y
  `src/x-agent/client.ts` lo convierte en un `XApiError` con `code:
  "limite-diario"` no reintentable. **Efecto en la cola**
  (`src/x-agent/publish-one.ts`): la fila no se marca `failed` (eso bloquearía
  a los hijos de un hilo) sino que vuelve a `scheduled` con `scheduled_at` a
  las 00:00 UTC del día siguiente, sin gastar intento y con aviso por Telegram;
  los hijos esperan a que su padre se publique, así que un hilo cortado por el
  tope sigue solo al día siguiente. Excepción: las respuestas (`kind='reply'`)
  no se posponen (solo valen si salen enseguida) y fallan como cualquier
  rechazo, para contestarlas a mano.

## 6. Orden de puesta en marcha

El binding apunta a un Worker que todavía no existe, así que **esta PR no se
puede fusionar** hasta los pasos 1 a 3 (fusionar despliega `toolsnap-mcp`).

1. Crear `toolsnap-x-personal` con un deploy real desde el Mac, **antes** de
   subir ningún secret: `npx wrangler deploy --config
   workers/x-personal/wrangler.jsonc` desde la raíz del repo (con esta rama).
   Así nace con su código (404 a todo) y con `workers_dev` y `preview_urls`
   apagados. Crearlo con `wrangler secret put` subiría un script de relleno
   de wrangler, sin esa configuración, con los tokens ya dentro.
2. Subir sus secrets:
   `npx wrangler secret put <NOMBRE> --config workers/x-personal/wrangler.jsonc`
   para `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN_PERSONAL`,
   `X_ACCESS_TOKEN_SECRET_PERSONAL`, `X_USER_ID_PERSONAL`. Cloudflare no deja
   leer los valores viejos: si no los tienes guardados, aprovecha para
   **rotar** el token personal (en @icosaedro_one, Ajustes → Seguridad →
   Apps conectadas → revocar la app; luego `X_API_KEY=… X_API_SECRET=… npx
   tsx scripts/x-authorize.mts` con esa cuenta, que ya imprime los comandos
   con el `--config` correcto). Así la copia que queda en `toolsnap-mcp` deja
   de valer en el acto.
3. Crear el token de deploy de §5 (el Worker ya existe, así que se puede
   elegir en el selector) y guardarlo con
   `gh secret set CLOUDFLARE_API_TOKEN_X_PERSONAL --env production -R ToolSnap-app/toolsnap-mcp`.
4. Fusionar esta PR: despliega primero `toolsnap-x-personal` y luego
   `toolsnap-mcp` con el binding.
5. Comprobar la primera publicación de @icosaedro_one (programada o una
   respuesta aprobada) con `npx wrangler tail toolsnap-x-personal` abierto.
6. Borrar de `toolsnap-mcp`: `npx wrangler secret delete` de
   `X_ACCESS_TOKEN_PERSONAL`, `X_ACCESS_TOKEN_SECRET_PERSONAL`,
   `X_USER_ID_PERSONAL` y `POLAR_ACCESS_TOKEN`.
7. Rotación de Polar (§4) y recarga del relayer al rango 5-50 $ (§3).

## 7. Seguimientos (no hechos en A16)

- **M3. Dedupe y throttle por colo/isolate, no globales.** La marca de "ya
  avisé hoy" vive en memoria y en la Cache API, las dos locales; el límite de
  una comprobación por hora tras un pago y la memo de 60 s de la ruta son por
  isolate. Con tráfico repartido entre colos puede llegar alguna página más
  al día. Si molesta, una marca global (D1 o KV, con su cuota) lo cierra.
- **M6. `RELAYER_ADDRESS` es una copia manual.** Si cambia la clave y no la
  variable, se vigila la wallet equivocada en silencio. Un `console.warn` en
  `settlePayment` cuando `account.address` (que ya calcula) difiera de
  `RELAYER_ADDRESS` evitaría la deriva sin exponer nada.
- **M8. Superficie RPC fijada en el test.** Hecho con el tope diario: el test
  fija `Object.getOwnPropertyNames(XPersonal.prototype)`.
- **M9. Token A3 y el binding.** Comprobar en el primer deploy (paso 4) que el
  token del deploy principal, Editor solo sobre `toolsnap-mcp`, puede declarar
  el binding a otro Worker. No debería necesitar más, pero si el deploy falla
  por el binding, el error lo dirá y la solución es dar a ese token lectura
  de `toolsnap-x-personal`.
