import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

function viteProxyHmrResiliencePlugin(): Plugin {
  return {
    name: 'vite-proxy-hmr-resilience',
    apply: 'serve',
    transform: {
      order: 'post',
      handler(code, id) {
        const cleanId = id.split('?')[0].replace(/\\/g, '/');
        if (!cleanId.endsWith('/vite/dist/client/client.mjs')) {
          return null;
        }

        let updated = code;

        const connectingPromiseTarget =
          'if (maybePromise) {\n\t\t\t\tconnectingPromise = maybePromise;\n\t\t\t\tawait connectingPromise;\n\t\t\t\tconnectingPromise = void 0;\n\t\t\t}';
        if (updated.includes(connectingPromiseTarget)) {
          updated = updated.replace(
            connectingPromiseTarget,
            'if (maybePromise) {\n\t\t\t\tconnectingPromise = maybePromise;\n\t\t\t\ttry {\n\t\t\t\t\tawait connectingPromise;\n\t\t\t\t} finally {\n\t\t\t\t\tconnectingPromise = void 0;\n\t\t\t\t}\n\t\t\t}'
          );
        }

        const portExprTarget = ':${hmrPort || importMetaUrl.port}';
        if (updated.includes(portExprTarget)) {
          updated = updated.replace(
            portExprTarget,
            '${hmrPort || importMetaUrl.port ? `:${hmrPort || importMetaUrl.port}` : ""}'
          );
        }

        const localFallbackTarget = '\t\t\t} catch (e) {\n\t\t\t\tif (!hmrPort) {';
        if (updated.includes(localFallbackTarget)) {
          updated = updated.replace(
            localFallbackTarget,
            '\t\t\t} catch (e) {\n' +
              '\t\t\t\tconst isLocalHost = importMetaUrl.hostname === "localhost" || importMetaUrl.hostname === "127.0.0.1";\n' +
              '\t\t\t\tif (!hmrPort && isLocalHost) {'
          );
        }

        const localFallbackCatchEndTarget =
          'Check out your Vite / network configuration and https://vite.dev/config/server-options.html#server-hmr .`);\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t\treturn;';
        if (updated.includes(localFallbackCatchEndTarget)) {
          updated = updated.replace(
            localFallbackCatchEndTarget,
            'Check out your Vite / network configuration and https://vite.dev/config/server-options.html#server-hmr .`);\n\t\t\t\t\t\t}\n\t\t\t\t\t\tthrow e;\n\t\t\t\t\t}\n\t\t\t\t\treturn;'
          );
        }

        const throwTarget = 'console.error(`[vite] failed to connect to websocket (${e}). `);\n\t\t\t\tthrow e;';
        if (updated.includes(throwTarget)) {
          updated = updated.replace(throwTarget, 'throw e;');
        }

        const connectedCaseTarget = '\t\tcase "connected":\n\t\t\tconsole.debug(`[vite] connected.`);\n\t\t\tbreak;';
        if (updated.includes(connectedCaseTarget)) {
          updated = updated.replace(
            connectedCaseTarget,
            '\t\tcase "connected":\n' +
              '\t\t\ttry { if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("__vite_ws_reloaded"); } catch {}\n' +
              '\t\t\tconsole.debug(`[vite] connected.`);\n' +
              '\t\t\tbreak;'
          );
        }

        const disconnectCaseTarget =
          '\t\t\tif (payload.event === "vite:ws:disconnect") {\n' +
          '\t\t\t\tif (hasDocument && !willUnload) {\n' +
          '\t\t\t\t\tconsole.log(`[vite] server connection lost. Polling for restart...`);\n' +
          '\t\t\t\t\tconst socket = payload.data.webSocket;\n' +
          '\t\t\t\t\tconst url = new URL(socket.url);\n' +
          '\t\t\t\t\turl.search = "";\n' +
          '\t\t\t\t\tawait waitForSuccessfulPing(url.href);\n' +
          '\t\t\t\t\tlocation.reload();\n' +
          '\t\t\t\t}\n' +
          '\t\t\t}';
        if (updated.includes(disconnectCaseTarget)) {
          updated = updated.replace(
            disconnectCaseTarget,
            '\t\t\tif (payload.event === "vite:ws:disconnect") {\n' +
              '\t\t\t\tif (hasDocument && !willUnload) {\n' +
              '\t\t\t\t\tconsole.debug(`[vite] websocket disconnected, attempting reconnect...`);\n' +
              '\t\t\t\t\ttry {\n' +
              '\t\t\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, 500));\n' +
              '\t\t\t\t\t\tif (willUnload) return;\n' +
              '\t\t\t\t\t\tawait transport.connect(hmrMessageHandler);\n' +
              '\t\t\t\t\t\treturn;\n' +
              '\t\t\t\t\t} catch {}\n' +
              '\t\t\t\t\tconsole.log(`[vite] server connection lost. Polling for restart...`);\n' +
              '\t\t\t\t\tconst socket = payload.data.webSocket;\n' +
              '\t\t\t\t\tconst url = new URL(socket.url);\n' +
              '\t\t\t\t\turl.search = "";\n' +
              '\t\t\t\t\tawait waitForSuccessfulPing(url.href).catch(() => {});\n' +
              '\t\t\t\t\tif (!willUnload) location.reload();\n' +
              '\t\t\t\t}\n' +
              '\t\t\t}'
          );
        }

        const sharedWorkerTarget = 'if (typeof SharedWorker === "undefined") {';
        if (updated.includes(sharedWorkerTarget)) {
          updated = updated.replace(
            sharedWorkerTarget,
            'if (typeof SharedWorker === "undefined" || window.self !== window.top) {'
          );
        }

        const connectTarget = 'transport.connect(createHMRHandler(handleMessage));';
        if (updated.includes(connectTarget)) {
          updated = updated.replace(
            connectTarget,
            'const hmrMessageHandler = createHMRHandler(handleMessage);\n' +
              '(async function connectHmrWithRetry() {\n' +
              '\tconst retryDelays = [1000, 2000, 4000, 8000];\n' +
              '\tfor (let attempt = 0; attempt <= retryDelays.length; attempt++) {\n' +
              '\t\ttry {\n' +
              '\t\t\tawait transport.connect(hmrMessageHandler);\n' +
              '\t\t\treturn;\n' +
              '\t\t} catch (err) {\n' +
              '\t\t\tif (willUnload) return;\n' +
              '\t\t\tif (attempt < retryDelays.length) {\n' +
              '\t\t\t\tconsole.debug(`[vite] websocket connection interrupted, retrying in ${retryDelays[attempt]}ms...`);\n' +
              '\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));\n' +
              '\t\t\t\tcontinue;\n' +
              '\t\t\t}\n' +
              '\t\t\tif (hasDocument) {\n' +
              '\t\t\t\tconst pingUrl = `${socketProtocol}://${socketHost}`;\n' +
              '\t\t\t\tawait waitForSuccessfulPing(pingUrl).catch(() => {});\n' +
              '\t\t\t\tif (willUnload) return;\n' +
              '\t\t\t\ttry {\n' +
              '\t\t\t\t\tawait transport.connect(hmrMessageHandler);\n' +
              '\t\t\t\t\treturn;\n' +
              '\t\t\t\t} catch (reconnectErr) {\n' +
              '\t\t\t\t\ttry {\n' +
              '\t\t\t\t\t\tif (typeof sessionStorage !== "undefined" && !sessionStorage.getItem("__vite_ws_reloaded")) {\n' +
              '\t\t\t\t\t\t\tsessionStorage.setItem("__vite_ws_reloaded", "1");\n' +
              '\t\t\t\t\t\t\tlocation.reload();\n' +
              '\t\t\t\t\t\t\treturn;\n' +
              '\t\t\t\t\t\t}\n' +
              '\t\t\t\t\t} catch {}\n' +
              '\t\t\t\t\tconsole.warn("[vite] websocket reconnect deferred:", reconnectErr);\n' +
              '\t\t\t\t}\n' +
              '\t\t\t} else {\n' +
              '\t\t\t\tconsole.warn("[vite] websocket connection unavailable:", err);\n' +
              '\t\t\t}\n' +
              '\t\t}\n' +
              '\t}\n' +
              '})().catch((err) => {\n' +
              '\tconsole.warn("[vite] websocket initialization handled error:", err);\n' +
              '});'
          );
        }

        if (updated === code) {
          return null;
        }
        return { code: updated, map: null };
      },
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), viteProxyHmrResiliencePlugin()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname || '.', '.'),
      },
    },
    server: {
      allowedHosts: true as const,
      hmr: {
        overlay: true,
      },
      watch: {
        ignored: ['**/.data/**', '**/.git/**', '**/node_modules/**', '**/dist/**'],
      },
    },
  };
});
