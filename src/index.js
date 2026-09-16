import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [/example\.com/],
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
			});
	},
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.register(fastifyStatic, {
	root: scramjetPath,
	prefix: "/scram/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: libcurlPath,
	prefix: "/libcurl/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
});

fastify.get("/ixl/*", (req, reply) => {
	const link = req.params["*"];

	let url;
	try {
		url = decodeURIComponent(link);
	} catch {
		console.warn("failed to decode url. defaulting to raw url:", link);
		url = link;
	}
	if (!/^https?:\/\//.test(url)) url = "https://" + url;

	return reply.type("text/html").send(`<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0, shrink-to-fit=yes" />
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { width: 100vw; height: 100vh; overflow: hidden; }
		#sj-frame { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }

		#loading {
			position: fixed;
			inset: 0;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			font-family: sans-serif;
			background: #000;
			color: #fff;
			gap: 1.25rem;
			z-index: 99999;
		}
		#loading.hidden {
			display: none;
		}

		#status-text {
			font-size: 1.1rem;
			letter-spacing: 0.04em;
			color: rgba(255, 255, 255, 0.85);
		}
		#status-text.error {
			color: #f87171;
			max-width: 420px;
			text-align: center;
			line-height: 1.5;
			font-size: 0.95rem;
		}
	</style>
</head>
<body>
	<div id="loading">
		<span id="status-text">getting ready...</span>
	</div>

<script src="/scram/scramjet.all.js"></script>
<script src="/baremux/index.js"></script>
<script>
    const loadingEl = document.getElementById("loading");
    const statusEl  = document.getElementById("status-text");

    function setStatus(msg, isError = false) {
        statusEl.textContent = msg;
        statusEl.className = isError ? "error" : "";
    }

    function withTimeout(promise, ms, label) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms)
            )
        ]);
    }

    async function nukeServiceWorkers() {
        try {
            if (navigator.serviceWorker) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch (e) {
            console.warn("failed to unregister sw:", e);
        }
    }

    async function nukeCaches() {
        try {
            if ("caches" in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
        } catch (e) {
            console.warn("failed to clear caches:", e);
        }
    }

    async function init() {
        try {
            if (!navigator.serviceWorker) {
                throw new Error("your browser does not support service workers.");
            }

            if (typeof $scramjetLoadController === "undefined") {
                throw new Error("proxy scripts failed to load. please refresh the page.");
            }
            const { ScramjetController } = $scramjetLoadController();
            const scramjet = new ScramjetController({
                files: {
                    wasm: "/scram/scramjet.wasm.wasm",
                    all:  "/scram/scramjet.all.js",
                    sync: "/scram/scramjet.sync.js",
                },
            });

            if (typeof BareMux === "undefined") {
                throw new Error("transport scripts failed to load. please refresh the page.");
            }
            const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

            scramjet.init();

            setStatus("clearing old service workers...");
            await Promise.race([
                Promise.all([nukeServiceWorkers(), nukeCaches()]),
                new Promise(r => setTimeout(r, 1500))
            ]);

            setStatus("registering service worker...");
            try {
                await withTimeout(navigator.serviceWorker.register("/sw.js"), 5000, "SW registration");
                await withTimeout(navigator.serviceWorker.ready, 8000, "SW ready");
            } catch (e) {
                setStatus("service worker stuck, retrying...");
                await nukeServiceWorkers();
                await nukeCaches();
                await withTimeout(navigator.serviceWorker.register("/sw.js"), 5000, "SW registration (retry)");
                await withTimeout(navigator.serviceWorker.ready, 8000, "SW ready (retry)");
            }

            const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
            if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
                await connection.setTransport("/libcurl/index.mjs", [{ websocket: wispUrl }]);
            }

            setStatus("launching proxy...");
            await new Promise(r => setTimeout(r, 100));

            const frame = scramjet.createFrame();
            frame.frame.id = "sj-frame";
            frame.frame.allowFullscreen = true;
            document.body.appendChild(frame.frame);
            loadingEl.classList.add("hidden");
            frame.go(${JSON.stringify(url)});

        } catch (err) {
            setStatus(err.message, true);
            console.error(err);
        }
    }

    setStatus("starting...");

    let initiated = false;
    function initOnce() {
        if (initiated) return;
        initiated = true;
        init();
    }

    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", initOnce); }
    else { initOnce(); }

    setTimeout(() => { if (!initiated) initOnce(); }, 500);
</script>
</body>
</html>`);
});

fastify.setNotFoundHandler((res, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();

	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${
			address.family === "IPv6" ? `[${address.address}]` : address.address
		}:${address.port}`
	);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("SIGTERM signal received: closing HTTP server");
	fastify.close();
	process.exit(0);
}

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8080;

fastify.listen({
	port: port,
	host: "0.0.0.0",
});